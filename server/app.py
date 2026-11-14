"""
╔══════════════════════════════════════════════════════════════════════════╗
║  STATELESS PROXY — NOTHING IS PERSISTED.                                 ║
║                                                                          ║
║  • No database, no files written, no caches of user data.                ║
║  • Request/response bodies are never logged (uvicorn access log is off,  ║
║    see main.py) and are dropped when the response returns.               ║
║  • NEAR AI key: from .env (in memory), OR the user's own key sent per    ║
║    request in the X-NearAI-Key header. A user key is used for that one   ║
║    upstream call and then dropped: never stored, logged, or cached.      ║
║  • The pseudonym → real-identity map NEVER reaches this server: it is    ║
║    created and kept in the user's browser.                               ║
║                                                                          ║
║  Why a server at all? (1) the track requires the API key in .env, and    ║
║  (2) Intel/NVIDIA attestation verification needs native libraries.       ║
║  Every piece of raw evidence is returned so anyone can re-verify it.     ║
╚══════════════════════════════════════════════════════════════════════════╝
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from pathlib import Path

import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from verify import BASE, fetch_signature, list_tee_models, preflight, verify_signature

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "z-ai/glm-5.3-flash"
MAX_TOKENS_CAP = 1500


def _load_api_key() -> str:
    """Read API_KEY from the repo-root .env. Held in memory only; never logged or returned.
    Optional: without it, every user must bring their own key from the browser."""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("API_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
    return ""


API_KEY = _load_api_key()


def key_for(user_key: str | None) -> str:
    """The user's own key wins (bring-your-own-key); else the server's .env key."""
    k = (user_key or "").strip()
    if k:
        if len(k) > 256 or any(c.isspace() for c in k):
            raise HTTPException(400, "malformed NEAR AI key")
        return k
    if API_KEY:
        return API_KEY
    raise HTTPException(401, "No NEAR AI key: add your own in the app (stored only in your browser) or set API_KEY in .env")
app = FastAPI(title="Need-to-Know proxy", docs_url=None, redoc_url=None)


# ───────────────────────────── /api/models ─────────────────────────────

@app.get("/api/models")
def models(x_nearai_key: str | None = Header(default=None)):
    """TEE-hosted chat models only (owned_by == 'nearai'), so the UI can't pick a proxied 3rd-party API."""
    ms = list_tee_models((x_nearai_key or "").strip() or API_KEY)
    return {
        "default": DEFAULT_MODEL if any(m["id"] == DEFAULT_MODEL for m in ms) else (ms[0]["id"] if ms else None),
        "models": [{"id": m["id"], "name": m.get("name"), "context_length": m.get("context_length"),
                    "pricing": m.get("pricing")} for m in ms],
    }


# ───────────────────────────── /api/attest ─────────────────────────────

class AttestIn(BaseModel):
    nonce: str = Field(pattern=r"^[0-9a-fA-F]{64}$", description="32 random bytes, hex — generated in the browser")
    model: str = DEFAULT_MODEL


@app.post("/api/attest")
async def attest(body: AttestIn):
    """Preflight: verify the gateway + every model enclave for the browser's fresh nonce."""
    t0 = time.time()
    try:
        out = await preflight(body.model, body.nonce.lower())
    except requests.HTTPError as e:
        raise HTTPException(502, f"attestation report unavailable: {e}") from e
    out["elapsed_ms"] = int((time.time() - t0) * 1000)
    return out


# ───────────────────────────── /api/chat ─────────────────────────────

class Msg(BaseModel):
    role: str = Field(pattern=r"^(system|user|assistant)$")
    content: str


class ChatIn(BaseModel):
    model: str = DEFAULT_MODEL
    messages: list[Msg]
    max_tokens: int = 800
    json_mode: bool = False
    # Returned by /api/attest; sent back by the browser so this server stays stateless.
    verified_signers: list[str]
    gateway_signer: str | None = None


@app.post("/api/chat")
async def chat(body: ChatIn, x_nearai_key: str | None = Header(default=None)):
    """Forward EXACT bytes to the TEE model, then verify the response signature against the preflight."""
    key = key_for(x_nearai_key)  # local variable only: gone when this request returns
    if not body.verified_signers:
        raise HTTPException(400, "run /api/attest first — no verified enclave to bind the response to")

    sent = {
        "model": body.model,
        "messages": [m.model_dump() for m in body.messages],
        "max_tokens": min(body.max_tokens, MAX_TOKENS_CAP),
        "temperature": 0,
        "stream": False,
    }
    if body.json_mode:
        sent["response_format"] = {"type": "json_object"}

    # Serialise ONCE. These exact bytes are sent, hashed, and returned to the browser.
    req_bytes = json.dumps(sent, separators=(",", ":")).encode()

    t0 = time.time()
    r = await asyncio.to_thread(
        requests.post, f"{BASE}/chat/completions", data=req_bytes, timeout=180,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "Accept-Encoding": "identity", "x-no-aliasing": "true"},
    )
    resp_bytes = r.content
    if r.status_code == 401:
        raise HTTPException(401, "NEAR AI rejected the key (invalid or expired). Check the key in the app or .env.")
    if r.status_code != 200:
        raise HTTPException(502, f"NEAR AI completion failed: HTTP {r.status_code} {r.text[:200]}")
    data = r.json()

    sig = await asyncio.to_thread(fetch_signature, key, data["id"], body.model)
    checks = verify_signature(sig, req_bytes, resp_bytes, body.model,
                              {s.lower() for s in body.verified_signers}, body.gateway_signer)

    return {
        "answer": data["choices"][0]["message"].get("content") or "",
        "chat_id": data["id"],
        "usage": data.get("usage"),
        "elapsed_ms": int((time.time() - t0) * 1000),
        # The exposure receipt: exactly what the enclave received, and the proof.
        "request_body": req_bytes.decode(),
        "request_sha256": hashlib.sha256(req_bytes).hexdigest(),
        "response_sha256": hashlib.sha256(resp_bytes).hexdigest(),
        "signature": sig,
        "verified": checks.all_ok,
        "checks": checks.rows,
    }


@app.get("/api/health")
def health():
    # server_key tells the UI whether a visitor MUST bring their own key.
    return {"ok": True, "stateless": True, "server_key": bool(API_KEY)}


# ───────────────────────── static frontend (prod) ─────────────────────────

DIST = ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        if path and re.fullmatch(r"[\w\-./]+", path) and ".." not in path and f.is_file():
            return FileResponse(f)
        return FileResponse(DIST / "index.html")

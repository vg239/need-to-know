#!/usr/bin/env python3
"""
Need-to-Know — proof of concept: one attested completion, fully verified.

Flow (preflight-first, as https://docs.near.ai/cloud/verification requires):
  1. Pick a TEE-hosted model from /v1/models (owned_by == "nearai").
  2. PREFLIGHT: fetch the attestation report with a fresh 32-byte random nonce
     and verify the gateway + every model candidate:
        - Intel TDX quote (dcap-qvl, Intel collateral)
        - nonce echoed and embedded in report_data[32:64]
        - signing address embedded in report_data[0:32]
        - MRCONFIGID == 01 || sha256(app_compose) || 00*15
        - RTMR3 == replay of the event log
        - NVIDIA GPU evidence via NRAS (model candidates only)
  3. Send ONE completion. Keep the exact request + response bytes.
  4. Fetch /v1/signature/{id}, check the signed text equals
     <model>:sha256(request):sha256(response), recover the EIP-191 signer, and
     require it to match exactly one attestation verified in step 2.

Nothing is persisted except out/receipt.json (local, gitignored): hashes and
check results only — no prompt, no response text, no key.

Run:  cd poc && uv run python verify_once.py [--model z-ai/glm-5.3-flash]
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import secrets
import struct
import sys
import time
from pathlib import Path

import dcap_qvl
import requests
from eth_account import Account
from eth_account.messages import encode_defunct

BASE = "https://cloud-api.near.ai/v1"
NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu"
SIGNING_ALGO = "ecdsa"  # pinned explicitly: endpoint defaults differ (see docs)
PREFERRED_MODELS = ["z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B", "Qwen/Qwen3.6-35B-A3B-FP8"]
ROOT = Path(__file__).resolve().parent.parent


# ───────────────────────────── helpers ─────────────────────────────

def load_api_key() -> str:
    """Read API_KEY from ../.env without printing or logging it."""
    for line in (ROOT / ".env").read_text().splitlines():
        if line.strip().startswith("API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("API_KEY not found in .env")


class Checks:
    """Collects pass/fail results for the 'Verified' panel."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, group: str, label: str, ok: bool, detail: str = "", warn: bool = False) -> bool:
        self.rows.append({"group": group, "check": label, "ok": bool(ok), "warn": warn, "detail": detail})
        mark = "⚠" if (ok and warn) else ("✓" if ok else "✗")
        print(f"   {mark} {label}" + (f"  — {detail}" if detail else ""))
        return bool(ok)

    @property
    def all_ok(self) -> bool:
        return all(r["ok"] for r in self.rows)


def as_dict(v):
    return json.loads(v) if isinstance(v, str) else (v or {})


def replay_rtmr3(event_log) -> str:
    """RTMR3 = fold(sha384(mr || digest)) over imr==3 events, starting from 48 zero bytes.

    dstack runtime events ship with an EMPTY digest; it must be recomputed as
    sha384(u32_le(event_type) || ":" || event || ":" || payload). Recomputing it
    (instead of trusting a supplied digest) also proves the human-readable event
    fields — e.g. compose-hash, app-id, os-image-hash — are what was measured.
    """
    events = json.loads(event_log) if isinstance(event_log, str) else event_log
    mr = b"\x00" * 48
    for e in events:
        if e.get("imr") != 3:
            continue
        if e.get("digest"):
            d = bytes.fromhex(e["digest"])
        else:
            d = hashlib.sha384(struct.pack("<I", e["event_type"]) + b":" + e["event"].encode()
                               + b":" + bytes.fromhex(e.get("event_payload", ""))).digest()
        mr = hashlib.sha384(mr + d).digest()
    return mr.hex()


def jwt_claims(token: str) -> dict:
    p = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


# ─────────────────────── attestation verification ───────────────────────

async def verify_report(att: dict, nonce: str, group: str, checks: Checks, gpu: bool) -> bool:
    print(f"\n▶ {group}  signer={att.get('signing_address')}")
    ok = True

    # 1. Intel TDX quote — cryptographic verification against Intel collateral
    try:
        res = await dcap_qvl.get_collateral_and_verify(bytes.fromhex(att["intel_quote"]))
        rj = json.loads(res.to_json())
        td = rj["report"].get("TD10") or rj["report"].get("TD15") or {}
        status = res.status
        ok &= checks.add(group, "Intel TDX quote signature & TCB", status in ("UpToDate", "OutOfDate"),
                         f"status={status}", warn=(status != "UpToDate"))
    except Exception as e:  # noqa: BLE001
        checks.add(group, "Intel TDX quote signature & TCB", False, str(e)[:120])
        return False

    # Read bindings from the VERIFIED quote, never from the HTTP echo.
    rd = bytes.fromhex(td["report_data"].removeprefix("0x"))

    # 2. Freshness: our nonce is echoed and embedded by the hardware
    ok &= checks.add(group, "Nonce echoed (request_nonce)", att.get("request_nonce", "").lower() == nonce)
    ok &= checks.add(group, "Nonce bound in quote report_data[32:64]", rd[32:64].hex() == nonce)

    # 3. Signing identity bound in report_data[0:32] (20-byte address, zero-padded)
    addr = bytes.fromhex(att["signing_address"].removeprefix("0x"))
    ok &= checks.add(group, "Signing address bound in report_data[0:32]",
                     att.get("signing_algo") == SIGNING_ALGO and rd[:32] == addr.ljust(32, b"\x00"))

    # 4. Exactly which software runs: MRCONFIGID commits to the docker compose
    tcb = as_dict(as_dict(att.get("info")).get("tcb_info"))
    app_compose = tcb.get("app_compose", "")
    expected_cfg = "01" + hashlib.sha256(app_compose.encode()).hexdigest() + "00" * 15
    ok &= checks.add(group, "MRCONFIGID == sha256(app_compose)",
                     bool(app_compose) and td.get("mr_config_id", "").lower() == expected_cfg)

    # 5. Runtime measurements: replay the event log into RTMR3
    ev = att.get("event_log") or tcb.get("event_log")
    replayed = replay_rtmr3(ev) if ev else ""
    ok &= checks.add(group, "RTMR3 == event-log replay", bool(replayed) and replayed == td.get("rt_mr3", "").lower())

    # 6. GPU: NVIDIA confidential-computing evidence, same nonce, verified by NRAS
    if gpu:
        payload = json.loads(att["nvidia_payload"])
        ok &= checks.add(group, "GPU evidence uses our nonce", payload.get("nonce", "").lower() == nonce)
        try:
            body = requests.post(NRAS_URL, json=payload, timeout=60).json()
            verdict = jwt_claims(body[0][1]).get("x-nvidia-overall-att-result")
            ok &= checks.add(group, "NVIDIA NRAS GPU attestation", verdict is True, f"verdict={verdict}")
        except Exception as e:  # noqa: BLE001
            ok &= checks.add(group, "NVIDIA NRAS GPU attestation", False, str(e)[:120])
    return ok


# ───────────────────────────── main flow ─────────────────────────────

async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model")
    args = ap.parse_args()
    key = load_api_key()
    auth = {"Authorization": f"Bearer {key}"}
    checks = Checks()

    # Step 1 — choose a TEE-hosted model (NEAR-operated, not a proxied 3rd-party API)
    models = requests.get(f"{BASE}/models", headers=auth, timeout=30).json()["data"]
    tee = {m["id"] for m in models if m.get("owned_by") == "nearai"}
    model = args.model or next(m for m in PREFERRED_MODELS if m in tee)
    print(f"Models listed: {len(models)}  |  NEAR-hosted TEE models: {len(tee)}  |  using: {model}")

    # Step 2 — PREFLIGHT attestation with a fresh nonce
    nonce = secrets.token_hex(32)
    print(f"Fresh nonce: {nonce}")
    report = requests.get(
        f"{BASE}/attestation/report",
        params={"model": model, "provider": "near", "signing_algo": SIGNING_ALGO, "nonce": nonce},
        headers={"Accept": "application/json", "x-no-aliasing": "true"},
        timeout=60,
    ).json()

    await verify_report(report["gateway_attestation"], nonce, "gateway", checks, gpu=False)
    candidates = report.get("model_attestations") or []
    checks.add("model", "model_attestations[] present", bool(candidates), f"{len(candidates)} candidates")
    verified_signers = set()
    for i, att in enumerate(candidates):
        if await verify_report(att, nonce, f"model[{i}]", checks, gpu=True):
            verified_signers.add(att["signing_address"].lower())
    verified_signers_gw = {report["gateway_attestation"]["signing_address"].lower()}

    # Step 3 — ONE completion; keep exact bytes (the payload is what an attacker would see)
    sent = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Answer only from the excerpt. Keep placeholders like PERSON_1 unchanged."},
            {"role": "user", "content": (
                "Excerpt [§4.2 Post-operative care]: PERSON_1 was discharged on DATE_1 and prescribed "
                "amoxicillin 500mg three times daily for 7 days. [§1.4 Allergies]: PERSON_1 reports no known "
                "drug allergies.\n\nQuestion: What was PERSON_1 prescribed after surgery, and for how long?"
            )},
        ],
        "max_tokens": 400,
        "temperature": 0,
        "stream": False,
    }
    req_bytes = json.dumps(sent, separators=(",", ":")).encode()
    print("\n▶ completion")
    t0 = time.time()
    r = requests.post(
        f"{BASE}/chat/completions",
        data=req_bytes,
        headers={**auth, "Content-Type": "application/json", "Accept-Encoding": "identity", "x-no-aliasing": "true"},
        timeout=120,
    )
    resp_bytes = r.content
    if r.status_code != 200:
        print(f"   ✗ completion rejected: HTTP {r.status_code} {r.text[:200]}")
        print(f"\n  Attestation preflight: {'PASSED' if checks.all_ok else 'FAILED'}"
              f" ({sum(x['ok'] for x in checks.rows)}/{len(checks.rows)}). Completion NOT sent/verified.")
        sys.exit(1)
    body = r.json()
    answer = body["choices"][0]["message"].get("content") or ""
    print(f"   answer ({time.time() - t0:.1f}s): {answer.strip()[:300]}")
    print(f"   usage: {body.get('usage')}")

    # Step 4 — response signature, bound to a PREFLIGHT-verified signer
    print("\n▶ response signature")
    sig = None
    for _ in range(8):  # docs: a 404 may be retried for a short, bounded time
        s = requests.get(f"{BASE}/signature/{body['id']}", params={"model": model, "signing_algo": SIGNING_ALGO},
                         headers={**auth, "Accept": "application/json"}, timeout=30)
        if s.status_code == 200 and "signature" in s.json():
            sig = s.json()
            break
        time.sleep(1)
    if not sig:
        checks.add("signature", "Signature available", False, f"HTTP {s.status_code}: {s.text[:120]}")
    else:
        req_h, resp_h = hashlib.sha256(req_bytes).hexdigest(), hashlib.sha256(resp_bytes).hexdigest()
        kind = sig.get("signature_kind")
        expected = f"{model}:{req_h}:{resp_h}" if kind == "provider_tee" else f"{req_h}:{resp_h}"
        checks.add("signature", "signature_kind recognised", kind in ("provider_tee", "gateway"), str(kind))
        checks.add("signature", "Signed text == sha256(request):sha256(response)", sig["text"] == expected)
        recovered = Account.recover_message(encode_defunct(text=sig["text"]), signature=sig["signature"])
        checks.add("signature", "EIP-191 signature recovers signing_address",
                   recovered.lower() == sig["signing_address"].lower(), recovered)
        pool = verified_signers if kind == "provider_tee" else verified_signers_gw
        checks.add("signature", "Signer matches a preflight-verified attestation",
                   sig["signing_address"].lower() in pool and sig.get("signing_algo", SIGNING_ALGO) == SIGNING_ALGO)

    # Verified panel (terminal edition)
    print("\n" + "═" * 64)
    print(f"  VERIFIED: {'YES' if checks.all_ok else 'NO'}   ({sum(r['ok'] for r in checks.rows)}/{len(checks.rows)} checks)")
    print("═" * 64)

    out = ROOT / "out"
    out.mkdir(exist_ok=True)
    (out / "receipt.json").write_text(json.dumps({
        "model": model, "nonce": nonce, "chat_id": body["id"],
        "request_sha256": hashlib.sha256(req_bytes).hexdigest(), "request_bytes": len(req_bytes),
        "signature": sig, "verified": checks.all_ok, "checks": checks.rows,
    }, indent=1))
    print(f"receipt → {out / 'receipt.json'}  (hashes + checks only)")


if __name__ == "__main__":
    asyncio.run(main())

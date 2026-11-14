"""
NEAR AI Cloud verification — attestation (preflight) + response signatures.

Extracted from poc/verify_once.py, where every check was proven against the
live API (35/35). Follows https://docs.near.ai/cloud/verification:

  Preflight, BEFORE any completion (fresh 32-byte nonce from the client):
    gateway + every model candidate:
      - Intel TDX quote verified with dcap-qvl against Intel collateral
      - request_nonce echoed, nonce bound in quote report_data[32:64]
      - signing address bound in quote report_data[0:32]
      - MRCONFIGID == 01 || sha256(app_compose) || 00*15
      - RTMR3 == replay of the event log
    model candidates only:
      - NVIDIA GPU evidence carries our nonce, NRAS verdict == true

  After the completion:
      - signed text == <model>:sha256(request bytes):sha256(response bytes)
      - EIP-191 signature recovers signing_address
      - signer is one of the PREFLIGHT-verified enclaves

Pure functions + network calls only. Nothing here writes to disk.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import struct

import dcap_qvl
import requests
from eth_account import Account
from eth_account.messages import encode_defunct

BASE = "https://cloud-api.near.ai/v1"
NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu"
SIGNING_ALGO = "ecdsa"  # pinned explicitly: endpoint defaults differ (see docs)


class Checks:
    """Collects pass/fail rows for the 'Verified' panel."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, group: str, label: str, ok: bool, detail: str = "", warn: bool = False) -> bool:
        self.rows.append({"group": group, "check": label, "ok": bool(ok), "warn": warn, "detail": detail})
        return bool(ok)

    def extend(self, other: "Checks") -> None:
        self.rows.extend(other.rows)

    @property
    def all_ok(self) -> bool:
        return bool(self.rows) and all(r["ok"] for r in self.rows)


def as_dict(v):
    return json.loads(v) if isinstance(v, str) else (v or {})


def jwt_claims(token: str) -> dict:
    p = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


def replay_rtmr3(event_log) -> str:
    """RTMR3 = fold(sha384(mr || digest)) over imr==3 events, from 48 zero bytes.

    dstack runtime events ship with an EMPTY digest; it is recomputed as
    sha384(u32_le(event_type) || ":" || event || ":" || payload), which also
    proves the readable fields (compose-hash, app-id, ...) are what was measured.
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


# ─────────────────────────── network helpers ───────────────────────────

def list_tee_models(api_key: str) -> list[dict]:
    """Models hosted by NEAR AI inside TEEs (owned_by == 'nearai'), chat-capable only."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}  # /models is public
    data = requests.get(f"{BASE}/models", headers=headers, timeout=30).json()["data"]
    skip = ("embedding", "reranker", "whisper", "flux", "privacy-filter")
    return [m for m in data if m.get("owned_by") == "nearai" and not any(s in m["id"].lower() for s in skip)]


def fetch_report(model: str, nonce: str) -> dict:
    r = requests.get(
        f"{BASE}/attestation/report",
        params={"model": model, "provider": "near", "signing_algo": SIGNING_ALGO, "nonce": nonce},
        headers={"Accept": "application/json", "x-no-aliasing": "true"},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def _nras(payload: dict) -> object:
    body = requests.post(NRAS_URL, json=payload, timeout=60).json()
    return jwt_claims(body[0][1]).get("x-nvidia-overall-att-result")


# ─────────────────────────── attestation ───────────────────────────

async def verify_report(att: dict, nonce: str, group: str, gpu: bool) -> tuple[bool, Checks, dict]:
    """Verify one attestation (gateway or model candidate). Returns (ok, checks, evidence summary)."""
    c = Checks()
    tcb = as_dict(as_dict(att.get("info")).get("tcb_info"))
    evidence = {
        "group": group,
        "signing_address": att.get("signing_address"),
        "app_name": as_dict(att.get("info")).get("app_name"),
        "compose_hash": tcb.get("compose_hash"),
        "mrtd": tcb.get("mrtd"),
    }

    # 1. Intel TDX quote — cryptographic verification against Intel collateral
    try:
        res = await dcap_qvl.get_collateral_and_verify(bytes.fromhex(att["intel_quote"]))
        rj = json.loads(res.to_json())
        td = rj["report"].get("TD10") or rj["report"].get("TD15") or {}
        status = res.status
        c.add(group, "Intel TDX quote signature & TCB", status in ("UpToDate", "OutOfDate"),
              f"status={status}", warn=(status != "UpToDate"))
    except Exception as e:  # noqa: BLE001
        c.add(group, "Intel TDX quote signature & TCB", False, str(e)[:160])
        return False, c, evidence

    # Bindings are read from the VERIFIED quote, never from the HTTP echo.
    rd = bytes.fromhex(td["report_data"].removeprefix("0x"))

    # 2. Freshness — our nonce, embedded by the hardware
    c.add(group, "Nonce echoed by the API", att.get("request_nonce", "").lower() == nonce)
    c.add(group, "Nonce bound in quote report_data[32:64]", rd[32:64].hex() == nonce)

    # 3. Signing identity bound in report_data[0:32] (20-byte address, zero-padded)
    addr = bytes.fromhex(att["signing_address"].removeprefix("0x"))
    c.add(group, "Signing address bound in report_data[0:32]",
          att.get("signing_algo") == SIGNING_ALGO and rd[:32] == addr.ljust(32, b"\x00"))

    # 4. Which software runs: MRCONFIGID commits to the docker compose
    app_compose = tcb.get("app_compose", "")
    expected_cfg = "01" + hashlib.sha256(app_compose.encode()).hexdigest() + "00" * 15
    c.add(group, "MRCONFIGID == sha256(app_compose)",
          bool(app_compose) and td.get("mr_config_id", "").lower() == expected_cfg)

    # 5. Runtime measurements: replay the event log into RTMR3
    ev = att.get("event_log") or tcb.get("event_log")
    replayed = replay_rtmr3(ev) if ev else ""
    c.add(group, "RTMR3 == event-log replay", bool(replayed) and replayed == td.get("rt_mr3", "").lower())

    # 6. GPU: NVIDIA confidential-computing evidence, same nonce, verified by NRAS
    if gpu:
        payload = json.loads(att["nvidia_payload"])
        c.add(group, "GPU evidence carries our nonce", payload.get("nonce", "").lower() == nonce)
        try:
            verdict = await asyncio.to_thread(_nras, payload)
            c.add(group, "NVIDIA NRAS GPU attestation", verdict is True, f"verdict={verdict}")
        except Exception as e:  # noqa: BLE001
            c.add(group, "NVIDIA NRAS GPU attestation", False, str(e)[:160])

    return c.all_ok, c, evidence


async def preflight(model: str, nonce: str) -> dict:
    """Fetch + verify gateway and all model candidates for a client-supplied nonce."""
    report = await asyncio.to_thread(fetch_report, model, nonce)
    gw = report["gateway_attestation"]
    candidates = report.get("model_attestations") or []

    jobs = [verify_report(gw, nonce, "Gateway", gpu=False)]
    jobs += [verify_report(a, nonce, f"Model enclave {i + 1}", gpu=True) for i, a in enumerate(candidates)]
    results = await asyncio.gather(*jobs)

    checks = Checks()
    checks.add("Model", "Model attestations present", bool(candidates), f"{len(candidates)} enclave(s)")
    for _, c, _ in results:
        checks.extend(c)

    verified_signers = sorted({ev["signing_address"].lower() for ok, _, ev in results[1:] if ok})
    return {
        "nonce": nonce,
        "model": model,
        "verified": checks.all_ok,
        "verified_signers": verified_signers,
        "gateway_signer": gw["signing_address"].lower() if results[0][0] else None,
        "checks": checks.rows,
        "evidence": [ev for _, _, ev in results],
    }


# ─────────────────────────── response signature ───────────────────────────

def fetch_signature(api_key: str, chat_id: str, model: str, tries: int = 8) -> dict | None:
    import time

    for _ in range(tries):  # docs: a 404 may be retried for a short, bounded time
        s = requests.get(f"{BASE}/signature/{chat_id}", params={"model": model, "signing_algo": SIGNING_ALGO},
                         headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"}, timeout=30)
        if s.status_code == 200 and "signature" in s.json():
            return s.json()
        time.sleep(1)
    return None


def verify_signature(sig: dict | None, req_bytes: bytes, resp_bytes: bytes, model: str,
                     verified_signers: set[str], gateway_signer: str | None) -> Checks:
    c = Checks()
    g = "Signature"
    if not sig:
        c.add(g, "Signature available", False, "no signature returned")
        return c
    req_h, resp_h = hashlib.sha256(req_bytes).hexdigest(), hashlib.sha256(resp_bytes).hexdigest()
    kind = sig.get("signature_kind")
    expected = f"{model}:{req_h}:{resp_h}" if kind == "provider_tee" else f"{req_h}:{resp_h}"
    c.add(g, "Signature kind recognised", kind in ("provider_tee", "gateway"), str(kind))
    c.add(g, "Signed text == sha256(request) : sha256(response)", sig.get("text") == expected)
    try:
        recovered = Account.recover_message(encode_defunct(text=sig["text"]), signature=sig["signature"])
        c.add(g, "EIP-191 signature recovers the signer", recovered.lower() == sig["signing_address"].lower(),
              recovered)
    except Exception as e:  # noqa: BLE001
        c.add(g, "EIP-191 signature recovers the signer", False, str(e)[:160])
    pool = verified_signers if kind == "provider_tee" else {gateway_signer} - {None}
    c.add(g, "Signer is a preflight-verified enclave",
          sig.get("signing_address", "").lower() in pool and sig.get("signing_algo", SIGNING_ALGO) == SIGNING_ALGO)
    return c

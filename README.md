# Need-to-Know

**Ask AI about a confidential document, and send it only what it needs.**

> The TEE proves *where* your document was processed. Need-to-Know proves *how little* of it was sent.

Built for the NEAR Hackathon, **Privacy & Private AI** track. Inference runs on **NEAR AI Cloud** inside Intel TDX + NVIDIA confidential-computing enclaves. Every question is preceded by a fresh-nonce attestation, and every answer is bound to a verified enclave by its signature.

---

## The problem

A TEE protects data *while it is processed*. It does nothing about *how much* data you hand over. Confidential-AI apps still paste entire medical records, contracts and bank statements into the model, even when the answer is in one paragraph. If enclave software is ever compromised, everything that was sent is exposed.

This is not hypothetical. On **9 November 2026**, NEAR AI paused cloud inference after an attacker exploited a remote-code-execution flaw in **SGLang**, the open-source inference engine running on its servers. Reports put the exposure at roughly 100 users. NEAR AI's own explanation draws the line clearly: confidential computing protects data from the *operator and host*, not from a vulnerability in the *software running inside* the enclave. Service was restored around 10 November after the fix and a credential rotation. ([Crypto Briefing](https://cryptobriefing.com/near-ai-pauses-cloud-inference-unauthorized-access/), [Let's Data Science](https://letsdatascience.com/news/sglang-flaw-lets-attacker-breach-near-ai-inference-servers-fa6fb270), [Glitchwire](https://glitchwire.com/news/near-ai-halts-cloud-inference-after-unauthorized-access-to-internal-systems/))

**Need-to-Know assumes the enclave can be breached and keeps the blast radius small.** It also measures that blast radius and proves it. Had a session like this been in flight during such an incident, the attacker would have seen the Breach Replay payload: a few pseudonymised sections, with no names, IDs or real dates.

## What it does

1. **Splits the document into sections locally.** No model call is used to build the table of contents.
2. **Picks only the sections the question needs.** It uses fully local BM25 first. For vague questions such as "audit my spending" it falls back to sending only the *pseudonymised headings* to the TEE so the model can choose sections.
3. **Pseudonymises in the browser.** Names, IDs, phones, emails, addresses and account numbers become consistent codes (`Maria Lopez → PERSON_1`). Dates and month names shift by a secret number of whole months, and a date of birth is generalised to its decade. The code-to-identity map never leaves the tab.
4. **Applies an exposure budget.** A slider caps the share of the document that may leave. If relevant sections were cut, the app says which ones and lets you allow more.
5. **Attests before sending.** The browser generates a 32-byte nonce, and the proxy verifies the gateway and every GPU enclave quote (below) before any document content moves.
6. **Restores identities locally.** The enclave answers in codes (`PERSON_1 was prescribed…`), and the browser swaps the real values back in.
7. **Proves what left:**
   - **Exposure Meter:** share of the document and number of real identifiers sent, compared with pasting the whole document and with a typical chunk RAG.
   - **Breach Replay:** the attacker's copy. A redaction map of each approach plus the **exact request bytes**.
   - **Exposure receipt:** the enclave signs `model:sha256(request):sha256(response)`. Your browser re-hashes the replayed bytes with WebCrypto and checks they are what the attested enclave signed.

## Benchmark: does privacy cost accuracy?

20 questions over 3 fictional documents, run through the same pipeline code as the app (`web/bench/run_bench.ts`) against the live TEE model `z-ai/glm-5.3-flash`. Scoring is deterministic: the answer must contain an expected keyword.

<!-- BENCH_TABLE -->
| Mode | Share of doc sent | Correct | Real identifiers sent (avg) |
|---|---|---|---|
| Whole document (raw) | 100.0% | 20/20 | 21.5 |
| Typical RAG (raw 250-token chunks, top-4) | 69.3% | 20/20 | 15.3 |
| Need-to-Know, local routing, 5% budget | 5.0% | 18/20 | **0** |
| **Need-to-Know, local routing, 10% budget** | **8.0%** | **20/20** | **0** |
| Need-to-Know, local routing, 20% budget | 15.9% | 20/20 | 0 |
| Need-to-Know, heading routing, 12% budget | 14.4% | 17/20 | 0 |
<!-- /BENCH_TABLE -->

**Same accuracy as pasting the whole document, with about 12× less data and no real identifiers.** Every response in the run was signature-verified against a preflight-attested enclave. Fully local routing also beat heading routing on these questions, so local routing is the default.

## What is verified ("Verified" panel)

All checks follow the [NEAR AI Cloud verification docs](https://docs.near.ai/cloud/verification). They run **before** the completion, with a nonce generated in the browser.

| Evidence | Check |
|---|---|
| Gateway + each model enclave | Intel TDX quote verified against Intel collateral (`dcap-qvl`), TCB status |
| | `request_nonce` echoed **and** nonce bound in the verified quote `report_data[32:64]` |
| | signing address bound in `report_data[0:32]` |
| | `MRCONFIGID == 01 ‖ sha256(app_compose) ‖ 0…` (the exact docker compose that runs) |
| | `RTMR3` equals a replay of the event log (digests recomputed from event fields) |
| Model enclaves (GPU) | NVIDIA evidence carries our nonce, NVIDIA NRAS verdict `true` |
| Each response | signature kind `provider_tee`; signed text == `model:sha256(exact request bytes):sha256(exact response bytes)` |
| | EIP-191 signature recovers the signing address |
| | signer is one of the enclaves verified in the preflight (a report fetched *after* the completion is never accepted) |

Only models with `owned_by: "nearai"` are offered. These are hosted by NEAR AI in TEEs, not proxied third-party APIs.

## What the server keeps: nothing

`server/app.py` is a **stateless proxy**, and the file opens with a banner saying so.

- No database, no files written, no caches of user data. `grep` it: there are no `open(` / `write` calls.
- The uvicorn access log is **off** (`server/main.py`). Request and response bodies are never logged and are dropped when the response returns.
- The only secret is the NEAR AI API key, read from `.env` into memory.
- The pseudonym-to-identity map is created and kept **in the browser** and never reaches the server.
- The verified-signer list returned by `/api/attest` is sent back by the browser with each `/api/chat` call, so the server never has to remember a session.

Why have a server at all? The track requires the key in `.env`, and Intel/NVIDIA quote verification needs native libraries. Every check result is returned to the browser, and the request bytes can be re-hashed there.

## Quick start

Requirements: Python 3.12 + [uv](https://docs.astral.sh/uv/), Node 20+, a NEAR AI Cloud API key.

```bash
cp .env.example .env                  # put your key in API_KEY=

# 1. minimal script: one completion + full attestation verification
cd poc && uv run python verify_once.py

# 2. stateless proxy (port 8000)
cd ../server && uv run python main.py

# 3. web app (port 5173, proxies /api to :8000)
cd ../web && npm install && npm run dev
```

Open http://localhost:5173, pick a sample document and click a preset question. **All sample documents are fictional** (`web/public/samples/`), so no real data is needed. To serve the built app from the proxy instead: `cd web && npm run build`, then the proxy serves `web/dist` at http://localhost:8000.

Re-run the benchmark (proxy must be running): `cd web && npm run bench`.

### `poc/verify_once.py` output

```
Models listed: 64  |  NEAR-hosted TEE models: 12  |  using: z-ai/glm-5.3-flash
Fresh nonce: 8025739401f6…
▶ gateway   ✓ Intel TDX quote (UpToDate) ✓ nonce bound ✓ signer bound ✓ MRCONFIGID ✓ RTMR3 replay
▶ model ×3  ✓ same five checks  ✓ GPU evidence uses our nonce  ✓ NVIDIA NRAS verdict=True
▶ completion  "PERSON_1 was prescribed amoxicillin 500mg, three times daily for 7 days."
▶ response signature
   ✓ signature_kind recognised — provider_tee
   ✓ Signed text == sha256(request):sha256(response)
   ✓ EIP-191 signature recovers signing_address
   ✓ Signer matches a preflight-verified attestation
════════════════════════════════════════
  VERIFIED: YES   (35/35 checks)
════════════════════════════════════════
```

## Architecture

```
 BROWSER (trusted)                         STATELESS PROXY (FastAPI)            NEAR AI CLOUD (TEE)
 ───────────────────────────────           ─────────────────────────            ───────────────────
 sectionize → route → pseudonymise         /api/attest  → verify quote/GPU ──►  /v1/attestation/report
 budget → build payload                    /api/chat    → exact bytes     ──►  /v1/chat/completions
 restore names · exposure · replay  ◄────  /api/models  → TEE models only ──►  /v1/signature/{id}
 identity map NEVER leaves                  key from .env · writes nothing
```

| Path | What it is |
|---|---|
| `poc/verify_once.py` | Minimal, self-contained script: one completion plus full verification |
| `server/verify.py` | Attestation and signature verification (TDX, nonce, signer, MRCONFIGID, RTMR3, NRAS, EIP-191) |
| `server/app.py` | Stateless proxy: `/api/models`, `/api/attest`, `/api/chat` |
| `web/src/lib/sectionize.ts` | Local section tree (no model) |
| `web/src/lib/pii.ts` | Local PII detection, consistent pseudonyms, month-level date shifting, restoration |
| `web/src/lib/retrieval.ts` | BM25 routing, heading-routing prompt, typical-RAG baseline |
| `web/src/lib/plan.ts` | Exposure budget and minimal prompt |
| `web/src/lib/exposure.ts` | Exposure accounting for the three approaches, measured on the real request bytes |
| `web/bench/run_bench.ts` | Accuracy-vs-exposure benchmark |

## Threat model and honest limits

- **In scope:** a compromised or curious inference enclave, operator or log pipeline. They see only the minimal, pseudonymised excerpt, which is the Breach Replay view.
- **Same operator:** NEAR AI runs all the enclaves. Splitting a request across *independent* operators is future work.
- **Verification location:** quote verification runs in our proxy because it needs native libraries. Request hashing and the comparison with the signature run in the browser. Moving the full verifier to WASM in the browser is future work.
- **Detector recall:** PII detection uses regex, labelled fields and a name list, so it can miss unusual identifiers. The Exposure Meter scans the *actual bytes* sent, but only for identifiers the detector found.
- **Content can still identify:** pseudonymisation hides identities, not facts. A rare diagnosis combined with a shifted date could still narrow down a person. Minimisation keeps that combined exposure small, and the budget makes it a choice the user sees.
- **Signature guarantees:** per NEAR's docs, a `provider_tee` signature proves the response came from a model enclave holding that key. Instances of the same model share a key.

## Data

All documents in `web/public/samples/` are **fictional**, generated for this demo. Every person, number, address and merchant is invented.

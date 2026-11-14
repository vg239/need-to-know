# Need-to-Know

**Ask AI about a confidential document, and send it only what it needs.**

> The TEE proves *where* your document was processed. Need-to-Know proves *how little* of it was sent.

| | |
|---|---|
| **Hackathon** | NEAR Hackathon 2026, **Privacy & Private AI** track |
| **Demo video** | *(add link)* |
| **Built on** | NEAR AI Cloud (TEE inference + attestation), NEAR wallet (NEP-413), NEAR RPC |

## The problem

On 9 November 2026 NEAR AI paused inference after an RCE in SGLang, the engine running *inside* its enclaves ([report](https://cryptobriefing.com/near-ai-pauses-cloud-inference-unauthorized-access/)). A TEE protects data from the operator, not from a bug inside it, and AI tools still send far more of a document than a question needs.

## The solution

Need-to-Know assumes the enclave can be breached and keeps what is there to steal **small, coded and provable**. Your browser picks only the sections a question needs, replaces names and IDs with codes, and sends that sliver to a NEAR AI TEE that is attested with a fresh nonce first. The enclave signs the exact bytes it received, so you can see and prove what left: about **9% of the document and 0 real identifiers**, with the same accuracy as sending everything.

## Track requirements

| Requirement | Where |
|---|---|
| NEAR AI Cloud, OpenAI-compatible API, key in `.env` | `server/app.py` (users can also bring their own key) |
| TEE model | `z-ai/glm-5.3-flash`; only `owned_by: "nearai"` models are offered |
| Attestation with a fresh nonce, shown in the UI | `server/verify.py`: 35 checks (Intel TDX, NVIDIA, nonce, signer, compose hash, RTMR3, response signature), shown in the **Verified** panel |
| Nothing kept server-side | `server/app.py` is a stateless proxy: no database, no files, no logs |
| Sample data | Three fictional documents in `web/public/samples/` |
| Minimal script | `poc/verify_once.py`: one attested, verified completion |

---

## User flow

1. **Pick a document:** a fictional sample, or your own PDF / Markdown / text. It is indexed in the browser; nothing is uploaded.
2. **Optional:** connect a NEAR wallet (Meteor or NEAR Mobile) and unlock your encrypted vault with one signature.
3. **Ask.** The enclave is verified first, then only the relevant, coded sections are sent. Names come back restored.
4. **See the proof:** what the enclave saw, the Exposure Meter, 35/35 checks, and **Breach Replay** with the exact bytes and their hash inside the enclave's signature.
5. **Optional:** co-sign the receipt with your wallet. Come back later and your documents and Q&A are still in your vault.

## Architecture

![Need-to-Know architecture](docs/architecture.svg)

## How it works

| Step | Code | What happens |
|---|---|---|
| Index locally | `web/src/lib/pdf.ts`, `sectionize.ts` | Sections from the PDF outline, else typography, else pages. No model, no network. |
| Pseudonymise | `pii.ts` | Names, IDs, phones, emails, addresses become codes (`Maria Lopez` → `PERSON_1`). Dates shift by a secret offset. The map stays in the browser. |
| Pick sections | `retrieval.ts`, `plan.ts` | Local BM25 under an exposure budget (default 10%). Cut sections are named, with one-click re-ask. |
| Verify first | `server/verify.py` | Fresh browser nonce; full Intel TDX + NVIDIA verification. If anything fails, nothing is sent. |
| Exact bytes | `server/app.py` | The request is serialised once; the enclave signs `sha256(request)` and `sha256(response)`; the browser re-hashes and matches. |
| Wallet + vault | `near.ts`, `vault.ts`, `receipt.ts` | NEP-413 signatures verified locally and on-chain. One signature derives an AES-256-GCM key for a vault stored only in this browser. Receipts hold hashes only. |

**Benchmark** (20 questions, live TEE model, `npm run bench`):

| Mode | Sent | Correct | Real identifiers |
|---|---|---|---|
| Whole document | 100% | 20/20 | 21.5 |
| Typical RAG | 69.3% | 20/20 | 15.3 |
| **Need-to-Know** | **8.0%** | **20/20** | **0** |

---

## Run it

Python 3.12 + [uv](https://docs.astral.sh/uv/), Node 20+, a NEAR AI Cloud key ([cloud.near.ai](https://cloud.near.ai)).

```bash
cp .env.example .env                        # API_KEY=... (or paste your own key in the app)
cd poc && uv run python verify_once.py      # VERIFIED: YES (35/35 checks)
cd ../server && uv run python main.py       # proxy on :8000
cd ../web && npm install && npm run dev     # app on http://localhost:5173
```

## End-to-end test flow

Run `poc/verify_once.py` and it ends with `VERIFIED: YES (35/35 checks)`. Open the app, pick the **Medical record** and click the preset "What was the patient prescribed after surgery, and for how long?": the answer (ciprofloxacin, 5 days) arrives with about 9% of the document sent, 0 real identifiers and 35/35 checks, and **Breach replay** shows the exact request contains `PERSON_1`, never the patient's name, with its hash found inside the enclave's signature. Upload a real PDF such as [arXiv 1706.03762](https://arxiv.org/pdf/1706.03762v7) to see the table of contents built from its outline and an answer that sends none of the authors' names. Then connect Meteor, unlock the vault, save the document, ask, co-sign the receipt, and reload: the same signature reopens the vault with your earlier Q&A. This whole flow was run on mainnet with a real wallet and the live TEE model.

## Limits

- NEAR AI runs every enclave; splitting across operators is future work.
- PII detection is rule-based and can miss unusual identifiers; keyword routing can pick the wrong section (re-ask is offered).
- Pseudonymisation hides identities, not facts.

## Disclosures

Coding was done using [Claude Code](https://claude.com/claude-code).

## Contributors

- **Vatsal** ([@vg239](https://github.com/vg239)): idea, direction, review and testing
- **Claude** ([Claude Code](https://claude.com/claude-code) by Anthropic): coding

## License

[MIT](LICENSE). All bundled sample documents are fictional.

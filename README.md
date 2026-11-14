# Need-to-Know

**Ask AI about a confidential document, and send it only what it needs.**

> The TEE proves *where* your document was processed. Need-to-Know proves *how little* of it was sent.

Need-to-Know is a private document Q&A app built on **NEAR AI Cloud**. Inference runs inside Intel TDX + NVIDIA confidential-computing enclaves, and every question starts with a fresh-nonce attestation, so nothing is sent until the enclave is verified. Documents are indexed, minimised and pseudonymised in your browser: the model receives only the few sections a question needs, with names and IDs replaced by codes, and the answer is restored locally. The enclave signs the exact bytes it received, so you can see and prove what left your machine. A NEAR wallet co-signs these exposure receipts and unlocks an encrypted vault for your documents that never leaves your browser.

**Why it matters:** on 9 November 2026 NEAR AI paused inference after an RCE in SGLang, the engine running *inside* its enclaves ([report](https://cryptobriefing.com/near-ai-pauses-cloud-inference-unauthorized-access/)). A TEE protects data from the operator and host, but not from a bug in the software running inside it, and AI tools usually send far more of a document than a question needs. Need-to-Know assumes the enclave can be breached and keeps what is there to steal **small, coded and provable**: about 8% of the document and zero real identifiers, with the same accuracy as sending everything.

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

```mermaid
sequenceDiagram
    autonumber
    participant U as Browser
    participant P as Stateless proxy
    participant N as NEAR AI TEE
    U->>U: index document, detect names and IDs
    U->>P: /api/attest {fresh nonce}
    P->>N: attestation report (gateway + GPU enclaves)
    P-->>U: checks + verified signers (stop if any fail)
    U->>U: pick sections, apply budget, pseudonymise
    U->>P: /api/chat {minimal excerpt}
    P->>N: exact request bytes
    N-->>P: answer + signature over sha256(request), sha256(response)
    P-->>U: answer, exact bytes, signature, checks
    U->>U: re-hash bytes, restore names
```

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

With the proxy and app running ([Run it](#run-it)):

1. **Attestation script.** Run `cd poc && uv run python verify_once.py`.
   Expect `VERIFIED: YES (35/35 checks)`.
2. **Ask about a sample.** Open http://localhost:5173, pick **Medical record**, click *"What was the patient prescribed after surgery, and for how long?"*.
   Expect ciprofloxacin 500 mg twice daily for 5 days, about 9% of the document sent, 0 real identifiers, and 35/35 in the **Verified** panel.
3. **Check the proof.** Scroll to **Breach replay**.
   Expect the request to contain `PERSON_1`, never the patient's name, and *"these exact bytes are what the attested enclave signed for"*.
4. **Use a real PDF.** Upload [arXiv 1706.03762](https://arxiv.org/pdf/1706.03762v7) and ask *"What BLEU score did the big Transformer reach on English-to-German?"*.
   Expect the index built from the PDF outline, the answer 28.4, about 9% sent and no author names.
5. **Wallet and vault.** Connect Meteor, click **Unlock vault**, **Save** the document, ask, then **Co-sign with NEAR**.
   Expect the signature verified in the browser, the key confirmed on-chain, and a downloadable receipt.
6. **Come back.** Reload and unlock again.
   Expect the same vault with your document and earlier Q&A.

## Limits

- NEAR AI runs every enclave; splitting across operators is future work.
- PII detection is rule-based and can miss unusual identifiers; keyword routing can pick the wrong section (re-ask is offered).
- Pseudonymisation hides identities, not facts.

## Disclosures

Coding was done using [Claude Code](https://claude.com/claude-code).

## License

[MIT](LICENSE). All bundled sample documents are fictional.

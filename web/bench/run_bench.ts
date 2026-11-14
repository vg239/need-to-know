/**
 * Accuracy vs exposure benchmark.
 *
 * Runs every benchmark question in questions.json through several modes using
 * the SAME pipeline code as the browser app, against the real stateless proxy
 * (start it first: `cd server && uv run python main.py`).
 *
 *   full        whole raw document (long-context chat)
 *   rag         typical chunk RAG: raw 250-token chunks, top-4
 *   ntk-bm25-N  Need-to-Know, fully local BM25 routing, budget N%
 *   ntk-skel    Need-to-Know, skeleton routing (headings → TEE), budget 12%
 *
 * Scoring is deterministic: the restored answer must contain one of the
 * expected keywords. Output: public/bench.json (rendered by the app).
 * All sample documents are fictional.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildPiiMap, identifiersIn, pseudonymise, restoreSegments } from "../src/lib/pii";
import { applyBudget, answerMessages, sectionChars } from "../src/lib/plan";
import { parseSkeletonReply, rankSections, skeletonLines, skeletonMessages, typicalRagChunks } from "../src/lib/retrieval";
import { leaves, sectionize } from "../src/lib/sectionize";

const API = process.env.API ?? "http://127.0.0.1:8000";
const MODEL = "z-ai/glm-5.3-flash";
const SAMPLES = new URL("../public/samples/", import.meta.url);
type Msg = { role: "system" | "user"; content: string };

async function post<T>(path: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return r.json() as Promise<T>;
    if (attempt >= 2) throw new Error(`${path} HTTP ${r.status} ${await r.text()}`);
    await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
  }
}

const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const att = await post<{ verified: boolean; verified_signers: string[]; gateway_signer: string }>("/api/attest", { nonce, model: MODEL });
if (!att.verified) throw new Error("attestation failed — refusing to benchmark");
console.log("attested ✓", att.verified_signers);

const chat = (messages: Msg[], json = false) =>
  post<{ answer: string; request_body: string; verified: boolean }>("/api/chat", {
    model: MODEL, messages, json_mode: json, max_tokens: json ? 600 : 1000,
    verified_signers: att.verified_signers, gateway_signer: att.gateway_signer,
  });

interface Result { mode: string; correct: boolean; pct: number; ids: number; verified: boolean }
const results: Result[] = [];
const questions = JSON.parse(readFileSync(new URL("questions.json", SAMPLES), "utf8"));

const RAW_SYS = "Answer the question using only the document text provided. Be concise (max 4 sentences).";

async function runQuestion(doc: string, q: string, expect: string[]) {
  const secs = sectionize(doc);
  const cands = leaves(secs).filter((s) => s.level > 1);
  const map = buildPiiMap(doc);
  const total = doc.length;
  const hit = (answer: string) => {
    const a = restoreSegments(answer, map).map((s) => s.text).join("").toLowerCase().replace(/,/g, "");
    return expect.some((e) => a.includes(e.toLowerCase().replace(/,/g, "")));
  };
  const jobs: Promise<void>[] = [];

  // full document, raw
  jobs.push(chat([{ role: "system", content: RAW_SYS }, { role: "user", content: `Document:\n${doc}\n\nQuestion: ${q}` }]).then((r) =>
    void results.push({ mode: "full", correct: hit(r.answer), pct: 100, ids: identifiersIn(r.request_body, map).length, verified: r.verified })));

  // typical RAG, raw
  const chunks = typicalRagChunks(doc, q);
  jobs.push(chat([{ role: "system", content: RAW_SYS }, { role: "user", content: `Excerpts:\n${chunks.map((c) => c.text).join("\n---\n")}\n\nQuestion: ${q}` }]).then((r) =>
    void results.push({ mode: "rag", correct: hit(r.answer), pct: (100 * chunks.reduce((n, c) => n + c.text.length, 0)) / total, ids: identifiersIn(r.request_body, map).length, verified: r.verified })));

  // Need-to-Know, local BM25 at several budgets
  const ranked = rankSections(q, cands).map((x) => x.id).slice(0, 6);
  for (const b of [5, 10, 20]) {
    const sel = applyBudget(ranked, cands, total, b);
    const pct = (100 * sel.sent.reduce((n, s) => n + sectionChars(s), 0)) / total;
    jobs.push(chat(answerMessages(sel.sent, q, map)).then((r) =>
      void results.push({ mode: `ntk-bm25-${b}`, correct: hit(r.answer), pct, ids: identifiersIn(r.request_body, map).length, verified: r.verified })));
  }

  // Need-to-Know, skeleton routing (two calls), budget 12%
  jobs.push((async () => {
    const skel = pseudonymise(skeletonLines(cands), map);
    const r1 = await chat(skeletonMessages(skel, pseudonymise(q, map)), true);
    let ids = parseSkeletonReply(r1.answer, cands);
    if (!ids.length) ids = ranked;
    const sel = applyBudget(ids, cands, total, 12);
    const r2 = await chat(answerMessages(sel.sent, q, map));
    const pct = (100 * (sel.sent.reduce((n, s) => n + sectionChars(s), 0) + skel.length)) / total;
    results.push({ mode: "ntk-skel", correct: hit(r2.answer), pct, ids: identifiersIn(r1.request_body + r2.request_body, map).length, verified: r1.verified && r2.verified });
  })());

  await Promise.all(jobs);
}

const work: [string, string, string[]][] = [];
for (const d of Object.values<{ file: string; bench: { q: string; expect: string[] }[] }>(questions)) {
  const doc = readFileSync(new URL(d.file, SAMPLES), "utf8");
  for (const b of d.bench) work.push([doc, b.q, b.expect]);
}
let done = 0;
const CONCURRENCY = 3;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (work.length) {
    const [doc, q, e] = work.shift()!;
    await runQuestion(doc, q, e);
    console.log(`  ${++done} · ${q}`);
  }
}));

const LABELS: Record<string, string> = {
  full: "Whole document (raw)",
  rag: "Typical RAG (raw chunks)",
  "ntk-bm25-5": "Need-to-Know · local · 5% budget",
  "ntk-bm25-10": "Need-to-Know · local · 10% budget",
  "ntk-bm25-20": "Need-to-Know · local · 20% budget",
  "ntk-skel": "Need-to-Know · skeleton · 12% budget",
};
const rows = Object.keys(LABELS).map((mode) => {
  const rs = results.filter((r) => r.mode === mode);
  return {
    mode, label: LABELS[mode],
    exposure_pct: rs.reduce((n, r) => n + r.pct, 0) / rs.length,
    correct: rs.filter((r) => r.correct).length, total: rs.length,
    identifiers: +(rs.reduce((n, r) => n + r.ids, 0) / rs.length).toFixed(1),
    all_signatures_verified: rs.every((r) => r.verified),
  };
});
writeFileSync(new URL("../public/bench.json", import.meta.url), JSON.stringify({ model: MODEL, generated: new Date().toISOString(), questions: done, rows }, null, 1));
console.table(rows.map(({ label, exposure_pct, correct, total, identifiers, all_signatures_verified }) => ({ label, sent: exposure_pct.toFixed(1) + "%", correct: `${correct}/${total}`, ids: identifiers, verified: all_signatures_verified })));

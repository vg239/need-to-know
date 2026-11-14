/**
 * Choosing what to send — two strategies, both decided in the browser:
 *
 *  • BM25 (fully local): rank sections by keyword relevance. Zero bytes leave
 *    the device to make the choice.
 *  • Skeleton routing: send ONLY the pseudonymised section headings (~1–3% of
 *    the document) and let the enclave pick section ids. Smarter on vague
 *    questions; its cost is counted in the Exposure Meter.
 */
import { label, type Section } from "./sectionize";

const STOP = new Set(
  `a an and are as at be by did do does for from had has have how i if in is it its me my of on or our so that the
  their them then there these they this to was were what when where which who why will with you your any after
  before about into than been being can could should would may might also just more most other some such only own
  same too very s t don now`.split(/\s+/),
);

export const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9£$.\s-]/g, " ")
    .split(/[\s-]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t))
    // Crude prefix stemmer: allergic / allergies / allergy → "allerg".
    .map((t) => (t.length > 6 && /^[a-z]+$/.test(t) ? t.slice(0, 6) : t.replace(/s$/, "")));

/** Plain BM25 over arbitrary text units. */
export function bm25(query: string, docs: string[], k1 = 1.4, b = 0.75): number[] {
  const q = [...new Set(tokenize(query))];
  const toks = docs.map(tokenize);
  const N = docs.length;
  const avg = toks.reduce((n, t) => n + t.length, 0) / Math.max(N, 1);
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  return toks.map((t) => {
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    return q.reduce((score, w) => {
      const f = tf.get(w) ?? 0;
      if (!f) return score;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      return score + (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
    }, 0);
  });
}

/** Rank content sections for a question (title counted twice — headings are dense signal). */
export function rankSections(question: string, secs: Section[]): { id: string; score: number }[] {
  const scores = bm25(question, secs.map((s) => `${s.title} ${s.title} ${s.body}`));
  return secs
    .map((s, i) => ({ id: s.id, score: scores[i] }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ─────────────────────────── skeleton routing ───────────────────────────

/** The skeleton: one line per content section, already pseudonymised by the caller. */
export const skeletonLines = (secs: Section[]) => secs.map((s) => label(s)).join("\n");

export function skeletonMessages(skeleton: string, question: string) {
  return [
    {
      role: "system" as const,
      content:
        "You route questions to document sections. You see ONLY section headings, never content. " +
        'Reply with JSON only: {"sections": ["<id>", ...]} listing the 1 to 12 section ids (the § numbers) ' +
        "most likely to contain the answer, best first. Prefer fewer sections; list more only when the question genuinely spans the document (e.g. an audit of all transactions). Do NOT pick sections holding personal, contact, account or party details unless the question is about them.",
    },
    { role: "user" as const, content: `Section headings:\n${skeleton}\n\nQuestion: ${question}` },
  ];
}

export function parseSkeletonReply(reply: string, secs: Section[]): string[] {
  const ids = new Set(secs.map((s) => s.id));
  let picked: string[] = [];
  try {
    const m = reply.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : reply);
    picked = (j.sections ?? j.ids ?? []).map((x: unknown) => String(x).replace(/^§/, "").trim());
  } catch {
    picked = [...reply.matchAll(/§?(\d+(?:\.\d+)+)/g)].map((m) => m[1]);
  }
  return [...new Set(picked)].filter((id) => ids.has(id)).slice(0, 12);
}

// ─────────────────────────── baseline: "typical RAG" ───────────────────────────

export const RAG_CHUNK_CHARS = 1000; // ≈ 250 tokens
export const RAG_TOP_K = 4;

/** What a typical chunk-RAG app would send: fixed-size raw chunks, top-k by BM25, no redaction. */
export function typicalRagChunks(doc: string, question: string): { start: number; end: number; text: string }[] {
  const chunks: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < doc.length; i += RAG_CHUNK_CHARS) {
    chunks.push({ start: i, end: Math.min(doc.length, i + RAG_CHUNK_CHARS), text: doc.slice(i, i + RAG_CHUNK_CHARS) });
  }
  const scores = bm25(question, chunks.map((c) => c.text));
  return chunks
    .map((c, i) => ({ c, s: scores[i] }))
    .sort((a, b) => b.s - a.s)
    .slice(0, RAG_TOP_K)
    .map((x) => x.c);
}

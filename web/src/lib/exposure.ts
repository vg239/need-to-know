/**
 * Exposure accounting for three ways of asking the same question:
 *   full  — paste the whole document (long-context chat)
 *   rag   — typical chunk RAG: raw 250-token chunks, top-4, no redaction
 *   ntk   — Need-to-Know: what we ACTUALLY sent (measured from the request bytes)
 * Baselines are computed locally and never sent anywhere.
 */
import { countIdentifiers, identifiersIn, type PiiMap } from "./pii";
import { typicalRagChunks, RAG_CHUNK_CHARS, RAG_TOP_K } from "./retrieval";
import { sectionChars } from "./plan";
import type { Section } from "./sectionize";

export type ModeKey = "full" | "rag" | "ntk";

export interface Line {
  text: string;
  start: number;
  end: number;
}

export interface ModeExposure {
  key: ModeKey;
  label: string;
  note: string;
  chars: number; // document characters handed to the model
  pct: number; // chars / document length
  identifiers: number; // raw identifier occurrences in the payload
  distinct: string[]; // distinct real identifiers revealed
  lines: ("hidden" | "exposed" | "heading")[]; // per document line, for the minimap
  idLines: boolean[]; // lines whose exposure includes a raw identifier
}

export function docLines(doc: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  for (const text of doc.split("\n")) {
    out.push({ text, start: pos, end: pos + text.length });
    pos += text.length + 1;
  }
  return out;
}

export function computeExposure(args: {
  doc: string;
  secs: Section[];
  map: PiiMap;
  question: string;
  sentIds: string[];
  skeletonUsed: boolean;
  skeletonChars: number;
  ntkPayloads: string[]; // the exact request bodies sent (all calls)
}): ModeExposure[] {
  const { doc, secs, map, question, sentIds, skeletonUsed, skeletonChars, ntkPayloads } = args;
  const lines = docLines(doc);
  const total = doc.length;
  const hasId = lines.map((l) => countIdentifiers(l.text, map) > 0);

  // full
  const full: ModeExposure = {
    key: "full",
    label: "Paste the whole document",
    note: "long-context chat",
    chars: total,
    pct: 100,
    identifiers: countIdentifiers(doc, map),
    distinct: identifiersIn(doc, map),
    lines: lines.map(() => "exposed"),
    idLines: hasId,
  };

  // typical RAG
  const chunks = typicalRagChunks(doc, question);
  const ragText = chunks.map((c) => c.text).join("\n");
  const inChunk = (l: Line) => chunks.some((c) => l.start < c.end && l.end > c.start);
  const rag: ModeExposure = {
    key: "rag",
    label: "Typical RAG",
    note: `${Math.round(RAG_CHUNK_CHARS / 4)}-token chunks · top-${RAG_TOP_K} · no redaction`,
    chars: chunks.reduce((n, c) => n + c.text.length, 0),
    pct: 0,
    identifiers: countIdentifiers(ragText, map),
    distinct: identifiersIn(ragText, map),
    lines: lines.map((l) => (inChunk(l) ? "exposed" : "hidden")),
    idLines: lines.map((l, i) => inChunk(l) && hasId[i]),
  };
  rag.pct = (100 * rag.chars) / total;

  // Need-to-Know (measured)
  const sent = new Set(sentIds);
  const lineState = lines.map((_, i): "hidden" | "exposed" | "heading" => {
    for (const s of secs) if (sent.has(s.id) && i >= s.headLine && i < s.endLine) return "exposed";
    if (skeletonUsed && secs.some((s) => s.body && s.headLine === i)) return "heading";
    return "hidden";
  });
  const payload = ntkPayloads.join("\n");
  const sentChars = secs.filter((s) => sent.has(s.id)).reduce((n, s) => n + sectionChars(s), 0);
  const ntk: ModeExposure = {
    key: "ntk",
    label: "Need-to-Know",
    note: skeletonUsed ? "headings + chosen sections · pseudonymised" : "locally chosen sections · pseudonymised",
    chars: sentChars + (skeletonUsed ? skeletonChars : 0),
    pct: 0,
    identifiers: countIdentifiers(payload, map), // scanned in the REAL bytes — should be 0
    distinct: identifiersIn(payload, map),
    lines: lineState,
    idLines: lines.map(() => false),
  };
  ntk.pct = (100 * ntk.chars) / total;

  return [full, rag, ntk];
}

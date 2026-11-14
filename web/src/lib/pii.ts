/**
 * Local PII detection + pseudonymisation. Runs entirely in the browser.
 *
 *  - Identifiers become consistent codes: "Maria Lopez" → PERSON_1 everywhere,
 *    so the model can still reason about *who* did *what*.
 *  - Dates are SHIFTED by a secret number of whole months (HIPAA-style); month
 *    names move with them. The
 *    model can still compute intervals ("5 days after surgery") without
 *    learning the real calendar dates.
 *  - Date of birth is GENERALISED to a decade ("born 1980s").
 *  - Money amounts are kept — an expense audit needs them.
 *
 * The code → real-value map (`PiiMap`) lives only in React state. It is never
 * serialised, sent, or stored.
 */

export type Kind = "PERSON" | "ORG" | "EMAIL" | "PHONE" | "ADDRESS" | "ID" | "ACCOUNT" | "CARD" | "DOB";

export interface Entity {
  code: string; // PERSON_1, or "[born 1980s]" for a generalised DOB
  kind: Kind;
  value: string; // canonical original value
  surfaces: string[]; // every string form that maps to this code
}

export interface PiiMap {
  entities: Entity[];
  shiftMonths: number; // secret, per session
  matcher: RegExp | null; // all surfaces, longest first
  bySurface: Map<string, Entity>;
  byCode: Map<string, Entity>;
}

const FIRST_NAMES = new Set(
  `Aaron Adam Aisha Alan Alex Alice Amelia Amy Ana Andrew Anna Anne Arjun Ava Ben Carlos Carmen Charles Charlotte
  Chloe Chris Claire Daniel David Diana Edward Elena Ella Ellen Emily Emma Eric Ethan Fatima Grace Hannah Harry Helen
  Henry Isabel Isabella Jack Jacob James Jane Jessica John Jorge Jose Joseph Juan Julia Kate Laura Leo Liam Lily Lucas
  Lucy Luis Marcus Maria Mark Martin Mary Matthew Maya Michael Mia Mohammed Nadia Noah Olivia Oliver Omar Paul Peter
  Priya Rachel Rahul Raj Robert Rosa Ryan Sam Samuel Sara Sarah Sofia Sophie Thomas Tom William Zara Hassan Ines Kenji
  Wei Yuki Fernando Lucia Diego Pedro Ravi Anil Meera Kavya Neha`.split(/\s+/),
);

const PERSON_LABELS =
  /^(Patient|Employee|Account holder|Emergency contact|Secondary contact|Policy holder|Surgeon|Assistant|Anaesthetist|Represented by|Relationship manager|Witness|Signed for the Employer|Signed by the Employee|Name|Client|Tenant|Landlord)\s*:\s*(.+)$/gim;
const ORG_LABELS = /^(Employer|Insurer|Company|Bank)\s*:\s*(.+)$/gim;
const ADDRESS_LABELS = /^(Address|Registered office|Home address)\s*:\s*(.+)$/gim;
const ID_LABELS =
  /^(MRN|National ID|Policy number|Group number|Company number|National Insurance number|Passport number|SSN|Tax ID)\s*:\s*(.+)$/gim;
const ACCOUNT_LABELS = /^(Sort code|Account number|IBAN)\s*:\s*(.+)$/gim;
const DOB_LABELS = /^(Date of birth|DOB)\s*:\s*(\d{1,2}\/\d{1,2}\/(\d{4}))/gim;

const RX = {
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  phone: /\+\d{1,3}(?:[\s-]?\(?\d{1,4}\)?){2,4}[\s-]?\d{3,4}/g,
  iban: /\b[A-Z]{2}\d{2}[A-Z]{4}\d{10,20}\b/g,
  card: /(?<=\bending )\d{4}\b/g,
  account: /(?<=\baccount )\d{8}\b/g,
  ni: /\b[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
  address:
    /\b\d{1,4} [A-Z][a-z]+(?: [A-Z][a-z]+)* (?:Street|Road|Avenue|Hill|Square|Row|Lane|Way|Drive|Close|Crescent)\b(?:, (?:[A-Z][A-Za-z]*|\d+)(?: [A-Z0-9][A-Za-z0-9]*)*){0,3}/g,
  titled: /\b(?:Dr\.|Mr\.|Mrs\.|Ms\.|[Nn]urse)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/g,
  bigram: /\b([A-Z][a-z]+) ([A-Z][a-z]+)\b/g,
  org: /\b(?:[A-Z][\w']*(?: & | )){1,4}(?:Ltd|Hospital|Practice|School|Bank)\b/g,
};

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clean = (v: string) => v.split(/[(,]/)[0].replace(/^Dr\.\s*/, "").trim();

export function buildPiiMap(doc: string, shiftMonths = randomShift()): PiiMap {
  const entities: Entity[] = [];
  const bySurface = new Map<string, Entity>();
  const counters: Partial<Record<Kind, number>> = {};

  const add = (kind: Kind, value: string, surfaces: string[] = [value], code?: string) => {
    value = value.trim();
    if (value.length < 3) return;
    const existing = bySurface.get(value);
    if (existing) {
      for (const s of surfaces) if (!bySurface.has(s)) (existing.surfaces.push(s), bySurface.set(s, existing));
      return;
    }
    counters[kind] = (counters[kind] ?? 0) + 1;
    const e: Entity = { code: code ?? `${kind}_${counters[kind]}`, kind, value, surfaces: [] };
    entities.push(e);
    for (const s of new Set([value, ...surfaces])) if (s.length >= 3 && !bySurface.has(s)) (e.surfaces.push(s), bySurface.set(s, e));
  };
  const each = (rx: RegExp, fn: (m: RegExpMatchArray) => void) => {
    for (const m of doc.matchAll(rx)) fn(m);
  };

  // 1. Labelled fields — the most reliable signal in structured records.
  each(DOB_LABELS, (m) => add("DOB", m[2], [m[2]], `[born ${m[3].slice(0, 3)}0s]`));
  each(PERSON_LABELS, (m) => add("PERSON", clean(m[2])));
  each(ORG_LABELS, (m) => add("ORG", clean(m[2])));
  each(ADDRESS_LABELS, (m) => add("ADDRESS", m[2].trim()));
  each(ID_LABELS, (m) => add("ID", m[2].trim()));
  each(ACCOUNT_LABELS, (m) => add("ACCOUNT", m[2].trim()));

  // 2. Pattern detectors over the full text.
  each(RX.email, (m) => add("EMAIL", m[0]));
  each(RX.phone, (m) => add("PHONE", m[0].trim()));
  each(RX.iban, (m) => add("ACCOUNT", m[0]));
  each(RX.card, (m) => add("CARD", m[0], [m[0]]));
  each(RX.account, (m) => add("ACCOUNT", m[0]));
  each(RX.ni, (m) => add("ID", m[0]));
  each(RX.address, (m) => add("ADDRESS", m[0]));
  each(RX.org, (m) => add("ORG", m[0]));
  each(RX.titled, (m) => add("PERSON", m[1]));

  // 3. Name-like bigrams: known first name, or a surname we already know.
  const surnames = new Set(entities.filter((e) => e.kind === "PERSON").map((e) => e.value.split(" ").pop()!));
  each(RX.bigram, (m) => {
    if (FIRST_NAMES.has(m[1]) || surnames.has(m[2])) add("PERSON", m[0]);
  });

  // 4. Lone first names ("her husband Daniel") → alias of that person, if unambiguous.
  const firsts = new Map<string, Entity[]>();
  for (const e of entities.filter((e) => e.kind === "PERSON" && e.value.includes(" "))) {
    const f = e.value.split(" ")[0];
    firsts.set(f, [...(firsts.get(f) ?? []), e]);
  }
  for (const [f, es] of firsts) {
    if (es.length === 1 && f.length >= 3 && !bySurface.has(f) && new RegExp(`\\b${f}\\b`).test(doc)) {
      es[0].surfaces.push(f);
      bySurface.set(f, es[0]);
    }
  }

  const surfaces = [...bySurface.keys()].sort((a, b) => b.length - a.length);
  const matcher = surfaces.length
    ? new RegExp(`(?<![A-Za-z0-9])(?:${surfaces.map(escapeRx).join("|")})(?![A-Za-z0-9])`, "g")
    : null;
  return { entities, shiftMonths, matcher, bySurface, byCode: new Map(entities.map((e) => [e.code, e])) };
}

// ─────────────────────────── dates ───────────────────────────

const DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;

/** Secret per-session shift in WHOLE MONTHS (2..10, either direction). */
function randomShift(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const m = 2 + (a[0] % 9);
  return a[0] & 1 ? m : -m;
}

/** Shift by whole months, keeping the day (clamped to the month's length). */
function shiftDate(dd: string, mm: string, yyyy: string, months: number): string {
  const total = +yyyy * 12 + (+mm - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.min(+dd, dim))}/${p(m + 1)}/${y}`;
}

// Month names move with the dates — otherwise "October" next to a shifted
// date both contradicts it and leaks the real calendar. Whole-month shifting
// keeps the two exactly consistent.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_RX = new RegExp(`\\b(${MONTHS.join("|")})\\b`, "g");
const shiftMonth = (name: string, months: number) => {
  // Accept full names and 3-letter abbreviations (models like "Jan", "Sept").
  const i = MONTHS.findIndex((m) => m.slice(0, 3) === name.slice(0, 3));
  const out = MONTHS[(((i + months) % 12) + 12) % 12];
  return name.length <= 4 && name !== "May" ? out.slice(0, 3) : out;
};
const MONTH_ANY = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec";

// ─────────────────────────── transforms ───────────────────────────

/** Replace identifiers with codes and shift dates. This is what leaves the device. */
export function pseudonymise(text: string, map: PiiMap): string {
  let out = map.matcher ? text.replace(map.matcher, (s) => map.bySurface.get(s)?.code ?? s) : text;
  out = out.replace(DATE, (_, d, m, y) => shiftDate(d, m, y, map.shiftMonths));
  out = out.replace(MONTH_RX, (mo) => shiftMonth(mo, map.shiftMonths));
  return out;
}

/** Count raw identifier occurrences in a string (used to score each exposure mode). */
export function countIdentifiers(text: string, map: PiiMap): number {
  return map.matcher ? (text.match(map.matcher) ?? []).length : 0;
}

/** Which distinct real identifiers appear in a string. */
export function identifiersIn(text: string, map: PiiMap): string[] {
  if (!map.matcher) return [];
  return [...new Set((text.match(map.matcher) ?? []).map((s) => map.bySurface.get(s)!.value))];
}

export type Segment = { text: string; code?: string; kind?: Kind | "DATE" };

/** Answer from the enclave → real values, as segments so the UI can mark what was restored. */
export function restoreSegments(answer: string, map: PiiMap): Segment[] {
  const rx = new RegExp(
    `\\b(?:PERSON|ORG|EMAIL|PHONE|ADDRESS|ID|ACCOUNT|CARD)_\\d+\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{4}\\b|\\b(?:${MONTH_ANY})\\b`,
    "g",
  );
  const segs: Segment[] = [];
  let last = 0;
  for (const m of answer.matchAll(rx)) {
    const i = m.index!;
    if (i > last) segs.push({ text: answer.slice(last, i) });
    const tok = m[0];
    const e = map.byCode.get(tok);
    if (e) segs.push({ text: e.value, code: tok, kind: e.kind });
    else if (DATE.test(tok)) {
      DATE.lastIndex = 0;
      const [d, mo, y] = tok.split("/");
      segs.push({ text: shiftDate(d, mo, y, -map.shiftMonths), code: tok, kind: "DATE" });
    } else if (new RegExp(`^(?:${MONTH_ANY})$`).test(tok)) {
      segs.push({ text: shiftMonth(tok, -map.shiftMonths), code: tok, kind: "DATE" });
    } else segs.push({ text: tok });
    DATE.lastIndex = 0;
    last = i + tok.length;
  }
  if (last < answer.length) segs.push({ text: answer.slice(last) });
  return segs;
}

/** Split original text into plain / identifier segments (for highlighting in "your view"). */
export function markIdentifiers(text: string, map: PiiMap): Segment[] {
  if (!map.matcher) return [{ text }];
  const segs: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(map.matcher)) {
    const i = m.index!;
    if (i > last) segs.push({ text: text.slice(last, i) });
    const e = map.bySurface.get(m[0])!;
    segs.push({ text: m[0], code: e.code, kind: e.kind });
    last = i + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs;
}

/** Split pseudonymised text into plain / code segments (for the enclave's view). */
export function markCodes(text: string): Segment[] {
  const rx = /\b(?:PERSON|ORG|EMAIL|PHONE|ADDRESS|ID|ACCOUNT|CARD)_\d+\b|\[born \d{4}s\]/g;
  const segs: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(rx)) {
    const i = m.index!;
    if (i > last) segs.push({ text: text.slice(last, i) });
    segs.push({ text: m[0], code: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs;
}

/**
 * Split a document into a section tree — locally, with NO model call.
 * (The old privateRAG built its TOC by sending the whole document to an LLM;
 * that would make "need-to-know" meaningless, so structure is derived from
 * the text itself: markdown headings, numbered headings, ALL-CAPS lines.)
 */

export interface Section {
  id: string; // stable id used for routing, e.g. "4.2" or "s7"
  num: string; // "4.2" when the heading is numbered, else ""
  title: string; // heading text without the number
  level: number; // 1 = document title, 2 = chapter, 3 = sub-section …
  body: string; // text under this heading (until the next heading)
  parent?: string; // id of the enclosing section
  headLine: number; // line index of the heading in the source document
  endLine: number; // first line index AFTER this section's body
}

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const NUM_HEADING = /^((?:\d+\.)*\d+)\.?\s+([A-Z][^\n]{1,80})$/;
const CAPS_HEADING = /^[A-Z][A-Z0-9 &,'\-]{3,60}$/;

function splitNum(text: string): { num: string; title: string } {
  const m = text.match(/^((?:\d+\.)*\d+)\.?\s+(.+)$/);
  return m ? { num: m[1], title: m[2] } : { num: "", title: text };
}

export function sectionize(doc: string): Section[] {
  const lines = doc.replace(/\r\n/g, "\n").split("\n");
  const out: Section[] = [];
  const stack: Section[] = [];
  let cur: Section | null = null;
  let buf: string[] = [];
  let auto = 0;

  const flush = (lineNo: number) => {
    if (cur) {
      cur.body = buf.join("\n").trim();
      cur.endLine = lineNo;
    }
    buf = [];
  };

  for (const [lineNo, raw] of lines.entries()) {
    const line = raw.trimEnd();
    let level = 0;
    let text = "";
    const md = line.match(MD_HEADING);
    if (md) {
      level = md[1].length;
      text = md[2];
    } else if (NUM_HEADING.test(line) && line.length < 80 && !line.includes(":")) {
      const n = line.match(NUM_HEADING)!;
      level = 1 + n[1].split(".").length;
      text = line;
    } else if (CAPS_HEADING.test(line) && line.split(" ").length <= 8) {
      level = 2;
      text = line;
    }

    if (!level) {
      buf.push(raw);
      continue;
    }
    flush(lineNo);
    const { num, title } = splitNum(text);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    cur = {
      id: num || `s${++auto}`,
      num,
      title,
      level,
      body: "",
      parent: stack[stack.length - 1]?.id,
      headLine: lineNo,
      endLine: lineNo + 1,
    };
    // Disambiguate accidental duplicate ids.
    if (out.some((s) => s.id === cur!.id)) cur.id = `${cur.id}-${++auto}`;
    out.push(cur);
    stack.push(cur);
  }
  flush(lines.length);

  // Plain text with no headings at all → paragraphs become sections.
  if (!out.length) {
    return doc
      .split(/\n\s*\n/)
      .map((p, i) => ({ id: `p${i + 1}`, num: "", title: p.split("\n")[0].slice(0, 60), level: 2, body: p.trim(), headLine: -1, endLine: -1 }))
      .filter((s) => s.body);
  }
  return out;
}

/** Sections that carry content (the units we can choose to send). */
export const leaves = (secs: Section[]) => secs.filter((s) => s.body.trim().length > 0);

export const label = (s: Section) => (s.num ? `§${s.num} ${s.title}` : s.title);

/** Total characters of document content — the denominator for "% exposed". */
export const docChars = (secs: Section[]) =>
  secs.reduce((n, s) => n + s.title.length + s.body.length, 0);

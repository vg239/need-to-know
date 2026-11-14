/**
 * PDF → structured text, entirely in the browser (pdf.js, no network).
 *
 * This is a LOCAL PageIndex: a hierarchical table of contents with page
 * numbers, built WITHOUT a model. PrivateRAG built its PageIndex tree by
 * sending the full document text to an LLM; that would defeat need-to-know,
 * so the tree comes from the PDF itself:
 *
 *   1. the PDF outline (bookmarks), when present: the author's own TOC
 *   2. otherwise typography: lines larger than body text, or bold at body
 *      size, become headings; numbering ("3.2.1") sets the depth
 *   3. otherwise one section per page
 *
 * Repeated running headers/footers and bare page numbers are dropped.
 * The result is markdown-style text, so sectionize.ts handles it like any
 * other document, plus a line → page map for "p. N" labels.
 */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type TocSource = "pdf outline" | "typography" | "pages";

export interface PdfResult {
  text: string; // markdown-style: "# title", "## heading", body lines
  lineToPage: number[]; // 1-based page for each line of `text`
  pages: number;
  tocSource: TocSource;
}

interface Line {
  text: string;
  size: number; // rounded to 0.5pt (justified text jitters by a few tenths)
  bold: boolean; // every run on the line uses a bold font
  page: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const unnumbered = (s: string) => norm(s).replace(/^[\d ]+/, "");

async function readLines(doc: pdfjs.PDFDocumentProxy): Promise<Line[]> {
  const out: Line[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    await page.getOperatorList(); // loads the page's fonts, so we can ask which are bold
    const isBold = (fontName: string) => {
      try {
        const f = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; black?: boolean } | null;
        return !!(f && (f.bold || f.black || /bold|black|heavy|semibold|demi/i.test(f.name ?? "")));
      } catch {
        return false;
      }
    };
    const content = await page.getTextContent();
    // Group text runs into visual lines by their baseline (y), then order by x.
    const rows = new Map<number, { x: number; str: string; size: number; bold: boolean }[]>();
    for (const it of content.items) {
      if (!("str" in it) || !it.str.trim()) continue;
      const [a, b, , , x, y] = it.transform as number[];
      if (Math.abs(b) > Math.abs(a) * 0.1) continue; // rotated margin text (e.g. arXiv stamp)
      const size = Math.round(Math.hypot(a, b) * 2) / 2 || it.height;
      const key = Math.round(y / 2) * 2;
      const row = rows.get(key) ?? [];
      row.push({ x, str: it.str, size, bold: isBold(it.fontName) });
      rows.set(key, row);
    }
    for (const y of [...rows.keys()].sort((m, n) => n - m)) {
      const row = rows.get(y)!.sort((m, n) => m.x - n.x);
      const text = row
        .map((r) => r.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) out.push({ text, size: Math.max(...row.map((r) => r.size)), bold: row.every((r) => r.bold), page: p });
    }
    page.cleanup();
  }
  return out;
}

/** Drop running headers/footers (same text on many pages) and bare page numbers. */
function stripFurniture(lines: Line[], pages: number): Line[] {
  if (pages < 3) return lines.filter((l) => !/^\d{1,4}$/.test(l.text));
  const seen = new Map<string, Set<number>>();
  for (const l of lines) {
    const k = norm(l.text).replace(/\d+/g, "#");
    if (!k) continue;
    (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(l.page);
  }
  return lines.filter((l) => {
    if (/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.text)) return false;
    const k = norm(l.text).replace(/\d+/g, "#");
    return (seen.get(k)?.size ?? 0) < Math.max(3, pages * 0.5);
  });
}

async function outlineEntries(doc: pdfjs.PDFDocumentProxy): Promise<{ title: string; level: number; page: number }[]> {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const out: { title: string; level: number; page: number }[] = [];
  const walk = async (items: typeof outline, level: number) => {
    for (const it of items) {
      let page = 0;
      try {
        const dest = typeof it.dest === "string" ? await doc.getDestination(it.dest) : it.dest;
        if (dest?.[0]) page = (await doc.getPageIndex(dest[0])) + 1;
      } catch {
        page = 0;
      }
      if (it.title?.trim() && page) out.push({ title: it.title.trim(), level, page });
      if (it.items?.length && level < 3) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}

/** Body text size = the size carrying the most characters. */
function bodySize(lines: Line[]): number {
  const w = new Map<number, number>();
  for (const l of lines) w.set(l.size, (w.get(l.size) ?? 0) + l.text.length);
  return [...w.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
}

const NUMBERED = /^(\d+(?:\.\d+){0,3})\.?\s+\p{Lu}/u;

/** Typography-based headings: bigger than body, or bold at body size, or numbered + emphasised. */
function typographicHeadings(lines: Line[]): Map<number, number> {
  const body = bodySize(lines);
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(norm(l.text), (counts.get(norm(l.text)) ?? 0) + 1);
  const looksLikeHeading = (l: Line) => {
    const t = l.text;
    if (t.length < 2 || t.length > 90 || !/\p{L}/u.test(t)) return false;
    if (/[.,;]$/.test(t)) return false; // sentences end with punctuation; headings don't
    if ((t.match(/\d/g)?.length ?? 0) / t.length > 0.3) return false; // table rows
    if ((counts.get(norm(t)) ?? 0) > 1) return false; // repeated labels inside figures
    return true;
  };
  const bigger = (l: Line) => l.size >= body * 1.12;
  const cand = lines
    .map((l, i) => ({ i, l }))
    .filter(({ l }) => looksLikeHeading(l) && (bigger(l) || (l.bold && l.size >= body * 0.95 && l.text.length <= 70)));
  const sizes = [...new Set(cand.filter(({ l }) => bigger(l)).map(({ l }) => l.size))].sort((a, b) => b - a);
  const out = new Map<number, number>();
  for (const { i, l } of cand) {
    const num = l.text.match(NUMBERED)?.[1];
    const level = num ? num.split(".").length + 1 : bigger(l) ? Math.min(sizes.indexOf(l.size) + 1, 2) : 2;
    out.set(i, Math.min(level, 3));
  }
  // Too many "headings" means the document is styled uniformly: keep only the larger ones.
  if (out.size > lines.length * 0.25) for (const { i, l } of cand) if (!bigger(l)) out.delete(i);
  return out;
}

export async function pdfToStructuredText(data: ArrayBuffer, fileName: string): Promise<PdfResult> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const pages = doc.numPages;
  const lines = stripFurniture(await readLines(doc), pages);
  const heading = new Map<number, number>(); // line index → heading level (1 = top)
  let tocSource: TocSource = "pages";

  // 1. PDF outline
  const entries = await outlineEntries(doc);
  if (entries.length >= 3) {
    let from = 0;
    let hits = 0;
    for (const e of entries) {
      const t = unnumbered(e.title);
      const inRange = (l: Line, idx: number) => idx >= from && l.page >= e.page && l.page <= e.page + 1;
      // Prefer the exact heading line ("3.2 Attention" for outline entry "Attention");
      // else a short line starting with the title. Long body sentences that merely
      // begin with the same word ("attention over the output...") never match.
      let i = lines.findIndex((l, idx) => inRange(l, idx) && !!t && unnumbered(l.text) === t);
      if (i < 0)
        i = lines.findIndex((l, idx) => {
          if (!inRange(l, idx) || !t) return false;
          const lt = unnumbered(l.text);
          return (lt.startsWith(t) && lt.length <= t.length + 12) || (t.length > 6 && lt.length > 4 && t.startsWith(lt));
        });
      if (i >= 0 && lines[i].page <= e.page + 1) {
        heading.set(i, e.level);
        from = i + 1;
        hits++;
      }
    }
    if (hits >= Math.min(3, entries.length) && hits >= entries.length * 0.4) tocSource = "pdf outline";
    else heading.clear();
  }

  // 2. Typography: size, bold, numbering
  if (tocSource === "pages") {
    for (const [i, lvl] of typographicHeadings(lines)) heading.set(i, lvl);
    // A heading wrapped over two lines with the same style becomes one heading.
    for (const i of [...heading.keys()].sort((a, b) => a - b)) {
      const next = lines[i + 1];
      if (heading.has(i + 1) && heading.get(i + 1) === heading.get(i) && next.page === lines[i].page && next.size === lines[i].size && !/:$/.test(lines[i].text) && !NUMBERED.test(next.text)) {
        lines[i] = { ...lines[i], text: `${lines[i].text} ${next.text}` };
        lines[i + 1] = { ...next, text: "" };
        heading.delete(i + 1);
      }
    }
    if (heading.size >= 2) tocSource = "typography";
    else heading.clear();
  }

  // Emit markdown-style text. Headings start at "##" ("#" is the document title).
  const outLines: string[] = [`# ${fileName.replace(/\.pdf$/i, "")}`];
  const lineToPage: number[] = [1];
  const push = (s: string, page: number) => {
    outLines.push(s);
    lineToPage.push(page);
  };
  let lastPage = 0;
  lines.forEach((l, i) => {
    if (!l.text) return;
    if (tocSource === "pages" && l.page !== lastPage) {
      push(`## Page ${l.page}`, l.page);
      lastPage = l.page;
    }
    const lvl = heading.get(i);
    if (lvl) push(`${"#".repeat(Math.min(lvl, 3) + 1)} ${l.text.replace(/^#+\s*/, "")}`, l.page);
    else push(l.text, l.page);
  });

  await doc.destroy();
  return { text: outLines.join("\n"), lineToPage, pages, tocSource };
}

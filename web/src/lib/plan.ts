/**
 * Turn a ranked list of sections into the minimal, pseudonymised payload,
 * respecting the user's exposure budget.
 */
import { pseudonymise, type PiiMap } from "./pii";
import { label, type Section } from "./sectionize";

export interface Selection {
  sent: Section[]; // sections whose (pseudonymised) body is sent
  dropped: Section[]; // relevant sections left out because of the budget
  overBudget: boolean; // the single best section alone exceeds the budget
}

export const sectionChars = (s: Section) => s.title.length + s.body.length;

export function applyBudget(rankedIds: string[], secs: Section[], totalChars: number, budgetPct: number): Selection {
  const byId = new Map(secs.map((s) => [s.id, s]));
  const cap = (budgetPct / 100) * totalChars;
  const sent: Section[] = [];
  const dropped: Section[] = [];
  let used = 0;
  for (const id of rankedIds) {
    const s = byId.get(id);
    if (!s) continue;
    const c = sectionChars(s);
    if (sent.length === 0 || used + c <= cap) {
      sent.push(s);
      used += c;
    } else dropped.push(s);
  }
  return { sent, dropped, overBudget: used > cap };
}

export function answerMessages(sent: Section[], question: string, map: PiiMap) {
  const excerpts = sent.map((s) => `${pseudonymise(label(s), map)}\n${pseudonymise(s.body, map)}`).join("\n\n");
  return [
    {
      role: "system" as const,
      content:
        "You answer questions about a confidential document using ONLY the excerpts provided. " +
        "Identifiers were replaced by placeholders such as PERSON_1, ORG_2 or ACCOUNT_1, and dates were shifted " +
        "consistently: copy placeholders and dates exactly as written (dd/mm/yyyy), never guess real values. " +
        "Cite the section you used like §4.2. If the excerpts do not contain the answer, say so in one sentence. " +
        "Be concise: at most 6 short bullet points or 4 sentences.",
    },
    { role: "user" as const, content: `Excerpts:\n\n${excerpts}\n\nQuestion: ${pseudonymise(question, map)}` },
  ];
}

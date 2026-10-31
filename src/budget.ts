import { countTokens } from "gpt-tokenizer";
import type { Finding, Format, Limits, Result } from "./contract.js";
import { renderBody } from "./render.js";

// shortcut: o200k count times 1.3 approximates Claude's tokenizer on English prose; low on code-heavy text. Recalibrate if callers report overruns.
const CLAUDE_FACTOR = 1.3;
export const estimateTokens = (text: string) => Math.ceil(countTokens(text) * CLAUDE_FACTOR);

/** Words to ask the model for, leaving room for markup. */
// Measured 2026-10-22: Haiku lands 15 to 40 percent over the words it is given, and labels plus sources take about 60 tokens.
export const wordTarget = (maxTokens: number) => Math.max(20, Math.floor(maxTokens * 0.42));
/** Findings that fit beside the answer: about one per 150 tokens of cap. */
export const findingsTarget = (maxTokens: number) => Math.min(8, Math.floor(maxTokens / 150));

/** Hard limits for the schema: an answer of about 1.35 characters per token of cap, and the findings target. */
export const limits = (maxTokens: number): Limits => ({
  answerChars: Math.max(160, Math.round(maxTokens * 1.35)),
  findings: findingsTarget(maxTokens),
});

export const capLine = (maxTokens: number) =>
  `Output cap: max_tokens ${maxTokens}: about ${wordTarget(maxTokens)} words in total at most, counting answer, findings, quotes and source titles. ` +
  `The answer must fit in ${limits(maxTokens).answerChars} characters. ` +
  `At most ${findingsTarget(maxTokens)} findings${findingsTarget(maxTokens) === 0 ? " (put the facts in the answer)" : ""}; none that repeat the answer without adding a quote.`;

/** Drop a trailing site name ("Title | Site", "Title - Site") and cap the length: titles repeat on every reply. */
export function shortTitle(t: string): string {
  const cut = t.replace(/\s+[|\u2013\u2014-]\s+[^|\u2013\u2014-]{1,40}$/, "").trim();
  const s = cut.length >= 8 ? cut : t.trim();
  return s.length > 80 ? `${s.slice(0, 77).trimEnd()}...` : s;
}

/** Dedupe sources by URL, drop unreferenced ones, renumber findings and [n] markers. */
export function compact(r: Result): Result {
  const byUrl = new Map<string, number>(); // url -> new 1-based number
  const sources: Result["sources"] = [];
  const oldToNew = new Map<number, number>();
  const used = new Set<number>(r.findings.map((f) => f.source));
  for (const m of r.answer.matchAll(/\[(\d+)\]/g)) used.add(Number(m[1]));
  if (used.size === 0 && r.sources.length) used.add(1); // an answer without [n] markers keeps its first source: a citation is the point
  r.sources.forEach((s, i) => {
    if (!used.has(i + 1)) return;
    const key = s.url.replace(/\/$/, "");
    let n = byUrl.get(key);
    if (n === undefined) {
      sources.push({ ...s, title: shortTitle(s.title) });
      n = sources.length;
      byUrl.set(key, n);
    }
    oldToNew.set(i + 1, n);
  });
  const findings = r.findings.filter((f) => oldToNew.has(f.source)).map((f) => ({ ...f, source: oldToNew.get(f.source) ?? f.source }));
  const answer = r.answer.replace(/\[(\d+)\]/g, (_all, d) => (oldToNew.has(Number(d)) ? `[${oldToNew.get(Number(d))}]` : ""));
  return { ...r, answer, findings, sources };
}

/**
 * Safety net after the model: drop the least important findings whole (the rest keep their quotes),
 * then the last quote, then gaps, then cut the answer at sentence ends, until the body fits.
 */
export function trim(r: Result, maxTokens: number, format: Format | "basic"): Result {
  const fits = (x: Result) => estimateTokens(renderBody(x, format)) <= maxTokens;
  if (fits(r)) return r;
  let x: Result = { ...r, findings: [...r.findings], meta: { ...r.meta, trimmed: true } };
  while (x.findings.length > 1 && !fits(x)) x = compact({ ...x, findings: x.findings.slice(0, -1) });
  if (!fits(x) && x.findings[0]?.quote) x = { ...x, findings: [{ ...x.findings[0], quote: undefined }] };
  if (!fits(x)) x = compact({ ...x, findings: [] });
  if (!fits(x)) x = { ...x, gaps: [] };
  while (!fits(x)) {
    const sentences = x.answer.match(/[^.!?]+[.!?]+\s*/g) ?? [];
    const answer =
      sentences.length > 1 ? sentences.slice(0, -1).join("").trim() : `${x.answer.slice(0, Math.floor(x.answer.length * 0.8)).trim()}...`;
    if (answer.length < 10) break;
    x = compact({ ...x, answer });
  }
  return x;
}

// Letters and digits only: quotes survive markdown, smart quotes and spacing differences between the page and the model.
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Check quotes against text the server holds, keyed by URL. Quotes from sources not in `held` are left alone.
 * A quote found there marks its finding `verified`; one not found is dropped and its claim kept.
 */
export function verifyQuotes(r: Result, held: Map<string, string>): Result {
  const normHeld = new Map([...held].map(([u, t]) => [u.replace(/\/$/, ""), norm(t)]));
  const findings = r.findings.map((f): Finding => {
    if (!f.quote) return f;
    const text = normHeld.get(r.sources[f.source - 1]?.url.replace(/\/$/, "") ?? "");
    if (text === undefined) return f;
    return text.includes(norm(f.quote)) ? { ...f, verified: true } : { ...f, quote: undefined };
  });
  return { ...r, findings };
}

import type { Format, Result } from "./contract.js";

/** The reply body, without the meta line. This is what the token cap is measured on. */
export function renderBody(r: Result, format: Format | "basic"): string {
  if (format === "json") return JSON.stringify(toContract(r, false));
  const out: string[] = [`Answer: ${r.answer}`];
  if (format === "markdown") {
    out.push(`Confidence: ${r.meta.confidence}`);
    if (r.findings.length) {
      out.push("", "Findings");
      for (const f of r.findings) out.push(`- ${f.claim} [${f.source}]${f.quote ? ` "${f.quote}"` : ""}${f.date ? ` ${f.date}` : ""}`);
    }
  }
  if (r.sources.length) {
    out.push("", "Sources");
    for (const [i, s] of r.sources.entries()) out.push(`[${i + 1}] ${s.title}. ${s.url}${s.published ? ` (${s.published})` : ""}`);
  }
  if (r.gaps.length) {
    if (format === "basic") out.push("", `Not found: ${r.gaps.join("; ")}`);
    else out.push("", "Gaps", ...r.gaps.map((g) => `- ${g}`));
  }
  return out.join("\n");
}

export function render(r: Result, format: Format | "basic"): string {
  if (format === "json") return JSON.stringify(toContract(r, true));
  const m = r.meta;
  const quotes = r.findings.filter((f) => f.quote).length;
  const line = [
    m.model,
    `searches ${m.queries.length}`,
    `pages ${m.pages_read}`,
    ...(m.head_start ? ["brave"] : []),
    ...(quotes ? [`verified ${m.verified}/${quotes}`] : []),
    ...(m.usage
      ? [
          `claude ${kilo(m.usage.input_tokens + m.usage.cache_read_tokens + m.usage.cache_write_tokens)} in ${kilo(m.usage.output_tokens)} out ~$${m.usage.cost_usd.toFixed(3)}`,
        ]
      : []),
    `cached ${m.cached ? "yes" : "no"}`,
    `trimmed ${m.trimmed ? "yes" : "no"}`,
    `${(m.elapsed_ms / 1000).toFixed(1)} s`,
  ].join(", ");
  return `${renderBody(r, format)}\n\nmeta: ${line}`;
}

const kilo = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The documented JSON contract: `findings[].source` is a 0-based index into `sources`. */
function toContract(r: Result, withMeta: boolean) {
  const findings = r.findings.map((f) => ({ ...f, source: f.source - 1 }));
  return withMeta ? { ...r, findings } : { answer: r.answer, findings, sources: r.sources, gaps: r.gaps };
}

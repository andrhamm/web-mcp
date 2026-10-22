// Brave Search web results: the head start for research runs and the raw `web_search` tool.
// Brave's API terms allow only transient storage of results, so they are cached in memory for minutes and never on disk.
import { readFileSync } from "node:fs";
import { MemoryCache } from "./cache.js";
import { type Domains, type Recency, ToolError } from "./contract.js";

export interface Hit {
  url: string;
  title: string;
  snippets: string[];
  published?: string;
}

export function braveKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.BRAVE_API_KEY?.trim()) return env.BRAVE_API_KEY.trim();
  if (env.BRAVE_API_KEY_FILE) {
    try {
      return readFileSync(env.BRAVE_API_KEY_FILE, "utf8").trim() || undefined;
    } catch {
      console.error("[web-mcp] BRAVE_API_KEY_FILE is set but could not be read; Brave is off");
    }
  }
  return undefined;
}

/** The fields of a Brave web result this server reads. */
interface BraveResult {
  url?: string;
  title?: string;
  description?: string;
  extra_snippets?: string[];
  page_age?: string;
}

const FRESHNESS: Partial<Record<Recency, string>> = { day: "pd", week: "pw", month: "pm", year: "py" };
const memo = new MemoryCache<Hit[]>(10 * 60_000);
let disabledReason: string | undefined;

export const braveAvailable = () => !disabledReason && !!braveKey();

export function braveQuery(query: string, domains?: Domains): string {
  const inc = domains?.include ?? [];
  const exc = domains?.exclude ?? [];
  const parts = [query];
  if (inc.length) parts.push(inc.length === 1 ? `site:${inc[0]}` : `(${inc.map((d) => `site:${d}`).join(" OR ")})`);
  for (const d of exc) parts.push(`-site:${d}`);
  return parts.join(" ");
}

const clean = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

export async function braveSearch(query: string, opts: { count: number; recency?: Recency; domains?: Domains }): Promise<Hit[]> {
  const key = braveKey();
  if (!key || disabledReason)
    throw new ToolError("no_backend", disabledReason ?? "No Brave API key is configured", "Set BRAVE_API_KEY or BRAVE_API_KEY_FILE");
  const params = new URLSearchParams({ q: braveQuery(query, opts.domains), count: String(opts.count), extra_snippets: "true" });
  const fresh = opts.recency && FRESHNESS[opts.recency];
  if (fresh) params.set("freshness", fresh);
  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;
  const hit = memo.get(url);
  if (hit) return hit;
  const res = await fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    throw new ToolError("fetch_failed", `Brave search failed: ${e.message}`);
  });
  if (res.status === 401 || res.status === 403 || res.status === 422) {
    const err = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
    const code = err.error?.code ?? res.status;
    disabledReason = `Brave rejected the API key (${code})`;
    console.error(`[web-mcp] ${disabledReason}; Brave is off until restart`);
    throw new ToolError("no_backend", disabledReason, "Check the Brave plan and key");
  }
  if (res.status === 429)
    throw new ToolError("rate_limited", "Brave rate limit or credit exhausted", "Wait a moment, or check the Brave plan's credit");
  if (!res.ok) throw new ToolError("fetch_failed", `Brave answered HTTP ${res.status}`);
  const body = (await res.json()) as { web?: { results?: BraveResult[] } };
  const hits: Hit[] = (body?.web?.results ?? []).map((r) => ({
    url: String(r.url),
    title: clean(String(r.title ?? r.url)),
    snippets: [r.description, ...(r.extra_snippets ?? [])].filter((s): s is string => typeof s === "string" && s !== "").map(clean),
    ...(typeof r.page_age === "string" ? { published: r.page_age.slice(0, 10) } : {}),
  }));
  memo.set(url, hits);
  return hits;
}

export function renderHits(hits: Hit[], maxSnippets = 3): string {
  return hits
    .map((h, i) =>
      [
        `[${i + 1}] ${h.title}. ${h.url}${h.published ? ` (${h.published})` : ""}`,
        ...h.snippets.slice(0, maxSnippets).map((s) => `  ${s}`),
      ].join("\n"),
    )
    .join("\n");
}

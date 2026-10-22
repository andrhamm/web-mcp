// Fetch one public page, extract its main text as markdown, and keep the passages that serve a goal.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import MiniSearch from "minisearch";
import TurndownService from "turndown";
import { ToolError } from "./contract.js";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Loopback, private, link-local, CGNAT, unspecified and multicast ranges, IPv4 and IPv6 (including IPv4-mapped). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  if (isIP(v) === 4) {
    const [a = 0, b = 0] = v.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(v) === 6) return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
  return true; // not an IP: callers resolve first
}

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ToolError("blocked_url", `Only http and https URLs are read (${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new ToolError("blocked_url", "Local addresses are not read");
  // shortcut: checks DNS before the fetch, so a rebinding host could still flip; pin the resolved address if this runs beside sensitive services.
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new ToolError("fetch_failed", `Could not resolve ${host}`);
  if (addrs.some(isPrivateAddress)) throw new ToolError("blocked_url", "Private and local network addresses are not read");
}

export interface Page {
  url: string;
  title: string;
  markdown: string;
  published?: string;
}

export async function fetchPage(rawUrl: string): Promise<Page> {
  let url = new URL(rawUrl);
  let res: Response | undefined;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublic(url);
    res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "web-mcp/0.1", accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
    }).catch((e) => {
      throw new ToolError(e.name === "TimeoutError" ? "timeout" : "fetch_failed", `Could not fetch ${url.host}: ${e.message}`);
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url);
      continue;
    }
    break;
  }
  if (!res?.ok) throw new ToolError("fetch_failed", `The page answered HTTP ${res?.status ?? "redirect loop"}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml|text\/plain/.test(type))
    throw new ToolError(
      "fetch_failed",
      `Unsupported content type ${type.split(";")[0] || "unknown"}`,
      "Only HTML and plain text pages are read",
    );
  const body = await readCapped(res);
  return /text\/plain/.test(type) ? { url: url.href, title: url.href, markdown: body.trim() } : extract(body, url.href);
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = MAX_BYTES - size;
    parts.push(value.byteLength > room ? value.subarray(0, room) : value);
    size += Math.min(value.byteLength, room);
    if (size >= MAX_BYTES) {
      await reader.cancel();
      break; // keep what fits; the main text is usually near the top
    }
  }
  return Buffer.concat(parts).toString("utf8");
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe"]);
turndown.remove((n) => n.nodeName.toLowerCase() === "svg");
// Token economy: link targets and images are noise for a reader model; tables become one pipe row per line.
turndown.addRule("linkText", { filter: "a", replacement: (content) => content });
turndown.addRule("noImages", { filter: "img", replacement: () => "" }); // added rules outrank remove() for void elements
turndown.addRule("cell", { filter: ["th", "td"], replacement: (content) => ` ${content.replace(/\s+/g, " ").trim()} |` });
turndown.addRule("row", { filter: "tr", replacement: (content) => `\n|${content}\n` });
turndown.addRule("table", { filter: "table", replacement: (content) => `\n\n${content.replace(/\n+/g, "\n").trim()}\n\n` });

export function extract(html: string, url: string): Page {
  // linkedom roots a document without <html> at its first tag, which Readability rejects.
  const source = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(source);
  const title = document.querySelector("title")?.textContent?.trim() || url;
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(document as unknown as Document).parse();
  } catch (e) {
    console.error(`[web-mcp] readability failed on ${url}: ${(e as Error).message}`);
  }
  const markdown = article?.content ? turndown.turndown(article.content) : (parseHTML(source).document.body?.textContent ?? "");
  return {
    url,
    title: article?.title?.trim() || title,
    markdown: markdown.replace(/\n{3,}/g, "\n\n").trim(),
    published: article?.publishedTime ?? undefined,
  };
}

/** Split markdown into passages of about 120 words, each carrying its nearest heading. */
export function chunk(markdown: string): string[] {
  const chunks: string[] = [];
  let heading = "";
  let buf: string[] = [];
  const words = () => buf.join(" ").split(/\s+/).length;
  const flush = () => {
    if (buf.length) chunks.push((heading && !buf[0]?.startsWith("#") ? `${heading}\n` : "") + buf.join("\n\n"));
    buf = [];
  };
  for (const para of markdown.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (/^#{1,6}\s/.test(p)) {
      flush();
      heading = p.split("\n")[0] ?? "";
    }
    buf.push(p);
    if (words() >= 120) flush();
  }
  flush();
  return chunks;
}

/** Keep the first passage and the passages that best match `query`, in page order, within `maxChars`. */
export function select(chunks: string[], query: string, maxChars: number): string {
  if (chunks.join("\n\n").length <= maxChars) return chunks.join("\n\n");
  const ms = new MiniSearch({ fields: ["text"], storeFields: [] });
  ms.addAll(chunks.map((text, id) => ({ id, text })));
  const ranked = ms.search(query, { prefix: true, fuzzy: 0.2, combineWith: "OR" }).map((h) => h.id as number);
  const len = (i: number) => chunks[i]?.length ?? 0;
  const keep = new Set<number>([0]);
  let used = len(0);
  for (const id of ranked) {
    if (keep.has(id) || used + len(id) > maxChars) continue;
    keep.add(id);
    used += len(id) + 2;
  }
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => chunks[i] ?? "")
    .join("\n\n");
}

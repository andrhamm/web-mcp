import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { braveQuery } from "../src/brave.js";
import { compact, estimateTokens, limits, trim, verifyQuotes } from "../src/budget.js";
import { cacheDir, FileCache, MemoryCache } from "../src/cache.js";
import { childEnv, claudeArgs, parseStream } from "../src/claude.js";
import { modelResultSchema, type Result } from "../src/contract.js";
import { chunk, extract, fetchPage, isPrivateAddress, select } from "../src/reader.js";
import { render, renderBody } from "../src/render.js";

const fixture = (f: string) => readFileSync(new URL(`../../test/fixtures/${f}`, import.meta.url), "utf8");

function sample(): Result {
  return {
    answer: "Widget 3.0 shipped on 2026-10-14 [1] and is Apache-2.0 [2].",
    findings: [
      { claim: "Released 14 October 2026.", source: 1, quote: "shipped version 3.0 on 14 October 2026", date: "2026-10-14" },
      { claim: "Licence is Apache-2.0.", source: 2, quote: "changed from GPL-3.0 to Apache-2.0" },
      { claim: "2.x gets security fixes until mid 2027.", source: 3, quote: "security fixes until 30 June 2027" },
    ],
    sources: [
      { url: "https://example.org/a", title: "A" },
      { url: "https://example.org/a/", title: "A again" },
      { url: "https://example.org/b", title: "B" },
      { url: "https://example.org/unused", title: "Unused" },
    ],
    gaps: ["Benchmark method"],
    meta: {
      queries: ["q"],
      pages_read: 1,
      cache_hits: 0,
      backends: [],
      elapsed_ms: 1200,
      model: "haiku",
      confidence: "high",
      cached: false,
      trimmed: false,
      verified: 0,
      head_start: false,
    },
  };
}

test("compact dedupes by URL, drops unused sources, renumbers findings and markers", () => {
  const r = compact(sample());
  assert.deepEqual(
    r.sources.map((s) => s.url),
    ["https://example.org/a", "https://example.org/b"],
  );
  assert.deepEqual(
    r.findings.map((f) => f.source),
    [1, 1, 2],
  );
  assert.equal(r.answer, "Widget 3.0 shipped on 2026-10-14 [1] and is Apache-2.0 [1].");
});

test("trim fits the cap and marks the result; untouched when it already fits", () => {
  const r = compact(sample());
  assert.equal(trim(r, 4000, "markdown"), r);
  const t = trim(r, 60, "markdown");
  assert.ok(estimateTokens(renderBody(t, "markdown")) <= 60, renderBody(t, "markdown"));
  assert.equal(t.meta.trimmed, true);
  assert.ok(t.answer.length > 0);
  const mid = trim(r, estimateTokens(renderBody(r, "markdown")) - 5, "markdown");
  assert.equal(mid.findings.length, r.findings.length - 1); // the least important finding goes whole
  assert.equal(mid.findings[0]!.quote, r.findings[0]!.quote); // the rest keep their quotes
});

test("shortTitle drops a trailing site name and caps length", async () => {
  const { shortTitle } = await import("../src/budget.js");
  assert.equal(
    shortTitle("Node.js end-of-life dates & support status (2026) | IsItPatched"),
    "Node.js end-of-life dates & support status (2026)",
  );
  assert.equal(shortTitle("Widget 3.0 released - Example News"), "Widget 3.0 released");
  assert.equal(shortTitle("Short | Site"), "Short | Site");
  assert.ok(shortTitle("x".repeat(200)).length <= 80);
});

test("verifyQuotes keeps quotes found in held text, drops the rest, ignores unheld sources", () => {
  const r = compact(sample());
  const held = new Map([["https://example.org/a", "The   project “shipped” version 3.0 on 14 October 2026. Nothing about licences."]]);
  const result = verifyQuotes(r, held);
  assert.deepEqual(
    result.findings.map((f) => f.verified),
    [true, undefined, undefined],
  );
  assert.equal(result.findings[0]!.quote, "shipped version 3.0 on 14 October 2026");
  assert.equal(result.findings[1]!.quote, undefined); // source a held, quote absent
  assert.equal(result.findings[2]!.quote, "security fixes until 30 June 2027"); // source b not held
});

test("render: markdown carries answer, findings, sources, gaps and a meta line; json uses 0-based sources", () => {
  const r = compact(sample());
  const md = render(r, "markdown");
  assert.match(md, /^Answer: Widget 3.0/);
  assert.match(md, /\nConfidence: high\n/);
  assert.match(md, /\n- Released 14 October 2026. \[1\] "shipped version 3.0 on 14 October 2026" 2026-10-14\n/);
  assert.match(md, /\n\[2\] B\. https:\/\/example.org\/b\n/);
  assert.match(md, /\nmeta: haiku, searches 1, pages 1, verified 0\/3, cached no, trimmed no, 1.2 s$/);
  const basic = render(r, "basic");
  assert.doesNotMatch(basic, /Findings|Confidence/);
  assert.match(basic, /Not found: Benchmark method/);
  const json = JSON.parse(render(r, "json"));
  assert.deepEqual(
    json.findings.map((f: { source: number }) => f.source),
    [0, 0, 1],
  );
  assert.equal(json.meta.model, "haiku");
});

test("file cache honours TTL; memory cache expires", async () => {
  const c = new FileCache(await mkdtemp(join(tmpdir(), "wr-cache-")));
  await c.set("k", { a: 1 }, 1000, 0);
  assert.deepEqual(await c.get("k", 500), { a: 1 });
  assert.equal(await c.get("k", 1500), undefined);
  assert.equal(await c.get("missing"), undefined);
  const m = new MemoryCache<number>(1000);
  m.set("k", 1, 0);
  assert.equal(m.get("k", 999), 1);
  assert.equal(m.get("k", 1001), undefined);
});

test("private address guard", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "172.32.0.1"]) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(fetchPage("http://localhost:8080/x"), { code: "blocked_url" });
  await assert.rejects(fetchPage("http://169.254.169.254/latest/meta-data"), { code: "blocked_url" });
  await assert.rejects(fetchPage("file:///etc/passwd"), { code: "blocked_url" });
});

test("extract keeps the article, drops navigation and scripts; select keeps matching passages in order", () => {
  const page = extract(fixture("article.html"), "https://example.org/widget");
  assert.match(page.title, /^Widget 3.0 released/);
  assert.match(page.markdown, /## Licensing/);
  assert.doesNotMatch(page.markdown, /Subscribe|alert\(1\)/);
  assert.match(page.markdown, /\| Version \| Released \|\n\| 3\.0 \| 2026-10-14 \|/);
  assert.doesNotMatch(page.markdown, /\]\(|https:\/\/example\.org\/changelog|logo\.png/);
  const chunks = chunk(page.markdown);
  assert.ok(chunks.length >= 2);
  const picked = select(chunks, "licence apache", 600);
  assert.doesNotMatch(picked, /security fixes/); // unrelated passage left out
  assert.match(picked, /Apache-2.0/);
});

test("claude args restrict tools and settings; child env drops nesting markers and API keys", () => {
  const a = claudeArgs({ system: "s", prompt: "p", schema: modelResultSchema(limits(300)), tools: [], maxTurns: 3, timeoutMs: 1 });
  assert.equal(a[a.indexOf("--tools") + 1], "");
  assert.ok(!a.includes("--allowed-tools"));
  const w = claudeArgs({ system: "s", prompt: "p", schema: "{}", tools: ["WebSearch", "WebFetch"], maxTurns: 3, timeoutMs: 1 });
  assert.equal(w[w.indexOf("--allowed-tools") + 1], "WebSearch,WebFetch"); // listed tools must also be pre-approved
  assert.equal(a[a.indexOf("--setting-sources") + 1], "");
  for (const f of ["--strict-mcp-config", "--no-session-persistence", "--verbose"]) assert.ok(a.includes(f), f);
  assert.ok(!a.includes("--bare"));
  assert.equal(JSON.parse(a[a.indexOf("--json-schema") + 1]!).$schema, undefined); // claude rejects the 2020-12 stamp
  const env = childEnv({ CLAUDECODE: "1", ANTHROPIC_API_KEY: "x", ANTHROPIC_AUTH_TOKEN: "y", PATH: "/bin" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("parseStream counts real tool calls and validates the result", () => {
  const r = parseStream(fixture("stream.jsonl"));
  assert.deepEqual(r.queries, ["eiffel tower height"]);
  assert.deepEqual(r.pages, ["https://example.org/eiffel"]); // the denied fetch is not counted
  assert.equal(r.model, "claude-haiku-5-5");
  assert.equal(r.output.confidence, "high");
  assert.throws(() => parseStream('{"type":"result","is_error":true,"terminal_reason":"max_turns","result":""}'), { code: "bad_output" });
  assert.throws(() => parseStream('{"type":"result","is_error":true,"result":"Claude usage limit reached"}'), { code: "rate_limited" });
  assert.throws(() => parseStream(""), { code: "bad_output" });
  assert.throws(() => parseStream('{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'), {
    code: "claude_not_signed_in",
  });
  // A successful answer that talks about authentication or rate limits is not an error.
  const ok = parseStream(
    '{"type":"result","is_error":false,"result":"Brave authentication uses a header; mind the rate limit","structured_output":{"answer":"a","confidence":"low","findings":[],"sources":[],"gaps":[]}}',
  );
  assert.equal(ok.output.answer, "a");
});

test("brave query adds site filters", () => {
  assert.equal(braveQuery("x", { include: ["a.com"] }), "x site:a.com");
  assert.equal(braveQuery("x", { include: ["a.com", "b.org"], exclude: ["c.net"] }), "x (site:a.com OR site:b.org) -site:c.net");
});

test("cache directory follows each platform's convention unless overridden", () => {
  assert.equal(cacheDir({ WEB_MCP_CACHE_DIR: "/x" }, "linux"), "/x");
  assert.match(cacheDir({}, "darwin"), /Library\/Caches\/web-mcp$/);
  assert.equal(cacheDir({ XDG_CACHE_HOME: "/xdg" }, "linux"), "/xdg/web-mcp");
  assert.match(cacheDir({}, "linux"), /\.cache\/web-mcp$/);
  assert.equal(cacheDir({ LOCALAPPDATA: "C:/Local" }, "win32"), join("C:/Local", "web-mcp"));
});

test("compact drops [n] markers that point at no source", () => {
  const r = compact({ ...sample(), answer: "Real [1], ghost [9]." });
  assert.equal(r.answer, "Real [1], ghost .");
});

test("trim cuts a long answer at sentence ends when nothing else is left to drop", () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something specific.`).join(" ");
  const r = { ...sample(), answer: long, findings: [], sources: [], gaps: [] };
  const t = trim(r, 60, "basic");
  assert.ok(estimateTokens(renderBody(t, "basic")) <= 60);
  assert.match(t.answer, /^Sentence number 0 .*\.$/);
  assert.equal(t.meta.trimmed, true);
});

test("the per-request schema carries length limits sized to the cap; parsing stays lenient", () => {
  const s = JSON.parse(modelResultSchema(limits(300)));
  assert.equal(s.$schema, undefined);
  assert.equal(s.properties.answer.maxLength, 405);
  assert.equal(s.properties.findings.maxItems, 2);
  assert.equal(s.properties.findings.items.properties.quote.maxLength, 220);
  assert.equal(s.properties.gaps.maxItems, 3);
  assert.equal(JSON.parse(modelResultSchema(limits(100))).properties.findings.maxItems, 0);
});

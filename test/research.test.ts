// research() and readPage() in-process: fake claude, scripted fetch for Brave and pages, temp cache.
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { claudeOutput, FAKE_CLAUDE, fixture, html, json, readLog, stubFetch, tmp } from "./helpers.js";

const dir = tmp();
const log = join(dir, "claude.log");
Object.assign(process.env, {
  WEB_MCP_CACHE_DIR: join(dir, "cache"),
  CLAUDE_BIN: FAKE_CLAUDE,
  FAKE_CLAUDE_LOG: log,
  BRAVE_API_KEY: "k",
});
const { research, readPage } = await import("../src/research.js");

let stub: ReturnType<typeof stubFetch> | undefined;
afterEach(() => stub?.restore());
const base = { goal: "Cite the height", max_tokens: 400, depth: "quick" as const, recency: "any" as const, cache: "use" as const };
const BRAVE = {
  web: {
    results: [
      { title: "Tower facts | Site", url: "https://facts.example/tower", description: "The tower is 330 metres tall, including antennas." },
    ],
  },
};

test("Brave head start goes into the prompt; quotes are checked against its snippets unless Haiku read the page", async () => {
  stub = stubFetch((u) => (u.hostname === "api.search.brave.com" ? json(BRAVE) : html("unexpected", 500)));
  process.env.FAKE_CLAUDE_OUT = claudeOutput(
    {
      answer: "It is 330 m tall [1][2].",
      confidence: "high",
      findings: [
        { claim: "330 m with antennas.", source: 1, quote: "The tower is 330 metres tall" },
        { claim: "Invented.", source: 1, quote: "a sentence Brave never returned" },
        { claim: "From a page Haiku read.", source: 2, quote: "unverifiable but kept" },
      ],
      sources: [
        { url: "https://facts.example/tower", title: "Tower facts | Site" },
        { url: "https://read.example/p", title: "Read page" },
      ],
      gaps: [],
    },
    [{ name: "WebFetch", input: { url: "https://read.example/p" } }],
  );
  const md = await research(
    { ...base, question: "How tall is the tower?", recency: "week", domains: { include: ["facts.example"], exclude: ["spam.example"] } },
    "markdown",
  );
  assert.match(md, /"The tower is 330 metres tall"/);
  assert.doesNotMatch(md, /never returned/);
  assert.match(md, /"unverifiable but kept"/);
  assert.match(md, /\[1\] Tower facts\. https:\/\/facts\.example\/tower\n/); // site name trimmed from the title
  assert.match(md, /meta: claude-haiku-5-5, searches 0, pages 1, brave, verified 1\/2, cached no/);
  const brave = new URL(stub.calls[0]!);
  assert.equal(brave.searchParams.get("freshness"), "pw");
  assert.equal(brave.searchParams.get("q"), "How tall is the tower? site:facts.example -site:spam.example");
  const prompt = readLog(log).at(-1).stdin;
  assert.match(prompt, /Recency: use sources from the past week only\./);
  assert.match(prompt, /Domains: use only facts\.example\.\nNever use: spam\.example\./);
  assert.match(prompt, /Head start: .*\n\[1\] Tower facts \| Site\. https:\/\/facts\.example\/tower\n {2}The tower is 330 metres tall/);
  assert.match(prompt, /Output cap: max_tokens 400: about 168 words .* At most 2 findings/);
});

test("a failed head start is skipped, not fatal", async () => {
  stub = stubFetch(() => json({}, 500));
  process.env.FAKE_CLAUDE_OUT = claudeOutput(
    { answer: "Fine [1].", confidence: "low", findings: [], sources: [{ url: "https://x.example", title: "X" }], gaps: ["most of it"] },
    [{ name: "WebSearch", input: { query: "q" } }],
  );
  const out = JSON.parse(await research({ ...base, question: "Brave is down?" }, "json"));
  assert.equal(out.meta.head_start, false);
  assert.deepEqual(out.meta.backends, ["claude-websearch"]);
  assert.deepEqual(out.meta.queries, ["q"]);
  assert.match(readLog(log).at(-1).stdin, /No head start: search first\./);
});

test("answers are cached per question, goal and cap; refresh bypasses the cache", async () => {
  stub = stubFetch(() => json({ web: { results: [] } }));
  process.env.FAKE_CLAUDE_OUT = claudeOutput({
    answer: "Cached [1].",
    confidence: "medium",
    findings: [],
    sources: [{ url: "https://c.example", title: "C" }],
    gaps: [],
  });
  const q = { ...base, question: "Cache me?" };
  const runs = () => readLog(log).filter((c) => c.stdin.includes("Cache me?")).length;
  await research(q, "markdown");
  assert.match(await research({ ...q, question: "  cache   ME? " }, "markdown"), /cached yes/); // normalized key
  assert.equal(runs(), 1);
  await research({ ...q, max_tokens: 1000 }, "markdown"); // different cap bucket
  assert.equal(runs(), 2);
  await research({ ...q, cache: "refresh" }, "markdown");
  assert.equal(runs(), 3);
});

test("readPage runs Haiku without tools on the page text, pins the source and verifies quotes against the page", async () => {
  stub = stubFetch(() => html(fixture("article.html")));
  process.env.FAKE_CLAUDE_OUT = claudeOutput({
    answer: "Now Apache-2.0 [1].",
    confidence: "high",
    findings: [
      { claim: "Licence changed.", source: 1, quote: "changed from GPL-3.0 to Apache-2.0" },
      { claim: "Made up.", source: 1, quote: "the page never says this" },
    ],
    sources: [{ url: "https://wrong.example", title: "Wrong" }],
    gaps: [],
  });
  const url = "http://93.184.215.14/widget";
  const out = JSON.parse(await readPage({ url, goal: "What licence now?", max_tokens: 400, cache: "use" }, "json"));
  assert.deepEqual(out.sources, [{ url, title: "Widget 3.0 released" }]);
  assert.equal(out.findings.length, 2);
  assert.equal(out.findings[0].quote, "changed from GPL-3.0 to Apache-2.0");
  assert.equal(out.findings[1].quote, undefined);
  assert.equal(out.meta.verified, 1);
  assert.equal(out.meta.cache_hits, 0);
  const call = readLog(log).at(-1);
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
  assert.match(call.stdin, /<page>\n[\s\S]*## Licensing[\s\S]*<\/page>/);
  // A second goal on the same page reuses the fetched page.
  const again = JSON.parse(await readPage({ url, goal: "When was it released?", max_tokens: 400, cache: "use" }, "json"));
  assert.equal(again.meta.cache_hits, 1);
  assert.equal(stub.calls.length, 1);
});

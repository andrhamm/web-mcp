// A call refused as busy must not spend a Brave request: the head start runs inside the Claude slot.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { claudeOutput, FAKE_CLAUDE, json, readLog, stubFetch, tmp, waitFor } from "./helpers.js";

const dir = tmp();
const log = join(dir, "calls.log");
Object.assign(process.env, {
  WEB_MCP_CACHE_DIR: join(dir, "cache"),
  CLAUDE_BIN: FAKE_CLAUDE,
  FAKE_CLAUDE_LOG: log,
  FAKE_CLAUDE_SLEEP_MS: "3000",
  FAKE_CLAUDE_OUT: claudeOutput({
    answer: "a [1]",
    confidence: "low",
    findings: [],
    sources: [{ url: "https://x.example", title: "X" }],
    gaps: [],
  }),
  BRAVE_API_KEY: "k",
  WEB_MCP_CONCURRENCY: "1",
  WEB_MCP_QUEUE: "0",
});
const { research } = await import("../src/research.js");
const input = (question: string) => ({
  question,
  goal: "g",
  max_tokens: 300,
  depth: "quick" as const,
  recency: "any" as const,
  cache: "use" as const,
});

test("a busy refusal makes no Brave request and returns at once", async () => {
  const stub = stubFetch(() => json({ web: { results: [{ title: "T", url: "https://x.example", description: "d" }] } }));
  try {
    const holder = new AbortController();
    const first = research(input("first question"), "markdown", holder.signal);
    await waitFor(() => readLog(log).length === 1, 3000, "first run to start");
    assert.equal(stub.calls.length, 1); // the first call's head start
    const t0 = Date.now();
    await assert.rejects(research(input("second question"), "markdown"), { code: "busy" });
    assert.ok(Date.now() - t0 < 300, "refused without waiting on Brave");
    assert.equal(stub.calls.length, 1); // no Brave request for the refused call
    holder.abort();
    await assert.rejects(first, { code: "cancelled" });
  } finally {
    stub.restore();
  }
});

// The Claude runner against the fake claude: arguments, environment, failures and concurrency.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { checkSignedIn, runClaude } from "../src/claude.js";
import { limiter } from "../src/limit.js";
import { claudeOutput, FAKE_CLAUDE, readLog, tmp } from "./helpers.js";

const OUT = { answer: "a [1]", confidence: "medium", findings: [], sources: [{ url: "https://x.example", title: "X" }], gaps: [] };
const opts = { system: "sys", prompt: "the prompt", schema: "{}", tools: ["WebSearch", "WebFetch"], maxTurns: 4, timeoutMs: 10_000 };
process.env.CLAUDE_BIN = FAKE_CLAUDE;

test("runs claude with the prompt on stdin, in an empty temp dir, without nesting markers or API keys", async () => {
  const log = join(tmp(), "log");
  Object.assign(process.env, {
    FAKE_CLAUDE_OUT: claudeOutput(OUT, [{ name: "WebSearch", input: { query: "q1" } }]),
    FAKE_CLAUDE_LOG: log,
    CLAUDECODE: "1",
    ANTHROPIC_API_KEY: "secret",
  });
  try {
    const r = await runClaude(opts);
    assert.deepEqual(r.queries, ["q1"]);
    assert.equal(r.output.answer, "a [1]");
    const [call] = readLog(log);
    assert.equal(call.stdin, "the prompt");
    assert.equal(call.claudecode, null);
    assert.equal(call.apiKey, null);
    assert.match(call.cwd, /web-mcp-/);
    assert.equal(call.args[call.args.indexOf("--max-turns") + 1], "4");
    assert.equal(call.args[call.args.indexOf("--system-prompt") + 1], "sys");
  } finally {
    delete process.env.CLAUDECODE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.FAKE_CLAUDE_LOG;
  }
});

test("a run that outlives its timeout is killed and reported", async () => {
  process.env.FAKE_CLAUDE_SLEEP_MS = "5000";
  try {
    const t0 = Date.now();
    await assert.rejects(runClaude({ ...opts, timeoutMs: 300 }), { code: "timeout" });
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    delete process.env.FAKE_CLAUDE_SLEEP_MS;
  }
});

test("claude's stderr explains a run that produced no result", async () => {
  const saved = process.env.FAKE_CLAUDE_OUT;
  delete process.env.FAKE_CLAUDE_OUT;
  process.env.FAKE_CLAUDE_STDERR = "Error: --json-schema is not a valid JSON Schema\nmore";
  try {
    await assert.rejects(runClaude(opts), {
      code: "bad_output",
      message: "claude failed: Error: --json-schema is not a valid JSON Schema",
    });
  } finally {
    delete process.env.FAKE_CLAUDE_STDERR;
    process.env.FAKE_CLAUDE_OUT = saved;
  }
});

test("a missing claude command is a no_backend error", async () => {
  process.env.CLAUDE_BIN = join(tmp(), "no-claude-here");
  try {
    await assert.rejects(runClaude(opts), { code: "no_backend" });
  } finally {
    process.env.CLAUDE_BIN = FAKE_CLAUDE;
  }
});

test("sign-in check fails while signed out and passes once signed in", async () => {
  process.env.FAKE_CLAUDE_SIGNED_OUT = "1";
  await assert.rejects(checkSignedIn(), { code: "claude_not_signed_in" });
  delete process.env.FAKE_CLAUDE_SIGNED_OUT;
  await checkSignedIn();
});

test("limiter runs at most n tasks at once, in arrival order", async () => {
  const run = limiter(2);
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const task = (i: number) => async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    order.push(i);
    active--;
    return i;
  };
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) => run(task(i))));
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(order.slice(-1), [4]);
  await assert.rejects(
    run(async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(await run(async () => "after a failure"), "after a failure"); // a failed task frees its slot
});

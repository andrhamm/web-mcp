// Queue cap, wait deadline and cancellation of the Claude runner, with one slot and one waiting place.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { claudeOutput, FAKE_CLAUDE, lines, readLog, sleep, tmp, waitFor } from "./helpers.js";

const dir = tmp();
const log = join(dir, "calls.log");
const sig = join(dir, "signals.log");
Object.assign(process.env, {
  CLAUDE_BIN: FAKE_CLAUDE,
  FAKE_CLAUDE_OUT: claudeOutput({ answer: "a", confidence: "low", findings: [], sources: [], gaps: [] }),
  FAKE_CLAUDE_LOG: log,
  FAKE_CLAUDE_SIGNAL_LOG: sig,
  FAKE_CLAUDE_SLEEP_MS: "3000",
  WEB_MCP_CONCURRENCY: "1",
  WEB_MCP_QUEUE: "1",
});
const { runClaude } = await import("../src/claude.js");
const opts = { system: "s", prompt: "p", schema: "{}", tools: [], maxTurns: 3, timeoutMs: 10_000 };

test("cancelling a running call stops claude at once", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const call = runClaude({ ...opts, signal: ac.signal });
  await waitFor(() => readLog(log).length === 1, 3000, "claude to start");
  ac.abort();
  await assert.rejects(call, { code: "cancelled" });
  assert.ok(Date.now() - t0 < 2000);
  await waitFor(() => lines(sig).length === 1, 3000, "SIGTERM");
});

test("the queue is capped, and a call cancelled while waiting never starts claude", async () => {
  const before = readLog(log).length;
  const holder = new AbortController();
  const first = runClaude({ ...opts, signal: holder.signal });
  await waitFor(() => readLog(log).length === before + 1, 3000, "first call to start");
  const waiter = new AbortController();
  const second = runClaude({ ...opts, signal: waiter.signal });
  await assert.rejects(runClaude(opts), { code: "busy" });
  waiter.abort();
  await assert.rejects(second, { code: "cancelled" });
  holder.abort();
  await assert.rejects(first, { code: "cancelled" });
  await sleep(100);
  assert.equal(readLog(log).length, before + 1); // only the first call ever ran
});

test("time spent waiting for a slot counts against the timeout", async () => {
  const holder = new AbortController();
  const first = runClaude({ ...opts, signal: holder.signal });
  const t0 = Date.now();
  await assert.rejects(runClaude({ ...opts, timeoutMs: 300 }), { code: "timeout", message: /No free slot within/ });
  assert.ok(Date.now() - t0 < 1500);
  holder.abort();
  await assert.rejects(first, { code: "cancelled" });
});

test("slots are released after cancellations: a normal call still runs", async () => {
  process.env.FAKE_CLAUDE_SLEEP_MS = "0";
  const r = await runClaude(opts);
  assert.equal(r.output.answer, "a");
});

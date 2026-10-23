// The only Claude integration: the unmodified `claude` binary in print mode, on the operator's own sign-in.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_RESULT, type ModelResult, ToolError } from "./contract.js";
import { limiter, QueueFull } from "./limit.js";

// Nesting markers (a stdio MCP server inherits them from Claude Code) and API keys (subscription only: never bill the API).
const STRIP = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e = { ...env };
  for (const k of STRIP) delete e[k];
  return e;
}

const bin = () => process.env.CLAUDE_BIN || "claude";
const envInt = (name: string, fallback: number, min: number) => {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v >= min ? v : fallback;
};
// Every run spends the operator's subscription, so concurrency is small and the wait queue is bounded.
const run = limiter(envInt("WEB_MCP_CONCURRENCY", 2, 1), envInt("WEB_MCP_QUEUE", 8, 0));

export interface RunOptions {
  system: string;
  prompt: string;
  /** JSON schema the result must satisfy (see modelResultSchema). */
  schema: string;
  /** Built-in tools to allow; empty for a no-tools run. */
  tools: string[];
  maxTurns: number;
  /** Total time allowed, counted from the call: waiting for a slot uses it up too. */
  timeoutMs: number;
  /** The caller's cancellation; aborting removes a waiting run or kills a running one. */
  signal?: AbortSignal;
}
export interface RunResult {
  output: ModelResult;
  queries: string[];
  pages: string[];
  model: string;
}

export function claudeArgs(o: RunOptions): string[] {
  return [
    "-p",
    "--model",
    process.env.WEB_MCP_MODEL || "haiku",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    o.schema,
    "--system-prompt",
    o.system,
    "--max-turns",
    String(o.maxTurns),
    "--permission-prompts",
    "none",
    "--tools",
    o.tools.join(","),
    // --tools only makes tools available; without pre-approval --permission-prompts none denies them.
    ...(o.tools.length ? ["--allowed-tools", o.tools.join(",")] : []),
    // No user settings, hooks, plugins, MCP servers, slash commands or session files: only the tools above.
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--exclude-dynamic-system-prompt-sections",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

const NO_RESULT = "Claude ended without a result";

/** The parts of Claude Code's stream-json events this server reads. */
interface StreamEvent {
  type?: string;
  message?: { content?: unknown };
}
interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: { query?: unknown; url?: unknown };
  tool_use_id?: string;
  is_error?: boolean;
}
interface ResultEvent extends StreamEvent {
  result?: unknown;
  is_error?: boolean;
  subtype?: string;
  terminal_reason?: string;
  api_error_status?: number;
  structured_output?: unknown;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
}
const blocks = (e: StreamEvent): ContentBlock[] => (Array.isArray(e.message?.content) ? e.message.content : []);

/** Read the stream-json events: real tool calls for meta, and the final result. */
export function parseStream(stdout: string): RunResult {
  const calls = new Map<string, { name: string; arg: string }>();
  const ok = new Set<string>();
  let result: ResultEvent | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let e: ResultEvent;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "assistant") {
      for (const b of blocks(e)) {
        if (b.type !== "tool_use") continue;
        if (!b.id) continue;
        if (b.name === "WebSearch" && b.input?.query) calls.set(b.id, { name: b.name, arg: String(b.input.query) });
        if (b.name === "WebFetch" && b.input?.url) calls.set(b.id, { name: b.name, arg: String(b.input.url) });
      }
    } else if (e.type === "user") {
      for (const b of blocks(e)) {
        if (b?.type === "tool_result" && b.is_error !== true && b.tool_use_id) ok.add(b.tool_use_id);
      }
    } else if (e.type === "result") result = e;
  }
  // Count only calls that ran (a denied or failed call has an error result).
  const ran = [...calls].filter(([id]) => ok.has(id)).map(([, c]) => c);
  const queries = ran.filter((c) => c.name === "WebSearch").map((c) => c.arg);
  const pages = ran.filter((c) => c.name === "WebFetch").map((c) => c.arg);
  if (result?.permission_denials?.length) console.error(`[web-mcp] claude denied ${result.permission_denials.length} tool calls`);
  if (!result) throw new ToolError("bad_output", NO_RESULT);
  if (result.is_error || result.structured_output === undefined) {
    // Classify failures only: a successful answer may well mention limits or authentication.
    const text = String(result.result ?? "");
    if (result.api_error_status === 429 || /usage limit|rate limit/i.test(text))
      throw new ToolError("rate_limited", "The Claude subscription limit was reached", "Try again after the limit resets");
    if (/not logged in|please run \/login|invalid api key|oauth token/i.test(text))
      throw new ToolError("claude_not_signed_in", "Claude Code is not signed in", "Run `claude` once and sign in");
    const why = String(result.terminal_reason ?? result.subtype ?? "");
    throw new ToolError(
      "bad_output",
      `Claude returned no structured result (${why || "unknown reason"})`,
      /turn/i.test(why) ? "Ask a narrower question or use more depth" : undefined,
    );
  }
  const parsed = MODEL_RESULT.safeParse(result.structured_output);
  if (!parsed.success) throw new ToolError("bad_output", "Claude's result did not match the schema");
  return { output: parsed.data, queries, pages, model: Object.keys(result.modelUsage ?? {})[0] ?? "haiku" };
}

const cancelled = () => new ToolError("cancelled", "The caller cancelled the request");

export async function runClaude(o: RunOptions): Promise<RunResult> {
  const deadline = Date.now() + o.timeoutMs;
  const wait = AbortSignal.any([AbortSignal.timeout(o.timeoutMs), ...(o.signal ? [o.signal] : [])]);
  try {
    return await run(() => spawnClaude(o, deadline), wait);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (e instanceof QueueFull) throw new ToolError("busy", `Too many research calls at once: ${e.message}`, "Try again shortly");
    if (o.signal?.aborted) throw cancelled();
    if (wait.aborted)
      throw new ToolError("timeout", `No free slot within ${Math.round(o.timeoutMs / 1000)} s`, "The server is busy; try again shortly");
    throw e;
  }
}

async function spawnClaude(o: RunOptions, deadline: number): Promise<RunResult> {
  if (o.signal?.aborted) throw cancelled();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ToolError("timeout", "No time left after waiting for a free slot", "The server is busy; try again shortly");
  const cwd = await mkdtemp(join(tmpdir(), "web-mcp-")); // empty: no project CLAUDE.md or .mcp.json
  try {
    let stderr = "";
    const stdout = await new Promise<string>((resolve, reject) => {
      const p = spawn(bin(), claudeArgs(o), { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const stop = (e: ToolError) => {
        p.kill("SIGTERM");
        reject(e);
      };
      const onAbort = () => stop(cancelled());
      const timer = setTimeout(
        () =>
          stop(
            new ToolError(
              "timeout",
              `Research took longer than ${Math.round(o.timeoutMs / 1000)} s`,
              "Ask a narrower question or use less depth",
            ),
          ),
        remaining,
      );
      o.signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      };
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e: NodeJS.ErrnoException) => {
        done();
        reject(
          e.code === "ENOENT"
            ? new ToolError("no_backend", "The claude command was not found", "Install Claude Code, or set CLAUDE_BIN")
            : e,
        );
      });
      p.on("close", () => {
        done();
        stderr = err.trim();
        if (stderr) console.error(`[web-mcp] claude stderr: ${stderr.slice(0, 500)}`);
        resolve(out);
      });
      p.stdin.on("error", () => {}); // the child may exit before reading stdin; its exit is handled above
      p.stdin.end(o.prompt);
    });
    try {
      return parseStream(stdout);
    } catch (e) {
      if (e instanceof ToolError && e.message === NO_RESULT && stderr)
        throw new ToolError("bad_output", `claude failed: ${(stderr.split("\n")[0] ?? "").slice(0, 200)}`);
      throw e;
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

let signedIn = false;
/** True once `claude auth status` reports a sign-in; rechecked on every call until it does. Never reads tokens. */
export async function checkSignedIn(): Promise<void> {
  if (signedIn) return;
  const out = await new Promise<string>((resolve) =>
    execFile(bin(), ["auth", "status", "--json"], { env: childEnv(), timeout: 15_000 }, (e, stdout) => resolve(e ? "" : stdout)),
  );
  try {
    signedIn = JSON.parse(out).loggedIn === true;
  } catch {
    signedIn = false;
  }
  if (!signedIn)
    throw new ToolError(
      "claude_not_signed_in",
      "Claude Code is not signed in, or the claude command is missing",
      "Run `claude` once and sign in, or set CLAUDE_BIN",
    );
}

// Shared test helpers: fake claude output files and a scripted global fetch.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FAKE_CLAUDE = fileURLToPath(new URL("../../test/fixtures/fake-claude.mjs", import.meta.url));
export const fixture = (f: string) => readFileSync(new URL(`../../test/fixtures/${f}`, import.meta.url), "utf8");
export const tmp = (prefix = "wr-test-") => mkdtempSync(join(tmpdir(), prefix));

/** Write a stream-json transcript whose result carries `output` as structured output; returns its path. */
export function claudeOutput(output: unknown, tools: { name: string; input: object; error?: boolean }[] = []): string {
  const lines: object[] = [{ type: "system", subtype: "init" }];
  tools.forEach((t, i) => {
    lines.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: t.name, input: t.input }] } });
    lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: t.error, content: "x" }] } });
  });
  lines.push({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    modelUsage: { "claude-haiku-5-5": {} },
    structured_output: output,
  });
  const p = join(tmp("wr-out-"), "out.jsonl");
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return p;
}

export const readLog = (p: string): any[] => {
  try {
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
/** Replace global fetch with `route`; records every URL requested. Call `restore()` when done. */
export function stubFetch(route: Route) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.href);
    return route(url, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` is true, or fail after `ms`. */
export async function waitFor(check: () => boolean, ms = 3000, what = "condition") {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

export const lines = (p: string): string[] => {
  try {
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

export const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

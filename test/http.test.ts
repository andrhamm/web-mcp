// The entry point as a process: HTTP transport, its guards, and the command-line flags.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { FAKE_CLAUDE, tmp } from "./helpers.js";

const ENTRY = fileURLToPath(new URL("../src/index.js", import.meta.url));
const baseEnv = () => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  CLAUDE_BIN: FAKE_CLAUDE,
  WEB_MCP_CACHE_DIR: join(tmp(), "c"),
});
const port = () => 20000 + Math.floor(Math.random() * 20000);

/** Start the server; resolves once it listens, or with its exit code and stderr if it exits first. */
function start(args: string[], env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [ENTRY, ...args], { env: { ...baseEnv(), ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  const ready = new Promise<{ code: number | null; err: string }>((resolve) => {
    p.stderr.on("data", (d) => {
      err += d;
      if (err.includes("listening on")) resolve({ code: null, err });
    });
    p.on("exit", (code) => resolve({ code, err }));
  });
  return { p, ready };
}

const raw = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    const r = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    r.on("error", reject);
    r.end("{}");
  });

async function tools(transport: StdioClientTransport | StreamableHTTPClientTransport) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(transport);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  await c.close();
  return names;
}

test("loopback HTTP serves /mcp only, and only to localhost Host headers", async () => {
  const n = port();
  const s = start(["--http", `127.0.0.1:${n}`]);
  try {
    assert.equal((await s.ready).code, null);
    assert.equal((await tools(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${n}/mcp`)))).length, 5);
    assert.equal(await raw(n, "/other"), 404);
    assert.equal(await raw(n, "/mcp", { host: "evil.example" }), 403);
    assert.equal(await raw(n, "/mcp", { origin: "https://evil.example" }), 403);
  } finally {
    s.p.kill();
  }
});

test("with a token, requests need the bearer header", async () => {
  const n = port();
  const s = start(["--http", String(n)], { WEB_MCP_HTTP_TOKEN: "sekret" });
  try {
    assert.equal((await s.ready).code, null);
    assert.equal(await raw(n, "/mcp"), 401);
    assert.equal(await raw(n, "/mcp", { authorization: "Bearer wrong" }), 401);
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${n}/mcp`), {
      requestInit: { headers: { authorization: "Bearer sekret" } },
    });
    assert.equal((await tools(t)).length, 5);
  } finally {
    s.p.kill();
  }
});

test("refuses a non-loopback address without a token", async () => {
  const { code, err } = await start(["--http", `0.0.0.0:${port()}`]).ready;
  assert.equal(code, 2);
  assert.match(err, /Refusing to listen on 0\.0\.0\.0 without WEB_MCP_HTTP_TOKEN/);
});

test("--tiers limits the tools; unknown tiers and --help exit cleanly", async () => {
  const stdio = (args: string[], env: Record<string, string> = {}) =>
    new StdioClientTransport({ command: process.execPath, args: [ENTRY, ...args], env: { ...baseEnv(), ...env } });
  assert.deepEqual(await tools(stdio(["--tiers", "basic"])), ["web_lookup", "web_read"]);
  assert.deepEqual(await tools(stdio(["--tiers", "advanced"], { BRAVE_API_KEY: "k" })), ["web_investigate", "web_search"]);
  assert.equal((await start(["--tiers", "basic,bogus"]).ready).code, 2);
  assert.equal((await start(["--help"]).ready).code, 0);
});

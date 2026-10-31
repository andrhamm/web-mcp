// Spawns the built server over stdio with a fake `claude` and checks the six tools end to end, without network.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
let client: Client;
let log: string;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), "wr-e2e-"));
  log = join(dir, "claude.log");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CLAUDE_BIN: here("../../test/fixtures/fake-claude.mjs"),
    FAKE_CLAUDE_OUT: here("../../test/fixtures/stream.jsonl"),
    FAKE_CLAUDE_LOG: log,
    WEB_MCP_CACHE_DIR: join(dir, "cache"),
    CLAUDECODE: "1",
    ANTHROPIC_API_KEY: "must-not-reach-claude",
  };
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [here("../src/index.js")], env }));
});
after(() => client?.close());

test("lists the tiered tools with read-only annotations (no web_search without a Brave key)", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["web_investigate", "web_lookup", "web_page", "web_read", "web_research"]);
  const lookup = tools.find((t) => t.name === "web_lookup")!;
  assert.equal(lookup.annotations?.readOnlyHint, true);
  assert.deepEqual(Object.keys((lookup.inputSchema as { properties: object }).properties).sort(), ["max_tokens", "question"]);
});

test("web_research returns markdown within the cap, real tool counts, and caches the answer", async () => {
  const args = { question: "How tall is the Eiffel Tower?", goal: "Cite the height", max_tokens: 400 };
  const r1: any = await client.callTool({ name: "web_research", arguments: args });
  assert.equal(r1.isError, undefined, r1.content[0].text);
  const text: string = r1.content[0].text;
  assert.match(text, /^Answer: The Eiffel Tower is 330 m tall \[1\]\./);
  assert.match(text, /meta: claude-haiku-5-5, searches 1, pages 1, verified 0\/2, claude 17\.2k in 916 out ~\$0\.023, cached no/);
  assert.match(text, /\nSources\n\[1\] Eiffel Tower facts\. https:\/\/example.org\/eiffel\n\nmeta/); // duplicate URL merged
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].claudecode, null);
  assert.equal(calls[0].apiKey, null);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("--tools"), calls[0].args.indexOf("--tools") + 2), [
    "--tools",
    "WebSearch,WebFetch",
  ]);
  assert.match(calls[0].stdin, /Question: How tall is the Eiffel Tower\?\nGoal: Cite the height/);
  const r2: any = await client.callTool({ name: "web_research", arguments: args });
  assert.match(r2.content[0].text, /cached yes/);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
});

test("web_lookup gives the basic rendering; format json gives the contract", async () => {
  const basic: any = await client.callTool({ name: "web_lookup", arguments: { question: "How tall is the Eiffel Tower?" } });
  assert.doesNotMatch(basic.content[0].text, /Findings|Confidence/);
  const json: any = await client.callTool({
    name: "web_research",
    arguments: { question: "Eiffel height?", goal: "json check", format: "json" },
  });
  const obj = JSON.parse(json.content[0].text);
  assert.equal(obj.findings[0].source, 0);
  assert.equal(obj.meta.confidence, "high");
});

test("web_page refuses private addresses with a coded error", async () => {
  const r: any = await client.callTool({ name: "web_page", arguments: { url: "http://127.0.0.1:9/x", goal: "anything" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^blocked_url: /);
});

test("invalid input is rejected by the schema", async () => {
  const r: any = await client
    .callTool({ name: "web_research", arguments: { question: "x", goal: "y", max_tokens: 5 } })
    .catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal(r.isError, true);
});

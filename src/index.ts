#!/usr/bin/env node
import { createServer } from "node:http";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer, TIERS, type Tier, VERSION } from "./server.js";

const USAGE = `web-mcp ${VERSION}
Usage: web-mcp [--http [host:]port] [--tiers basic,standard,advanced,direct]
  --http    serve Streamable HTTP at /mcp instead of stdio (default host 127.0.0.1)
  --tiers   which tool tiers to expose (default: all)
Environment: BRAVE_API_KEY or BRAVE_API_KEY_FILE, CLAUDE_BIN, WEB_MCP_CACHE_DIR,
  WEB_MCP_CONCURRENCY, WEB_MCP_MODEL, WEB_MCP_HTTP_TOKEN`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? "") : undefined;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.error(USAGE);
  process.exit(0);
}

const tierArg = arg("--tiers");
const tiers = new Set<Tier>(tierArg ? (tierArg.split(",").map((t) => t.trim()) as Tier[]) : TIERS);
for (const t of tiers) {
  if (!TIERS.includes(t)) {
    console.error(`Unknown tier "${t}". ${USAGE}`);
    process.exit(2);
  }
}
const factory = (ctx: { requestInfo?: Request }) => buildServer(tiers, ctx.requestInfo?.signal);

const http = arg("--http");
if (http === undefined) {
  serveStdio(factory, { onerror: (e) => console.error(`[web-mcp] ${e.message}`) });
} else {
  const [host, port] = http.includes(":")
    ? [http.slice(0, http.lastIndexOf(":")), http.slice(http.lastIndexOf(":") + 1)]
    : ["127.0.0.1", http];
  const token = process.env.WEB_MCP_HTTP_TOKEN;
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
  if (!loopback && !token) {
    console.error(`Refusing to listen on ${host} without WEB_MCP_HTTP_TOKEN: the server spends your Claude subscription.`);
    process.exit(2);
  }
  // A runtime that notices a dropped client only on its next write would otherwise keep a cancelled run going up to the
  // SDK's 15 s default keep-alive; at 2 s an abandoned Claude run stops within about 2 s.
  const handle = toNodeHandler(createMcpHandler(factory, { keepAliveMs: 2000 }));
  const validHost = localhostHostValidation();
  const validOrigin = localhostOriginValidation();
  createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (token) {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end();
        return;
      }
    } else if (!validHost(req, res) || !validOrigin(req, res)) return; // DNS-rebinding guard for tokenless loopback use
    void handle(req, res);
  }).listen(Number(port), host, () => console.error(`[web-mcp] ${VERSION} listening on http://${host}:${port}/mcp`));
}

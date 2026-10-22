import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { braveKey, braveSearch, renderHits } from "./brave.js";
import { INVESTIGATE_INPUT, LOOKUP_INPUT, PAGE_INPUT, READ_INPUT, RESEARCH_INPUT, SEARCH_INPUT, ToolError } from "./contract.js";
import { readPage, research } from "./research.js";

export const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export type Tier = "basic" | "standard" | "advanced";
export const TIERS: Tier[] = ["basic", "standard", "advanced"];

const annotations = { readOnlyHint: true, openWorldHint: true, idempotentHint: true, destructiveHint: false };

async function reply(fn: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await fn() }] };
  } catch (e) {
    const text =
      e instanceof ToolError ? `${e.code}: ${e.message}${e.hint ? `. ${e.hint}` : ""}` : `internal_error: ${(e as Error).message}`;
    if (!(e instanceof ToolError)) console.error(`[web-mcp] ${(e as Error).stack}`);
    return { content: [{ type: "text" as const, text }], isError: true };
  }
}

export function buildServer(tiers: Set<Tier>): McpServer {
  const s = new McpServer({ name: "web-mcp", version: VERSION });

  if (tiers.has("basic")) {
    s.registerTool(
      "web_lookup",
      {
        title: "Look up on the web",
        description:
          "Answer a question from the web. Returns a short answer with numbered sources. Use it for facts you do not know or that may have changed.",
        inputSchema: LOOKUP_INPUT,
        annotations,
      },
      (a) => reply(() => research({ ...a, goal: "Answer the question directly.", depth: "quick", recency: "any", cache: "use" }, "basic")),
    );
    s.registerTool(
      "web_read",
      {
        title: "Read a web page",
        description: "Read one web page and say briefly what it says, with the source. Give a question to get only that part.",
        inputSchema: READ_INPUT,
        annotations,
      },
      (a) =>
        reply(() =>
          readPage({ url: a.url, goal: a.question ?? "Summarize what the page says.", max_tokens: a.max_tokens, cache: "use" }, "basic"),
        ),
    );
  }

  if (tiers.has("standard")) {
    s.registerTool(
      "web_research",
      {
        title: "Research on the web",
        description:
          "Research a question on the web for a stated goal. Returns a compact answer, confidence, findings with short verbatim quotes, sources and gaps, never longer than max_tokens.",
        inputSchema: RESEARCH_INPUT,
        annotations,
      },
      (a) => reply(() => research({ ...a, depth: "quick", recency: "any", cache: "use" }, a.format)),
    );
    s.registerTool(
      "web_page",
      {
        title: "Read a web page for a goal",
        description:
          "Read one known web page for a stated goal. Returns a compact answer and findings with verbatim quotes checked against the page, never longer than max_tokens.",
        inputSchema: PAGE_INPUT,
        annotations,
      },
      (a) => reply(() => readPage({ ...a, cache: "use" }, a.format)),
    );
  }

  if (tiers.has("advanced")) {
    s.registerTool(
      "web_investigate",
      {
        title: "Investigate on the web",
        description:
          "Research with full control: depth (how many searches and page reads to spend), recency, domain filters and cache refresh. Same reply as web_research.",
        inputSchema: INVESTIGATE_INPUT,
        annotations,
      },
      (a) => reply(() => research(a, a.format)),
    );
    if (braveKey()) {
      s.registerTool(
        "web_search",
        {
          title: "Raw web search",
          description:
            "Brave web search: titles, URLs, snippets and dates, with no reading or summarizing. Fastest and cheapest; you choose what to read next.",
          inputSchema: SEARCH_INPUT,
          annotations,
        },
        (a) => reply(async () => renderHits(await braveSearch(a.query, a), 3) || "No results."),
      );
    }
  }
  return s;
}

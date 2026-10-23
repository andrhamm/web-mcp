// Tool inputs and the result shape. Consumers may copy this file to validate `format: "json"` replies.
import { z } from "zod";

export const MAX_TOKENS = z
  .number()
  .int()
  .min(50)
  .max(4000)
  .describe("Ceiling on the reply size in tokens. The reply is as short as the goal allows, never longer than this");
const QUESTION = z.string().trim().min(1).max(500).describe("The question to answer from the web");
const GOAL = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("What you will do with the answer; only what serves it is kept. Never put secrets here: it leaves the machine");
const URL_ = z.string().url().describe("The page to read");
const FORMAT = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("markdown (default, fewest tokens) or json (the result object, for code)");
const DEPTH = z.enum(["quick", "standard", "deep"]).default("quick").describe("How many searches and page reads it may spend");
const RECENCY = z
  .enum(["any", "day", "week", "month", "year"])
  .default("any")
  .describe("Prefer sources from this window. Exact for the Brave head start, best effort for other searches");
const DOMAINS = z
  .object({ include: z.array(z.string()).max(20).optional(), exclude: z.array(z.string()).max(20).optional() })
  .optional()
  .describe("Hosts to search only, or to leave out");
const CACHE = z.enum(["use", "refresh"]).default("use").describe("refresh: ignore cached answers and pages");

export const LOOKUP_INPUT = z.object({ question: QUESTION, max_tokens: MAX_TOKENS.default(300) });
export const READ_INPUT = z.object({
  url: URL_,
  question: z.string().trim().min(1).max(500).optional().describe("What you want from the page; omit for a summary"),
  max_tokens: MAX_TOKENS.default(300),
});
export const RESEARCH_INPUT = z.object({ question: QUESTION, goal: GOAL, max_tokens: MAX_TOKENS.default(400), format: FORMAT });
export const PAGE_INPUT = z.object({ url: URL_, goal: GOAL, max_tokens: MAX_TOKENS.default(400), format: FORMAT });
export const INVESTIGATE_INPUT = RESEARCH_INPUT.extend({ depth: DEPTH, recency: RECENCY, domains: DOMAINS, cache: CACHE });
export const SEARCH_INPUT = z.object({
  query: z.string().trim().min(1).max(400).describe("Search query"),
  count: z.number().int().min(1).max(20).default(8).describe("Number of results"),
  recency: RECENCY,
  domains: DOMAINS,
});

export type Depth = z.infer<typeof DEPTH>;
export type Recency = z.infer<typeof RECENCY>;
export type Domains = z.infer<typeof DOMAINS>;
export type Format = z.infer<typeof FORMAT>;

/** Length limits for one request; Claude Code validates the model's output against them and makes it retry when broken. */
export interface Limits {
  answerChars: number;
  findings: number;
}

function modelResult(l?: Limits) {
  const text = (max: number) => (l ? z.string().max(max) : z.string());
  return z.object({
    answer: text(l?.answerChars ?? 0),
    confidence: z.enum(["high", "medium", "low"]),
    findings: z
      .array(
        z.object({
          claim: text(200),
          source: z.number().int().min(1),
          quote: text(220).optional(),
          date: z.string().optional(),
        }),
      )
      .max(l ? l.findings : 50),
    sources: z.array(z.object({ url: z.string(), title: z.string(), published: z.string().optional() })).max(l ? l.findings + 3 : 50),
    gaps: z.array(text(160)).max(l ? 3 : 20),
  });
}

/** What the model returns. `source` is the 1-based position in `sources`, matching [n] markers in `answer`. Parsing is lenient. */
export const MODEL_RESULT = modelResult();
export type ModelResult = z.infer<typeof MODEL_RESULT>;

/** The JSON schema handed to `claude --json-schema` for one request, with its length limits. */
export function modelResultSchema(limits: Limits): string {
  // Claude Code's validator rejects the draft 2020-12 `$schema` stamp zod adds; the schema itself is plain draft-07 compatible.
  const { $schema: _drop, ...schema } = z.toJSONSchema(modelResult(limits));
  return JSON.stringify(schema);
}

export interface Meta {
  queries: string[];
  pages_read: number;
  cache_hits: number;
  backends: string[];
  elapsed_ms: number;
  model: string;
  confidence: "high" | "medium" | "low";
  cached: boolean;
  trimmed: boolean;
  /** Quotes in this reply that were checked against text the server holds and found there. */
  verified: number;
  head_start: boolean;
}
/** A finding whose quote the server found in text it holds carries `verified: true`. */
export type Finding = ModelResult["findings"][number] & { verified?: true };
export type Result = Omit<ModelResult, "confidence" | "findings"> & { findings: Finding[]; meta: Meta };

export class ToolError extends Error {
  constructor(
    readonly code:
      | "claude_not_signed_in"
      | "no_backend"
      | "rate_limited"
      | "busy"
      | "timeout"
      | "cancelled"
      | "fetch_failed"
      | "blocked_url"
      | "bad_output",
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

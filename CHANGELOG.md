# Changelog

## 0.2.0 (2026-10-31)

- New `web_extract` tool in a new `direct` tier: one page's own passages that match a goal, in page order, cut to `max_tokens`, inside data markers with a random id per call. No model step and no sign-in. Meant for callers that read well themselves.
- `web_search` moves from the advanced tier to the direct tier, since it also has no model step.
- All page text is cleaned before anything reads it: elements hidden by inline styles or attributes are dropped, and invisible characters (zero-width, bidi controls, Unicode tags, variation selectors) are removed. The page cache key changed, so pages cached before this version are fetched again.

- The meta line and `meta.usage` report what each reply's Claude run used: tokens by kind and Claude Code's cost estimate.
- A call refused as `busy` no longer spends a Brave request: the head start now runs inside the Claude slot.
- Trimming no longer strips the only source from an answer that cites none with `[n]`.
- Gaps describe what is missing about the subject, not the model's notes on its own process or quotes.
- HTTP event streams send a keep-alive every 2 seconds (was 15), bounding how long an abandoned run can continue on a runtime that notices dropped clients late.

## 0.1.0 (2026-10-31)

- Six tools in three tiers: `web_lookup` and `web_read` (basic), `web_research` and `web_page` (standard), `web_investigate` and `web_search` (advanced).
- Research runs as one headless Claude Haiku session with WebSearch and WebFetch, with an optional Brave Search head start.
- Replies are compact markdown sized to `max_tokens`, enforced by per-request schema length limits and a trimming safety net, with an optional `format: "json"`.
- Flat-file cache for answers and fetched pages; Brave results are held in memory only.
- stdio and Streamable HTTP transports.
- Bounded wait queue (`WEB_MCP_QUEUE`, error `busy`); each call's time budget includes waiting.
- Cancelling a call, or closing its connection, stops its Claude run (error `cancelled`).
- Brave queries are cut to Brave's 75-word limit; a rejected query no longer switches Brave off.
- A timeout while a page body downloads reports `timeout`; other body read failures report `fetch_failed`.
- Pages are decoded with the charset from the Content-Type header or a `<meta>` tag, falling back to UTF-8.
- A stopped Claude run that ignores SIGTERM is killed after 3 seconds.

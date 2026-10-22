# Changelog

## 0.1.0 (unreleased)

- Six tools in three tiers: `web_lookup` and `web_read` (basic), `web_research` and `web_page` (standard), `web_investigate` and `web_search` (advanced).
- Research runs as one headless Claude Haiku session with WebSearch and WebFetch, with an optional Brave Search head start.
- Replies are compact markdown sized to `max_tokens`, enforced by per-request schema length limits and a trimming safety net, with an optional `format: "json"`.
- Flat-file cache for answers and fetched pages; Brave results are held in memory only.
- stdio and Streamable HTTP transports.

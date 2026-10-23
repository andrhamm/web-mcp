# web-mcp

A local MCP server that answers web research questions for agents and returns the smallest useful reply: a direct answer, short verbatim quotes, numbered sources and what it could not find, never longer than the token cap the caller sets.

It exists so that small local models (and agents in a network sandbox) can use the web without spending their context on search result pages. A Claude Haiku session does the searching, reading and filtering on your own Claude subscription, through the Claude Code command line you are already signed in to. No API keys are needed. A Brave Search API key is optional and gives each research run a head start.

## Requirements

- Node.js 22 or newer.
- [Claude Code](https://code.claude.com/docs) installed and signed in with a Claude subscription. The server runs the unmodified `claude` command; it never reads or stores your credentials.
- Optional: a [Brave Search API](https://brave.com/search/api/) key, in `BRAVE_API_KEY` or in a file named by `BRAVE_API_KEY_FILE`.

## Install

Not yet published to npm. Until then, build from a clone:

```bash
npm install
npm run build
```

Claude Code:

```bash
claude mcp add --transport stdio web -- node <clone>/dist/src/index.js
```

pi coding agent:

```bash
pi mcp add web -- node <clone>/dist/src/index.js
```

LM Studio and other clients that use an `mcp.json` file:

```json
{
  "mcpServers": {
    "web": { "command": "node", "args": ["<clone>/dist/src/index.js"], "env": { "BRAVE_API_KEY": "<your key>" } }
  }
}
```

### Sandboxed agents (HTTP)

An agent in a sandbox has no Claude sign-in, so run the server on the host and let the sandbox reach it over HTTP:

```bash
node dist/src/index.js --http 127.0.0.1:7343
claude mcp add --transport http web http://127.0.0.1:7343/mcp
```

On loopback without a token, the server accepts only localhost `Host` and `Origin` headers. To listen on any other address you must set `WEB_MCP_HTTP_TOKEN`; clients then send `Authorization: Bearer <token>`. One HTTP process also shares one concurrency limit across all its callers.

## Tools

Tools come in three tiers, so each agent role can be given only the tools it can use well. Allow-list them by name in your client, or start the server with `--tiers basic` (or `basic,standard`) to hide the rest.

| Tier | Tool | Inputs | Use |
|---|---|---|---|
| basic | `web_lookup` | `question`, `max_tokens` (optional, default 300) | Answer a question from the web. |
| basic | `web_read` | `url`, `question` (optional), `max_tokens` (optional, default 300) | Say briefly what one page says. |
| standard | `web_research` | `question`, `goal`, `max_tokens` (default 400), `format` | Research for a stated goal; full reply with findings and quotes. |
| standard | `web_page` | `url`, `goal`, `max_tokens`, `format` | Read one known page for a goal; quotes checked against the page. |
| advanced | `web_investigate` | `web_research` inputs plus `depth`, `recency`, `domains`, `cache` | Research with control over effort, freshness and sources. |
| advanced | `web_search` | `query`, `count`, `recency`, `domains` | Raw Brave results: titles, URLs, snippets, dates. Listed only when a Brave key is set. |

`goal` is what the caller will do with the answer. The server keeps only what serves it, so a good goal makes a short reply. It is sent to Claude and to the web, so never put secrets in it.

`max_tokens` (50 to 4000) is a ceiling, not a target. Haiku is asked for the shortest reply that serves the goal. If it still runs over, the server drops the least important findings first, then quotes, then gaps, then trailing sentences, and marks the reply `trimmed yes`. Tokens are estimated with an o200k count times 1.3, which tracks Claude's tokenizer on prose and runs low on code.

`depth` sets the effort: `quick` allows 2 searches and 3 page reads, `standard` 4 and 6, `deep` 8 and 12. Each call has a time budget (90, 180 or 300 seconds; 90 for page tools) counted from when it arrives, so time spent waiting for a free slot uses it up too.

## Replies

Replies are compact markdown, because for this kind of content it costs fewer tokens than JSON and every model reads it well:

```
Answer: Send the key in the `X-Subscription-Token` header [1].
Confidence: high

Findings
- Every request must include the API key in this header. [1] "All requests to the Brave Search API must include an API key in the X-Subscription-Token HTTP header."

Sources
[1] Authentication. https://api-dashboard.search.brave.com/documentation/guides/authentication

Gaps
- Rate limits for the free credit were not checked.

meta: claude-haiku-5-5, searches 0, pages 0, brave, verified 1/1, cached no, trimmed no, 7.5 s
```

The basic tools return only the answer, the sources and a `Not found:` line. Standard and advanced tools accept `format: "json"` for code that wants to parse the reply; the object matches `src/contract.ts`, with `findings[].source` as a 0-based index into `sources` and `findings[].verified: true` on quotes the server checked. The server does not send MCP structured content, because some clients show that to the model instead of the text.

`verified n/m` means n of the m quotes in the reply were checked word for word against page text the server holds: the page itself for `web_read` and `web_page`, and the Brave snippets for research runs. A quote that fails the check is removed and its claim kept, so the other m minus n quotes were not checked: they come from pages Haiku read through WebFetch, whose text the server never sees.

Errors come back as tool errors with a code first: `claude_not_signed_in`, `no_backend`, `rate_limited`, `busy`, `timeout`, `cancelled`, `fetch_failed`, `blocked_url`, `bad_output`.

## How it works

Each research call is one headless `claude -p` run on Haiku with only the WebSearch and WebFetch tools. Haiku splits the question into the parts the goal needs, searches, reads the most promising pages, checks after each read whether every part is backed by a quote, and stops when it is, or when the depth caps are reached. It then fills a JSON structure whose schema carries length limits sized to `max_tokens` (answer length, number of findings, quote and gap length). Claude Code rejects output that breaks them and Haiku rewrites it, which keeps most replies inside the cap without trimming. The server then renders, verifies, trims if still needed, and caches.

With a Brave key, the server first runs one Brave web search and gives Haiku the results and snippets as a head start, so simple questions often need no further searching. Each uncached research call spends one Brave request, and each `web_search` call spends one. Page tools spend none. Brave accepts at most 75 words per query, so long questions are cut to fit. If Brave rejects a query, only that call loses its head start; only a key or plan error switches Brave off until restart.

Page tools fetch the page directly (public addresses only, 2 MB, 20 seconds), extract the main text with Mozilla Readability, convert it to compact markdown, keep the passages that match the goal, and give those to Haiku with no tools.

The Claude run is isolated from your own Claude Code setup: no user or project settings, hooks, plugins, MCP servers or slash commands, an empty working directory, and no saved session. `ANTHROPIC_API_KEY` is removed from its environment so it always uses the subscription and never bills the API.

## Cancellation

When a caller cancels a call, or drops its connection, the server removes it from the wait queue or stops its Claude run at once, so no subscription usage is spent on an answer nobody will read. Over stdio this works for any client. Over HTTP it works when the client closes the request's connection, as clients on the 2026-07-28 protocol do. Clients on the older 2025 protocol cancel with a separate message that a stateless HTTP server cannot match to the call, so their abandoned runs stop at the time budget instead.

## Cache

Answers and fetched pages are cached as small JSON files in `WEB_MCP_CACHE_DIR`, or the platform cache directory under `web-mcp` (`~/Library/Caches` on macOS, `XDG_CACHE_HOME` or `~/.cache` on Linux, `LOCALAPPDATA` on Windows).

| Entry | Lifetime |
|---|---|
| Research answer, recency `day` | 1 hour |
| `week` | 6 hours |
| `month` | 1 day |
| `year` | 3 days |
| `any` | 7 days |
| Page text and page answers | 1 day |
| Brave results | 10 minutes, in memory only |

Brave's API terms allow only transient storage of search results, so they are never written to disk. `cache: "refresh"` on `web_investigate` ignores cached answers and pages.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BRAVE_API_KEY`, `BRAVE_API_KEY_FILE` | unset | Brave key, or a file holding it. Enables the head start and `web_search`. |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code command. |
| `WEB_MCP_MODEL` | `haiku` | Model alias or id passed to `claude --model`. |
| `WEB_MCP_CONCURRENCY` | 2 | Claude runs at once; the rest wait in order. |
| `WEB_MCP_QUEUE` | 8 | Calls allowed to wait for a slot; beyond that a call fails at once with `busy`. |
| `WEB_MCP_CACHE_DIR` | platform cache dir | Where cached answers and pages live. |
| `WEB_MCP_HTTP_TOKEN` | unset | Bearer token for `--http`; required off loopback. |

Logs go to stderr only.

## Use of your Claude subscription

Every uncached call runs Claude Code under your own sign-in and counts toward your plan's usage limits. Run this server for your own agents. Do not offer it to other people as a shared Claude backend: Anthropic's terms allow ordinary individual use of Claude Code with your own subscription, not reselling access to it.

## Limits

- Pages that render their content with JavaScript come back thin; there is no headless browser.
- Page tools do not consult `robots.txt`.
- `recency` is exact for the Brave head start and best effort for Claude's own searches.
- The token estimate is approximate; set `max_tokens` with some margin if a hard limit matters.

## Development

```bash
npm test
```

Tests run against a fake `claude` command and need no network or sign-in.

## License

MIT

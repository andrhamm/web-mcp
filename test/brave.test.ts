// Brave module against a scripted fetch. Order matters: the last test disables Brave for this process.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { braveAvailable, braveKey, braveSearch, renderHits } from "../src/brave.js";
import { json, stubFetch, tmp } from "./helpers.js";

process.env.BRAVE_API_KEY = "test-key";
let stub: ReturnType<typeof stubFetch> | undefined;
afterEach(() => stub?.restore());

const RESULTS = {
  web: {
    results: [
      {
        title: "Widget &amp; <strong>Co</strong>",
        url: "https://a.example/w",
        description: "It&#x27;s <strong>fast</strong>",
        extra_snippets: ["More &quot;detail&quot;"],
        page_age: "2026-10-14T09:00:00",
      },
      { title: "Second", url: "https://b.example/", description: "Plain" },
    ],
  },
};

test("key comes from BRAVE_API_KEY, else from BRAVE_API_KEY_FILE", () => {
  const f = join(tmp(), "key");
  writeFileSync(f, "  from-file\n");
  assert.equal(braveKey({ BRAVE_API_KEY: " direct " }), "direct");
  assert.equal(braveKey({ BRAVE_API_KEY_FILE: f }), "from-file");
  assert.equal(braveKey({ BRAVE_API_KEY_FILE: join(tmp(), "missing") }), undefined);
  assert.equal(braveKey({}), undefined);
});

test("parses results, cleans markup, maps freshness and sites, sends the key header", async () => {
  let headers: Headers | undefined;
  stub = stubFetch((_u, init) => {
    headers = new Headers(init?.headers);
    return json(RESULTS);
  });
  const hits = await braveSearch("widget", { count: 5, recency: "week", domains: { include: ["a.example"] } });
  assert.deepEqual(hits[0]!, {
    url: "https://a.example/w",
    title: "Widget & Co",
    snippets: ["It's fast", 'More "detail"'],
    published: "2026-10-14",
  });
  assert.equal(hits[1]!.published, undefined);
  const u = new URL(stub.calls[0]!);
  assert.equal(u.searchParams.get("q"), "widget site:a.example");
  assert.equal(u.searchParams.get("freshness"), "pw");
  assert.equal(u.searchParams.get("extra_snippets"), "true");
  assert.equal(u.searchParams.get("count"), "5");
  assert.equal(headers?.get("x-subscription-token"), "test-key");
});

test("identical searches within ten minutes are served from memory", async () => {
  stub = stubFetch(() => json(RESULTS));
  await braveSearch("cached query", { count: 3 });
  await braveSearch("cached query", { count: 3 });
  assert.equal(stub.calls.length, 1);
  assert.equal(new URL(stub.calls[0]!).searchParams.has("freshness"), false);
});

test("rate limits and server errors are coded and leave Brave on", async () => {
  stub = stubFetch(() => json({}, 429));
  await assert.rejects(braveSearch("q429", { count: 3 }), { code: "rate_limited" });
  stub.restore();
  stub = stubFetch(() => json({}, 500));
  await assert.rejects(braveSearch("q500", { count: 3 }), { code: "fetch_failed" });
  assert.equal(braveAvailable(), true);
});

test("renderHits numbers results and limits snippets", () => {
  const text = renderHits(
    [{ url: "https://a.example", title: "A", snippets: ["one", "two", "three", "four"], published: "2026-01-02" }],
    2,
  );
  assert.equal(text, "[1] A. https://a.example (2026-01-02)\n  one\n  two");
});

test("a rejected key turns Brave off for the process", async () => {
  stub = stubFetch(() => json({ error: { code: "SUBSCRIPTION_TOKEN_INVALID" } }, 422));
  await assert.rejects(braveSearch("q422", { count: 3 }), { code: "no_backend", message: /SUBSCRIPTION_TOKEN_INVALID/ });
  assert.equal(braveAvailable(), false);
  await assert.rejects(braveSearch("another", { count: 3 }), { code: "no_backend" });
  assert.equal(stub.calls.length, 1);
});

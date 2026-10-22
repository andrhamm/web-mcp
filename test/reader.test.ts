// fetchPage against a scripted fetch. Hosts are public IP literals so no DNS is needed.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchPage } from "../src/reader.js";
import { fixture, html, stubFetch } from "./helpers.js";

const PUBLIC = "http://93.184.215.14";
let stub: ReturnType<typeof stubFetch> | undefined;
afterEach(() => stub?.restore());

test("reads an HTML page into markdown with its title", async () => {
  stub = stubFetch(() => html(fixture("article.html")));
  const p = await fetchPage(`${PUBLIC}/widget`);
  assert.match(p.title, /^Widget 3.0 released/);
  assert.match(p.markdown, /Apache-2.0/);
  assert.equal(p.url, `${PUBLIC}/widget`);
});

test("follows redirects and reports the final URL", async () => {
  stub = stubFetch((u) =>
    u.pathname === "/old"
      ? new Response(null, { status: 301, headers: { location: "/new" } })
      : html("<title>New</title><p>moved here</p>"),
  );
  const p = await fetchPage(`${PUBLIC}/old`);
  assert.equal(p.url, `${PUBLIC}/new`);
  assert.match(p.markdown, /moved here$/); // a fragment without <html> still extracts
  assert.deepEqual(stub.calls, [`${PUBLIC}/old`, `${PUBLIC}/new`]);
});

test("refuses a redirect into a private address before fetching it", async () => {
  stub = stubFetch(() => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } }));
  await assert.rejects(fetchPage(`${PUBLIC}/go`), { code: "blocked_url" });
  assert.equal(stub.calls.length, 1);
});

test("gives up after five redirects", async () => {
  stub = stubFetch((u) => new Response(null, { status: 302, headers: { location: `${u.pathname}x` } }));
  await assert.rejects(fetchPage(`${PUBLIC}/r`), { code: "fetch_failed" });
  assert.equal(stub.calls.length, 6);
});

test("HTTP errors, unsupported types and network failures map to coded errors", async () => {
  stub = stubFetch(() => html("nope", 404));
  await assert.rejects(fetchPage(`${PUBLIC}/missing`), { code: "fetch_failed", message: /HTTP 404/ });
  stub.restore();
  stub = stubFetch(() => new Response("%PDF", { headers: { "content-type": "application/pdf" } }));
  await assert.rejects(fetchPage(`${PUBLIC}/a.pdf`), { code: "fetch_failed", message: /application\/pdf/ });
  stub.restore();
  stub = stubFetch(() => {
    throw Object.assign(new Error("slow"), { name: "TimeoutError" });
  });
  await assert.rejects(fetchPage(`${PUBLIC}/slow`), { code: "timeout" });
  stub.restore();
  stub = stubFetch(() => {
    throw new Error("connection reset");
  });
  await assert.rejects(fetchPage(`${PUBLIC}/reset`), { code: "fetch_failed", message: /connection reset/ });
});

test("plain text is returned as is", async () => {
  stub = stubFetch(() => new Response("line one\nline two\n", { headers: { "content-type": "text/plain" } }));
  const p = await fetchPage(`${PUBLIC}/notes.txt`);
  assert.equal(p.markdown, "line one\nline two");
});

test("bodies over 2 MB are cut, not rejected", async () => {
  const para = `<p>${"word ".repeat(200)}</p>`;
  stub = stubFetch(() => html(`<title>Big</title><article>${para.repeat(4000)}</article>`));
  const p = await fetchPage(`${PUBLIC}/big`);
  assert.ok(p.markdown.length > 1_500_000, `got ${p.markdown.length}`); // one oversized chunk is cut, not dropped
  assert.ok(p.markdown.length <= 2 * 1024 * 1024);
});

test("an unresolvable host is a fetch failure", async () => {
  await assert.rejects(fetchPage("http://no-such-host.invalid/x"), { code: "fetch_failed", message: /resolve/ });
});

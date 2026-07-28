import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Buzz Inside shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /object-src 'none'/,
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const html = await response.text();
  assert.match(html, /<title>Buzz Inside — private workspace search<\/title>/i);
  assert.match(html, /Look inside your Buzz\./);
  assert.match(html, /no backend · no analytics · no DMs · read-only/i);
  assert.doesNotMatch(html, /doesn(?:'|&#x27;)t persist your nsec/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps the prototype read-only and transient by construction", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /kind:\s*22242/);
  assert.match(page, /secretKeyRef\.current\?\.fill\(0\)/);
  assert.match(page, /socket\.send\(JSON\.stringify\(\["AUTH", authEvent\]\)\)/);
  assert.match(page, /RECONNECT_MAX_DELAY_MS\s*=\s*30_000/);
  assert.match(page, /channel\.type\s*!==\s*"dm"/);
  assert.match(page, /"channel_created"/);
  assert.match(page, /"member_joined"/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(page, /\["EVENT",/);
  assert.doesNotMatch(page, /kind:\s*(9|40002|45001|45003)/);
  assert.match(layout, /Buzz Inside/);
  assert.match(packageJson, /"nostr-tools"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

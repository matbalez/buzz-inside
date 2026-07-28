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
  assert.match(
    html,
    /no backend · no analytics · no DMs · read-only browsing/i,
  );
  assert.match(
    html,
    /href="https:\/\/github\.com\/matbalez\/buzz-inside"[^>]*>buzz inside is open source<\/a>/i,
  );
  assert.doesNotMatch(html, /doesn(?:'|&#x27;)t persist your nsec/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps relay browsing transient and read-only by construction", async () => {
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
  assert.doesNotMatch(page, /kind:\s*(40002|45001|45003)/);
  assert.match(layout, /Buzz Inside/);
  assert.match(packageJson, /"nostr-tools"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("inverts the authenticated header and constrains the session panes", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /sessionReady \? "session-shell" : undefined/);
  assert.match(page, /sessionReady \? "site-header authenticated" : "site-header"/);
  assert.match(
    styles,
    /\.session-shell\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    styles,
    /\.site-header\.authenticated\s*\{[^}]*background:\s*var\(--ink\);[^}]*color:\s*var\(--paper\);/s,
  );
  assert.match(
    styles,
    /\.workspace\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    styles,
    /\.sidebar\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(
    styles,
    /\.results\s*\{[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;/s,
  );
});

test("limits the opt-in write path to the Flint build-channel handshake", async () => {
  const [page, buildChannel] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/build-channel.ts", import.meta.url), "utf8"),
  ]);

  assert.match(
    buildChannel,
    /BUILD_RELAY_URL\s*=\s*"wss:\/\/flint\.communities\.buzz\.xyz\/"/,
  );
  assert.match(
    buildChannel,
    /BUILD_CHANNEL_TTL_SECONDS\s*=\s*6\s*\*\s*60\s*\*\s*60/,
  );
  assert.match(buildChannel, /new WebSocket\(url\)/);
  assert.match(buildChannel, /socketFactory\(BUILD_RELAY_URL\)/);
  assert.match(buildChannel, /kind:\s*9007/);
  assert.match(buildChannel, /\["visibility",\s*"open"\]/);
  assert.match(buildChannel, /\["channel_type",\s*"stream"\]/);
  assert.match(
    buildChannel,
    /\["ttl",\s*String\(BUILD_CHANNEL_TTL_SECONDS\)\]/,
  );
  assert.match(buildChannel, /kind:\s*9/);
  assert.match(buildChannel, /content:\s*BUILD_INVITATION/);
  assert.match(
    buildChannel,
    /You are invited to make a change to the Buzz Inside project\./,
  );
  assert.match(
    buildChannel,
    /socket\.send\(JSON\.stringify\(\["EVENT",\s*createEvent\]\)\)/,
  );
  assert.match(
    buildChannel,
    /socket\.send\(JSON\.stringify\(\["EVENT",\s*invitationEvent\]\)\)/,
  );
  assert.doesNotMatch(buildChannel, /kind:\s*9000/);
  assert.match(page, /🐝 fix it in buzz/);
  assert.doesNotMatch(page, /build on Flint · 6-hour idle channel/);
  assert.match(page, /className="build-dialog"/);
  assert.match(page, /#\{buildChannel\.channelName\}/);
  assert.match(page, /buildChannelDeepLink\(buildChannel\)/);
  assert.match(
    buildChannel,
    /buzz:\/\/message\?\$\{query\.toString\(\)\}/,
  );
});

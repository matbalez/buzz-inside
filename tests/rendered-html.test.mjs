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

test("server-renders the trending-channel shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /object-src 'none'/,
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const html = await response.text();
  assert.match(html, /<title>Buzz Inside — where the buzz is<\/title>/i);
  assert.match(html, /Where(?:&#x27;|')s the buzz\?/i);
  assert.match(html, /no backend · no analytics · no DMs · read-only/i);
  assert.match(html, /continue with Nostr signer →/i);
  assert.match(html, /NIP-07 signer/i);
  assert.doesNotMatch(html, /type="password"|nsec1/i);
  assert.match(
    html,
    /href="https:\/\/github\.com\/matbalez\/buzz-inside"[^>]*>buzz inside is open source<\/a>/i,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps relay ranking transient and read-only by construction", async () => {
  const [page, signer, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/nostr-signer.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /signNip42AuthEvent/);
  assert.match(page, /signerRef/);
  assert.match(page, /socket\.send\(JSON\.stringify\(\["AUTH", authEvent\]\)\)/);
  assert.match(page, /RECONNECT_MAX_DELAY_MS\s*=\s*30_000/);
  assert.match(page, /channel\.type\s*!==\s*"dm"/);
  assert.match(page, /rankChannels\(channels, trendEvents, now\)/);
  assert.match(page, /rankActiveUsers\(channels, trendEvents, now\)/);
  assert.match(page, /profiles\[user\.pubkey\]\?\.isAgent === false/);
  assert.match(page, /safeProfile\(event\.content, event\.tags\)/);
  assert.match(page, /SYSTEM_MESSAGE_KIND/);
  assert.match(page, /"#h": \[id\]/);
  assert.match(page, /limit:\s*maxLimitRef\.current/);
  assert.match(page, /chunkItems\(filters, maxFiltersRef\.current\)/);
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(page, /decodeSecret|secretKeyRef|finalizeEvent|nip19/);
  assert.match(signer, /kind:\s*22242/);
  assert.match(signer, /event\.pubkey !== pubkey\.toLowerCase\(\)/);
  assert.match(signer, /event\.id !== getEventHash\(event\)/);
  assert.match(signer, /!verifyEvent\(event\)/);
  assert.match(layout, /where the buzz is/);
  assert.match(packageJson, /"nostr-tools"/);
});

test("lays out a ranked board with a responsive channel detail pane", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /className="trend-list"/);
  assert.match(page, /className="people-panel"/);
  assert.match(page, /Most active users/);
  assert.match(page, /className="trend-name channel-name-link"/);
  assert.match(page, /className="eyebrow channel-name-link"/);
  assert.match(page, /<ul className="person-channels">/);
  assert.match(page, /buzz:\/\/message\?/);
  assert.match(page, /className="channel-detail"/);
  assert.match(page, /\.sort\(\(a, b\) => a\.created_at - b\.created_at\)/);
  assert.match(page, /ref=\{detailMessagesRef\}/);
  assert.match(page, /recent messages · oldest → newest/);
  assert.match(page, /how the ranking works/);
  assert.match(page, /public · not joined/);
  assert.match(
    styles,
    /\.trend-workspace\.with-detail\s*\{[^}]*grid-template-columns:/s,
  );
  assert.match(
    styles,
    /\.trend-list\s*\{[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;/s,
  );
  assert.match(styles, /\.membership\.discover\s*\{[^}]*var\(--signal\)/s);
  assert.match(
    styles,
    /\.signal-grid\s*\{[^}]*grid-template-columns:/s,
  );
  assert.match(styles, /\.person-channels\s*\{[^}]*display:\s*grid;/s);
  assert.match(
    styles,
    /\.detail-messages\s*\{[^}]*flex:\s*1;[^}]*overflow-y:\s*auto;/s,
  );
});

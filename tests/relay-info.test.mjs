import assert from "node:assert/strict";
import test from "node:test";

import { fetchRelayInfo, relayInfoUrls } from "../app/relay-info.ts";

test("builds the standard and /info NIP-11 URLs", () => {
  assert.deepEqual(relayInfoUrls("wss://relay.example/buzz"), [
    "https://relay.example/buzz",
    "https://relay.example/info",
  ]);
  assert.deepEqual(relayInfoUrls("wss://relay.example/info"), [
    "https://relay.example/info",
  ]);
});

test("uses /info when the standard NIP-11 endpoint is unavailable", async () => {
  const requested = [];
  const info = await fetchRelayInfo("wss://relay.example/buzz", async (url) => {
    requested.push(url);
    if (requested.length === 1) throw new TypeError("Failed to fetch");
    return Response.json({ supported_nips: [29, 42] });
  });

  assert.deepEqual(requested, [
    "https://relay.example/buzz",
    "https://relay.example/info",
  ]);
  assert.deepEqual(info, { supported_nips: [29, 42] });
});

test("allows the WebSocket capability check when NIP-11 is blocked by CORS", async () => {
  const info = await fetchRelayInfo("wss://relay.example/", async () => {
    throw new TypeError("Failed to fetch");
  });

  assert.equal(info, null);
});

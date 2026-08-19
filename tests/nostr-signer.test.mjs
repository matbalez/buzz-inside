import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, getPublicKey } from "nostr-tools";
import {
  getNip07Signer,
  getSignerPublicKey,
  signNip42AuthEvent,
} from "../app/nostr-signer.ts";

const SECRET = new Uint8Array(32).fill(7);
const OTHER_SECRET = new Uint8Array(32).fill(9);
const PUBKEY = getPublicKey(SECRET);
const RELAY = "wss://relay.example/";
const CHALLENGE = "fresh-relay-challenge";
const CREATED_AT = 1_800_000_000;

function signerFor(secret = SECRET, changeEvent = (event) => event) {
  return {
    async getPublicKey() {
      return getPublicKey(secret);
    },
    async signEvent(event) {
      return finalizeEvent(changeEvent(structuredClone(event)), secret);
    },
  };
}

test("uses a complete NIP-07 provider and validates its public key", async () => {
  const signer = getNip07Signer({ nostr: signerFor() });
  assert.equal(await getSignerPublicKey(signer), PUBKEY);
  assert.throws(
    () => getNip07Signer({}),
    /No NIP-07 signer detected.*nos2x or Alby/i,
  );
  await assert.rejects(
    getSignerPublicKey({
      getPublicKey: async () => "not-a-pubkey",
      signEvent: async () => ({}),
    }),
    /invalid public key/i,
  );
});

test("signs the exact connection-bound NIP-42 event", async () => {
  const event = await signNip42AuthEvent({
    signer: signerFor(),
    pubkey: PUBKEY,
    relayUrl: RELAY,
    challenge: CHALLENGE,
    createdAt: CREATED_AT,
  });

  assert.equal(event.pubkey, PUBKEY);
  assert.equal(event.kind, 22242);
  assert.equal(event.created_at, CREATED_AT);
  assert.equal(event.content, "");
  assert.deepEqual(event.tags, [
    ["relay", RELAY],
    ["challenge", CHALLENGE],
  ]);
});

for (const [name, changeEvent] of [
  ["relay", (event) => ({ ...event, tags: [["relay", "wss://evil.example/"], event.tags[1]] })],
  ["challenge", (event) => ({ ...event, tags: [event.tags[0], ["challenge", "wrong"]] })],
  ["kind", (event) => ({ ...event, kind: 1 })],
  ["timestamp", (event) => ({ ...event, created_at: event.created_at + 1 })],
  ["content", (event) => ({ ...event, content: "changed" })],
]) {
  test(`rejects a valid signature over a changed ${name}`, async () => {
    await assert.rejects(
      signNip42AuthEvent({
        signer: signerFor(SECRET, changeEvent),
        pubkey: PUBKEY,
        relayUrl: RELAY,
        challenge: CHALLENGE,
        createdAt: CREATED_AT,
      }),
      /changed the authentication event/i,
    );
  });
}

test("rejects a signature from a different identity", async () => {
  await assert.rejects(
    signNip42AuthEvent({
      signer: signerFor(OTHER_SECRET),
      pubkey: PUBKEY,
      relayUrl: RELAY,
      challenge: CHALLENGE,
      createdAt: CREATED_AT,
    }),
    /changed the authentication event/i,
  );
});

test("rejects an invalid signature and an empty challenge", async () => {
  await assert.rejects(
    signNip42AuthEvent({
      signer: {
        ...signerFor(),
        async signEvent(event) {
          const signed = finalizeEvent(event, SECRET);
          return { ...signed, sig: "0".repeat(128) };
        },
      },
      pubkey: PUBKEY,
      relayUrl: RELAY,
      challenge: CHALLENGE,
      createdAt: CREATED_AT,
    }),
    /invalid signature/i,
  );
  await assert.rejects(
    signNip42AuthEvent({
      signer: signerFor(),
      pubkey: PUBKEY,
      relayUrl: RELAY,
      challenge: "",
      createdAt: CREATED_AT,
    }),
    /empty NIP-42 challenge/i,
  );
});

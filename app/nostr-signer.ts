import { getEventHash, verifyEvent } from "nostr-tools";

export type UnsignedNostrEvent = {
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
};

export type SignedNostrEvent = UnsignedNostrEvent & {
  id: string;
  pubkey: string;
  sig: string;
};

export type Nip07Signer = {
  getPublicKey(): Promise<unknown>;
  signEvent(event: UnsignedNostrEvent): Promise<unknown>;
};

type NostrWindow = {
  nostr?: unknown;
};

const HEX_32_BYTES = /^[0-9a-f]{64}$/i;
const HEX_64_BYTES = /^[0-9a-f]{128}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function exactTags(actual: string[][], expected: string[][]) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function signedEvent(value: unknown): SignedNostrEvent {
  if (!isRecord(value)) throw new Error("The Nostr signer returned no event.");
  if (!HEX_32_BYTES.test(String(value.id || ""))) {
    throw new Error("The Nostr signer returned an invalid event ID.");
  }
  if (!HEX_32_BYTES.test(String(value.pubkey || ""))) {
    throw new Error("The Nostr signer returned an invalid public key.");
  }
  if (!HEX_64_BYTES.test(String(value.sig || ""))) {
    throw new Error("The Nostr signer returned an invalid signature.");
  }
  if (!Number.isInteger(value.created_at) || !Number.isInteger(value.kind)) {
    throw new Error("The Nostr signer changed the authentication event.");
  }
  if (typeof value.content !== "string" || !Array.isArray(value.tags)) {
    throw new Error("The Nostr signer changed the authentication event.");
  }
  if (
    !value.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((item) => typeof item === "string"),
    )
  ) {
    throw new Error("The Nostr signer returned invalid event tags.");
  }

  return {
    id: String(value.id).toLowerCase(),
    pubkey: String(value.pubkey).toLowerCase(),
    sig: String(value.sig).toLowerCase(),
    created_at: value.created_at as number,
    kind: value.kind as number,
    tags: (value.tags as string[][]).map((tag) => [...tag]),
    content: value.content,
  };
}

export function getNip07Signer(browser: NostrWindow): Nip07Signer {
  const signer = browser.nostr;
  if (
    !isRecord(signer) ||
    typeof signer.getPublicKey !== "function" ||
    typeof signer.signEvent !== "function"
  ) {
    throw new Error(
      "No NIP-07 signer detected. Install nos2x or Alby, then reload this page.",
    );
  }
  return signer as Nip07Signer;
}

export async function getSignerPublicKey(signer: Nip07Signer) {
  const pubkey = await signer.getPublicKey();
  if (typeof pubkey !== "string" || !HEX_32_BYTES.test(pubkey)) {
    throw new Error("The Nostr signer returned an invalid public key.");
  }
  return pubkey.toLowerCase();
}

export async function signNip42AuthEvent({
  signer,
  pubkey,
  relayUrl,
  challenge,
  createdAt = Math.floor(Date.now() / 1000),
}: {
  signer: Nip07Signer;
  pubkey: string;
  relayUrl: string;
  challenge: string;
  createdAt?: number;
}) {
  if (!HEX_32_BYTES.test(pubkey)) {
    throw new Error("The selected Nostr identity is invalid.");
  }
  if (!challenge) throw new Error("The relay sent an empty NIP-42 challenge.");

  const unsigned: UnsignedNostrEvent = {
    kind: 22242,
    created_at: createdAt,
    content: "",
    tags: [
      ["relay", relayUrl],
      ["challenge", challenge],
    ],
  };
  const event = signedEvent(await signer.signEvent(unsigned));

  if (
    event.pubkey !== pubkey.toLowerCase() ||
    event.kind !== unsigned.kind ||
    event.created_at !== unsigned.created_at ||
    event.content !== unsigned.content ||
    !exactTags(event.tags, unsigned.tags)
  ) {
    throw new Error("The Nostr signer changed the authentication event.");
  }
  if (event.id !== getEventHash(event) || !verifyEvent(event)) {
    throw new Error("The Nostr signer returned an invalid signature.");
  }

  return event;
}

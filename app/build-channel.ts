import { finalizeEvent } from "nostr-tools";

export type BuildPhase =
  | "idle"
  | "authenticating"
  | "creating"
  | "posting"
  | "success"
  | "error";

export type BuildChannelResult = {
  channelId: string;
  channelName: string;
};

export type BuildSocket = {
  readyState: number;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number): void;
};

export const BUILD_RELAY_URL = "wss://flint.communities.buzz.xyz/";
export const BUILD_CHANNEL_TTL_SECONDS = 6 * 60 * 60;
const BUILD_RELAY_TIMEOUT_MS = 30_000;
export const BUILD_INVITATION =
  "You are invited to make a change to the Buzz Inside project. You should clone and fork the public <https://github.com/matbalez/buzz-inside/> repo. Add your agent and describe the change you would like to see to the site. When you’re happy with the change, ask your agent to open a PR against the main repo. Your change will be evaluated, merged and deployed automatically. Thank you for improving Buzz Inside!";

export function provisionBuildChannel(
  secretKey: Uint8Array,
  onPhase: (phase: BuildPhase) => void,
  onSocket: (socket: BuildSocket | null) => void,
  socketFactory: (url: string) => BuildSocket = (url) => new WebSocket(url),
) {
  const channelId = crypto.randomUUID();
  const randomNumber = crypto.getRandomValues(new Uint32Array(1))[0]
    .toString()
    .padStart(10, "0");
  const channelName = `building-buzz-inside-${randomNumber}`;
  const socket = socketFactory(BUILD_RELAY_URL);
  onSocket(socket);

  return new Promise<BuildChannelResult>((resolve, reject) => {
    let settled = false;
    let authenticated = false;
    let channelCreated = false;
    let authEventId = "";
    let createEventId = "";
    let invitationEventId = "";

    const timer = globalThis.setTimeout(() => {
      fail("The building relay did not finish in time. No further writes were sent.");
    }, BUILD_RELAY_TIMEOUT_MS);

    function cleanup() {
      globalThis.clearTimeout(timer);
      if (socket.readyState < 2) socket.close(1000);
      onSocket(null);
    }

    function fail(reason: string) {
      if (settled) return;
      settled = true;
      cleanup();
      const prefix = channelCreated
        ? `#${channelName} was created, but its invitation was not confirmed. `
        : "";
      reject(new Error(`${prefix}${reason}`));
    }

    function succeed() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ channelId, channelName });
    }

    socket.onopen = () => onPhase("authenticating");
    socket.onerror = () => {
      fail("Could not connect to the Flint building relay.");
    };
    socket.onclose = () => {
      if (!settled) {
        fail("The Flint building relay closed the connection.");
      }
    };
    socket.onmessage = (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(String(raw.data));
      } catch {
        return;
      }
      if (!Array.isArray(message) || typeof message[0] !== "string") return;

      if (
        message[0] === "AUTH" &&
        typeof message[1] === "string" &&
        !authEventId
      ) {
        const authEvent = finalizeEvent(
          {
            kind: 22242,
            created_at: Math.floor(Date.now() / 1000),
            content: "",
            tags: [
              ["relay", BUILD_RELAY_URL],
              ["challenge", message[1]],
            ],
          },
          secretKey,
        );
        authEventId = authEvent.id;
        socket.send(JSON.stringify(["AUTH", authEvent]));
        return;
      }

      if (message[0] === "NOTICE") {
        fail(
          typeof message[1] === "string"
            ? message[1]
            : "The Flint building relay rejected the request.",
        );
        return;
      }

      if (message[0] !== "OK") return;
      const [, eventId, accepted, reason] = message as [
        string,
        string,
        boolean,
        string?,
      ];

      if (eventId === authEventId) {
        if (!accepted) {
          fail(
            reason?.includes("not a relay member")
              ? "This identity is not a member of the Flint building relay. No channel was created."
              : reason || "The Flint building relay rejected authentication.",
          );
          return;
        }

        authenticated = true;
        onPhase("creating");
        const createEvent = finalizeEvent(
          {
            kind: 9007,
            created_at: Math.floor(Date.now() / 1000),
            content: "",
            tags: [
              ["h", channelId],
              ["name", channelName],
              ["visibility", "open"],
              ["channel_type", "stream"],
              ["ttl", String(BUILD_CHANNEL_TTL_SECONDS)],
            ],
          },
          secretKey,
        );
        createEventId = createEvent.id;
        socket.send(JSON.stringify(["EVENT", createEvent]));
        return;
      }

      if (eventId === createEventId && authenticated) {
        if (!accepted) {
          fail(reason || "The Flint building relay could not create the channel.");
          return;
        }

        channelCreated = true;
        onPhase("posting");
        const invitationEvent = finalizeEvent(
          {
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            content: BUILD_INVITATION,
            tags: [["h", channelId]],
          },
          secretKey,
        );
        invitationEventId = invitationEvent.id;
        socket.send(JSON.stringify(["EVENT", invitationEvent]));
        return;
      }

      if (eventId === invitationEventId && channelCreated) {
        if (!accepted) {
          fail(reason || "The Flint building relay rejected the invitation.");
          return;
        }
        succeed();
      }
    };
  });
}

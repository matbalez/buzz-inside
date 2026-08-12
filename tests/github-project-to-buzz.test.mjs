import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";

import {
  MARKER_PREFIX,
  buildBuzzDeepLink,
  buildReadyComment,
  buildSeedMessage,
  decodeSecretKey,
  findReadyIssues,
  normalizeChannelName,
  parseBridgeMarker,
  processIssue,
  publishIssueToBuzz,
} from "../automation/github-project-to-buzz.mjs";

class FakeSocket {
  readyState = 0;
  onopen = null;
  onerror = null;
  onclose = null;
  onmessage = null;
  sent = [];

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function testSecret() {
  return new Uint8Array(32).fill(7);
}

function issue(overrides = {}) {
  return {
    id: "I_kwDO-test",
    number: 11,
    title: "  Test\n issue  ",
    body: "work needs to be done",
    url: "https://github.com/matbalez/buzz-inside/issues/11",
    repository: "matbalez/buzz-inside",
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("decodes nsec and hex credentials without exposing them", () => {
  const secret = testSecret();
  assert.deepEqual(decodeSecretKey(Buffer.from(secret).toString("hex")), secret);
  assert.deepEqual(decodeSecretKey(nip19.nsecEncode(secret)), secret);
  assert.throws(() => decodeSecretKey("not-a-secret"), /valid nsec/i);
});

test("builds stable channel copy, deep links, and completion markers", () => {
  const target = issue();
  assert.equal(normalizeChannelName(target), "Test issue");
  assert.equal(
    buildSeedMessage(target),
    "# Test issue\n\nwork needs to be done\n\n---\nGitHub issue: <https://github.com/matbalez/buzz-inside/issues/11>",
  );

  const channelId = "11111111-1111-4111-8111-111111111111";
  const messageId = "a".repeat(64);
  const deepLink = buildBuzzDeepLink({ channelId, messageId });
  assert.equal(
    deepLink,
    `buzz://message?channel=${channelId}&id=${messageId}`,
  );
  const comment = buildReadyComment({ channelId, messageId });
  assert.match(comment, new RegExp(deepLink.replaceAll("?", "\\?").replaceAll("&", "\\&")));
  assert.deepEqual(parseBridgeMarker(comment), {
    state: "ready",
    channelId,
    messageId,
  });
  assert.equal(parseBridgeMarker("ordinary issue comment"), null);
  assert.match(comment, new RegExp(MARKER_PREFIX));
});

test("finds only target-repository issues in Ready for Design", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return jsonResponse({
      data: {
        user: {
          projectV2: {
            items: {
              nodes: [
                {
                  content: {
                    __typename: "Issue",
                    ...issue(),
                    repository: { nameWithOwner: "matbalez/buzz-inside" },
                  },
                  fieldValueByName: { name: "Ready for Design" },
                },
                {
                  content: {
                    __typename: "Issue",
                    ...issue({ number: 12 }),
                    repository: { nameWithOwner: "matbalez/buzz-inside" },
                  },
                  fieldValueByName: { name: "Backlog" },
                },
                {
                  content: {
                    __typename: "Issue",
                    ...issue({ number: 13 }),
                    repository: { nameWithOwner: "matbalez/another-repo" },
                  },
                  fieldValueByName: { name: "Ready for Design" },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  };

  const result = await findReadyIssues({
    projectOwner: "matbalez",
    projectNumber: 1,
    targetRepository: "matbalez/buzz-inside",
    projectToken: "project-token",
    fetchImpl,
  });

  assert.deepEqual(result, [issue({ title: "  Test\n issue  " })]);
  assert.equal(requests.length, 1);
  const requestBody = JSON.parse(requests[0].options.body);
  assert.deepEqual(requestBody.variables, {
    login: "matbalez",
    number: 1,
    after: null,
  });
});

test("authenticates, checks for a prior seed, creates a channel, and posts the issue", async () => {
  const socket = new FakeSocket();
  const secretKey = testSecret();
  const target = issue({ title: "test issue" });
  const channelId = "11111111-1111-4111-8111-111111111111";
  const promise = publishIssueToBuzz({
    issue: target,
    channelId,
    secretKey,
    socketFactory: () => socket,
    now: () => 1_800_000_000,
    logger: () => {},
  });

  socket.open();
  socket.receive(["AUTH", "challenge"]);
  const [authCommand, authEvent] = socket.sent[0];
  assert.equal(authCommand, "AUTH");
  assert.equal(authEvent.kind, 22242);

  socket.receive(["OK", authEvent.id, true, ""]);
  const [requestCommand, subscriptionId, filter] = socket.sent[1];
  assert.equal(requestCommand, "REQ");
  assert.deepEqual(filter, {
    kinds: [9],
    authors: [getPublicKey(secretKey)],
    "#h": [channelId],
    limit: 100,
  });

  socket.receive(["EOSE", subscriptionId]);
  assert.deepEqual(socket.sent[2], ["CLOSE", subscriptionId]);
  const [createCommand, createEvent] = socket.sent[3];
  assert.equal(createCommand, "EVENT");
  assert.equal(createEvent.kind, 9007);
  assert.ok(createEvent.tags.some((tag) => tag[0] === "name" && tag[1] === "test issue"));
  assert.ok(createEvent.tags.some((tag) => tag[0] === "visibility" && tag[1] === "open"));
  assert.ok(createEvent.tags.some((tag) => tag[0] === "channel_type" && tag[1] === "stream"));

  socket.receive(["OK", createEvent.id, true, ""]);
  const [seedCommand, seedEvent] = socket.sent[4];
  assert.equal(seedCommand, "EVENT");
  assert.equal(seedEvent.kind, 9);
  assert.equal(seedEvent.content, buildSeedMessage(target));
  assert.ok(seedEvent.tags.some((tag) => tag[0] === "h" && tag[1] === channelId));
  assert.ok(seedEvent.tags.some((tag) => tag[0] === "r" && tag[1] === target.url));

  socket.receive(["OK", seedEvent.id, true, ""]);
  assert.deepEqual(await promise, {
    channelId,
    channelName: "test issue",
    messageId: seedEvent.id,
    recovered: false,
  });
  assert.equal(socket.readyState, 3);
});

test("recovers a seed message after a previous run stopped before updating GitHub", async () => {
  const socket = new FakeSocket();
  const secretKey = testSecret();
  const target = issue({ title: "test issue" });
  const channelId = "11111111-1111-4111-8111-111111111111";
  const message = finalizeEvent(
    {
      kind: 9,
      created_at: 1_800_000_000,
      content: buildSeedMessage(target),
      tags: [
        ["h", channelId],
        ["r", target.url],
      ],
    },
    secretKey,
  );
  const promise = publishIssueToBuzz({
    issue: target,
    channelId,
    secretKey,
    socketFactory: () => socket,
    logger: () => {},
  });

  socket.open();
  socket.receive(["AUTH", "challenge"]);
  const authEvent = socket.sent[0][1];
  socket.receive(["OK", authEvent.id, true, ""]);
  const subscriptionId = socket.sent[1][1];
  socket.receive(["EVENT", subscriptionId, message]);
  socket.receive(["EOSE", subscriptionId]);

  assert.deepEqual(await promise, {
    channelId,
    channelName: "test issue",
    messageId: message.id,
    recovered: true,
  });
  assert.equal(socket.sent.filter(([command]) => command === "EVENT").length, 0);
});

test("continues with the reserved channel when the recovery query does not finish", async () => {
  const socket = new FakeSocket();
  const logs = [];
  const secretKey = testSecret();
  const target = issue({ title: "test issue" });
  const channelId = "11111111-1111-4111-8111-111111111111";
  const promise = publishIssueToBuzz({
    issue: target,
    channelId,
    secretKey,
    socketFactory: () => socket,
    recoveryQueryTimeoutMs: 5,
    writeTimeoutMs: 1_000,
    logger: (message) => logs.push(message),
  });

  socket.open();
  socket.receive(["AUTH", "challenge"]);
  const authEvent = socket.sent[0][1];
  socket.receive(["OK", authEvent.id, true, ""]);
  const subscriptionId = socket.sent[1][1];

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(socket.sent[2], ["CLOSE", subscriptionId]);
  const createEvent = socket.sent[3][1];
  assert.equal(createEvent.kind, 9007);
  assert.ok(logs.some((message) => message.includes("recovery query did not finish")));

  socket.receive(["OK", createEvent.id, true, ""]);
  const seedEvent = socket.sent[4][1];
  socket.receive(["OK", seedEvent.id, true, ""]);
  assert.equal((await promise).messageId, seedEvent.id);
});

test("reports a connection timeout at the exact relay phase", async () => {
  const socket = new FakeSocket();
  const promise = publishIssueToBuzz({
    issue: issue({ title: "test issue" }),
    channelId: "11111111-1111-4111-8111-111111111111",
    secretKey: testSecret(),
    socketFactory: () => socket,
    connectTimeoutMs: 5,
    logger: () => {},
  });

  await assert.rejects(promise, /connection did not open within 5ms/i);
  assert.equal(socket.readyState, 3);
});

test("reports a missing authentication challenge at the exact relay phase", async () => {
  const socket = new FakeSocket();
  const promise = publishIssueToBuzz({
    issue: issue({ title: "test issue" }),
    channelId: "11111111-1111-4111-8111-111111111111",
    secretKey: testSecret(),
    socketFactory: () => socket,
    authTimeoutMs: 5,
    logger: () => {},
  });

  socket.open();
  await assert.rejects(promise, /did not issue an authentication challenge within 5ms/i);
  assert.equal(socket.readyState, 3);
});

test("reserves one issue comment and replaces it with the Buzz link", async () => {
  const calls = [];
  const channelId = "11111111-1111-4111-8111-111111111111";
  const messageId = "b".repeat(64);
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") return jsonResponse([]);
    if (options.method === "POST") {
      return jsonResponse(
        {
          id: 99,
          body: JSON.parse(options.body).body,
          user: { login: "github-actions[bot]" },
        },
        201,
      );
    }
    if (options.method === "PATCH") {
      return jsonResponse({ id: 99, body: JSON.parse(options.body).body });
    }
    throw new Error(`Unexpected request: ${options.method} ${url}`);
  };
  const publisher = async (input) => ({
    channelId: input.channelId,
    channelName: "test issue",
    messageId,
    recovered: false,
  });

  const result = await processIssue({
    issue: issue({ title: "test issue" }),
    issueToken: "issue-token",
    secretKey: testSecret(),
    relayUrl: "wss://relay.example/",
    fetchImpl,
    publisher,
    uuid: () => channelId,
  });

  assert.equal(result.status, "created");
  assert.deepEqual(calls.map(({ options }) => options.method), ["GET", "POST", "PATCH"]);
  const pendingBody = JSON.parse(calls[1].options.body).body;
  assert.deepEqual(parseBridgeMarker(pendingBody), {
    state: "pending",
    channelId,
    messageId: null,
  });
  const readyBody = JSON.parse(calls[2].options.body).body;
  assert.deepEqual(parseBridgeMarker(readyBody), {
    state: "ready",
    channelId,
    messageId,
  });
});

test("a completed bridge marker makes later runs no-ops", async () => {
  const channelId = "11111111-1111-4111-8111-111111111111";
  const messageId = "c".repeat(64);
  let publishCalls = 0;
  const fetchImpl = async () =>
    jsonResponse([
      {
        id: 99,
        body: buildReadyComment({ channelId, messageId }),
        user: { login: "github-actions[bot]" },
      },
    ]);

  const result = await processIssue({
    issue: issue(),
    issueToken: "issue-token",
    secretKey: testSecret(),
    relayUrl: "wss://relay.example/",
    fetchImpl,
    publisher: async () => {
      publishCalls += 1;
    },
  });

  assert.deepEqual(result, { status: "skipped", channelId, messageId });
  assert.equal(publishCalls, 0);
});

test("does not trust bridge markers posted by other GitHub users", async () => {
  const attackerChannelId = "22222222-2222-4222-8222-222222222222";
  const reservedChannelId = "33333333-3333-4333-8333-333333333333";
  const messageId = "d".repeat(64);
  const methods = [];
  const fetchImpl = async (_url, options) => {
    methods.push(options.method);
    if (options.method === "GET") {
      return jsonResponse([
        {
          id: 10,
          body: buildReadyComment({ channelId: attackerChannelId, messageId }),
          user: { login: "someone-else" },
        },
      ]);
    }
    if (options.method === "POST") {
      return jsonResponse({
        id: 11,
        body: JSON.parse(options.body).body,
        user: { login: "github-actions[bot]" },
      });
    }
    return jsonResponse({ id: 11, body: JSON.parse(options.body).body });
  };

  const result = await processIssue({
    issue: issue({ title: "test issue" }),
    issueToken: "issue-token",
    secretKey: testSecret(),
    relayUrl: "wss://relay.example/",
    fetchImpl,
    uuid: () => reservedChannelId,
    publisher: async ({ channelId }) => ({
      channelId,
      channelName: "test issue",
      messageId,
      recovered: false,
    }),
  });

  assert.equal(result.channelId, reservedChannelId);
  assert.deepEqual(methods, ["GET", "POST", "PATCH"]);
});

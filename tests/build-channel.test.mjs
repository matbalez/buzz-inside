import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_CHANNEL_TTL_SECONDS,
  BUILD_INVITATION,
  BUILD_RELAY_URL,
  buildChannelDeepLink,
  provisionBuildChannel,
} from "../app/build-channel.ts";

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
  return new Uint8Array(32).fill(1);
}

test("authenticates, creates the six-hour channel, and posts the invitation", async () => {
  const socket = new FakeSocket();
  const phases = [];
  const sockets = [];
  const resultPromise = provisionBuildChannel(
    testSecret(),
    (phase) => phases.push(phase),
    (value) => sockets.push(value),
    (url) => {
      assert.equal(url, BUILD_RELAY_URL);
      return socket;
    },
  );

  socket.open();
  socket.receive(["AUTH", "test-challenge"]);

  const [authCommand, authEvent] = socket.sent[0];
  assert.equal(authCommand, "AUTH");
  assert.equal(authEvent.kind, 22242);
  assert.deepEqual(authEvent.tags, [
    ["relay", BUILD_RELAY_URL],
    ["challenge", "test-challenge"],
  ]);

  socket.receive(["OK", authEvent.id, true, ""]);
  const [createCommand, createEvent] = socket.sent[1];
  assert.equal(createCommand, "EVENT");
  assert.equal(createEvent.kind, 9007);
  assert.match(
    createEvent.tags.find((tag) => tag[0] === "name")[1],
    /^building-buzz-inside-\d{10}$/,
  );
  assert.equal(
    createEvent.tags.find((tag) => tag[0] === "visibility")[1],
    "open",
  );
  assert.equal(
    createEvent.tags.find((tag) => tag[0] === "channel_type")[1],
    "stream",
  );
  assert.equal(
    createEvent.tags.find((tag) => tag[0] === "ttl")[1],
    String(BUILD_CHANNEL_TTL_SECONDS),
  );

  socket.receive(["OK", createEvent.id, true, ""]);
  const [invitationCommand, invitationEvent] = socket.sent[2];
  assert.equal(invitationCommand, "EVENT");
  assert.equal(invitationEvent.kind, 9);
  assert.equal(invitationEvent.content, BUILD_INVITATION);
  assert.equal(
    invitationEvent.tags.find((tag) => tag[0] === "h")[1],
    createEvent.tags.find((tag) => tag[0] === "h")[1],
  );

  socket.receive(["OK", invitationEvent.id, true, ""]);
  const result = await resultPromise;

  assert.equal(result.channelId, createEvent.tags[0][1]);
  assert.equal(
    result.channelName,
    createEvent.tags.find((tag) => tag[0] === "name")[1],
  );
  assert.equal(result.invitationEventId, invitationEvent.id);
  assert.equal(
    buildChannelDeepLink(result),
    `buzz://message?channel=${result.channelId}&id=${invitationEvent.id}`,
  );
  assert.deepEqual(phases, ["authenticating", "creating", "posting"]);
  assert.equal(sockets[0], socket);
  assert.equal(sockets.at(-1), null);
  assert.equal(socket.readyState, 3);
});

test("a Flint non-member is rejected before any content write", async () => {
  const socket = new FakeSocket();
  const resultPromise = provisionBuildChannel(
    testSecret(),
    () => {},
    () => {},
    () => socket,
  );

  socket.open();
  socket.receive(["AUTH", "test-challenge"]);
  const authEvent = socket.sent[0][1];
  socket.receive([
    "OK",
    authEvent.id,
    false,
    "restricted: not a relay member",
  ]);

  await assert.rejects(
    resultPromise,
    /not a member of the Flint building relay.*No channel was created/i,
  );
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0][0], "AUTH");
  assert.equal(socket.readyState, 3);
});

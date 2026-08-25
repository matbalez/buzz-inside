import assert from "node:assert/strict";
import test from "node:test";

import {
  channelMomentumLabel,
  chunkItems,
  CREATION_HALF_LIFE_HOURS,
  heatLabel,
  isAgentProfileEvent,
  MAX_AUTHOR_MESSAGES_PER_HOUR,
  rankActiveUsers,
  rankChannels,
  relayPulse,
  SYSTEM_MESSAGE_KIND,
  TREND_HALF_LIFE_HOURS,
} from "../app/trending.ts";

const NOW = 2_000_000_000;

function channel(id, overrides = {}) {
  return {
    id,
    name: id,
    about: "",
    type: "stream",
    visibility: "open",
    isMember: false,
    members: 4,
    archived: false,
    ...overrides,
  };
}

function event(id, channelId, ageHours, pubkey = "alice") {
  return {
    id,
    pubkey,
    created_at: NOW - ageHours * 3600,
    kind: 9,
    tags: [["h", channelId]],
    content: "",
  };
}

function systemEvent(id, channelId, ageHours, type, target = "alice") {
  return {
    id,
    pubkey: "relay",
    created_at: NOW - ageHours * 3600,
    kind: SYSTEM_MESSAGE_KIND,
    tags: [["h", channelId]],
    content: JSON.stringify({ type, actor: target, target }),
  };
}

test("chunks channel filters to the relay's advertised maximum", () => {
  const chunks = chunkItems(Array.from({ length: 28 }, (_, index) => index), 10);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [10, 10, 8]);
  assert.deepEqual(chunks.flat(), Array.from({ length: 28 }, (_, index) => index));
});

test("classifies agents only from a well-formed NIP-OA profile auth tag", () => {
  assert.equal(
    isAgentProfileEvent([["auth", "owner", "conditions", "signature"]]),
    true,
  );
  assert.equal(isAgentProfileEvent([["auth", "owner"]]), false);
  assert.equal(isAgentProfileEvent([["t", "agent"]]), false);
  assert.equal(isAgentProfileEvent([]), false);
});

test("fresh activity outranks the same volume of old activity", () => {
  const channels = [channel("fresh"), channel("old")];
  const events = [
    event("f1", "fresh", 1),
    event("f2", "fresh", 2),
    event("o1", "old", TREND_HALF_LIFE_HOURS + 1),
    event("o2", "old", TREND_HALF_LIFE_HOURS + 2),
  ];

  const ranked = rankChannels(channels, events, NOW);
  assert.equal(ranked[0].id, "fresh");
  assert.equal(ranked[0].relativeHeat, 100);
  assert.ok(ranked[0].score > ranked[1].score);
});

test("caps one author's hourly scoring without hiding the raw volume", () => {
  const events = Array.from({ length: 10 }, (_, index) =>
    event(`solo-${index}`, "solo", 1, "solo-author"),
  );
  const [solo] = rankChannels([channel("solo")], events, NOW);
  const counted = Array.from({ length: MAX_AUTHOR_MESSAGES_PER_HOUR }, (_, index) =>
    event(`counted-${index}`, "counted", 1, "solo-author"),
  );
  const [baseline] = rankChannels([channel("counted")], counted, NOW);

  assert.equal(solo.messages24h, 10);
  assert.equal(solo.score, baseline.score);
});

test("several voices provide a modest breadth bonus", () => {
  const channels = [channel("conversation"), channel("monologue")];
  const events = [
    event("c1", "conversation", 2, "alice"),
    event("c2", "conversation", 2, "bob"),
    event("c3", "conversation", 2, "carol"),
    event("m1", "monologue", 2, "alice"),
    event("m2", "monologue", 2, "alice"),
    event("m3", "monologue", 2, "alice"),
  ];

  const ranked = rankChannels(channels, events, NOW);
  assert.equal(ranked[0].id, "conversation");
  assert.equal(ranked[0].voices24h, 3);
  assert.ok(ranked[0].score > ranked[1].score);
});

test("counts top-level, direct reply, and nested reply messages", () => {
  const events = [
    event("root", "threaded", 2, "alice"),
    {
      ...event("reply", "threaded", 1.5, "bob"),
      tags: [
        ["h", "threaded"],
        ["e", "root", "", "root"],
        ["e", "root", "", "reply"],
      ],
    },
    {
      ...event("nested", "threaded", 1, "carol"),
      tags: [
        ["h", "threaded"],
        ["e", "root", "", "root"],
        ["e", "reply", "", "reply"],
      ],
    },
  ];

  const [threaded] = rankChannels([channel("threaded")], events, NOW);
  assert.equal(threaded.messages24h, 3);
  assert.equal(threaded.voices24h, 3);
});

test("recent joins and channel creation lift otherwise quiet channels", () => {
  const channels = [channel("new-room"), channel("old-room")];
  const events = [
    systemEvent("created", "new-room", 2, "channel_created"),
    systemEvent("join-a", "new-room", 1, "member_joined", "alice"),
    systemEvent("join-b", "new-room", 0.5, "member_joined", "bob"),
    systemEvent(
      "old-created",
      "old-room",
      CREATION_HALF_LIFE_HOURS * 2,
      "channel_created",
    ),
  ];

  const ranked = rankChannels(channels, events, NOW);
  assert.equal(ranked[0].id, "new-room");
  assert.equal(ranked[0].messages24h, 0);
  assert.equal(ranked[0].joins24h, 2);
  assert.equal(ranked[0].createdAt, NOW - 2 * 3600);
  assert.ok(ranked[0].score > ranked[1].score);
});

test("summarizes the relay's immediate pulse without leaking hidden channels", () => {
  const channels = [
    channel("public"),
    channel("joined-private", { visibility: "private", isMember: true }),
    channel("hidden-private", { visibility: "private" }),
    channel("dm", { type: "dm", isMember: true }),
  ];
  const events = [
    event("public-now-a", "public", 0.25, "alice"),
    event("public-now-b", "public", 0.5, "bob"),
    event("private-now", "joined-private", 0.75, "alice"),
    event("public-today", "public", 5, "carol"),
    event("hidden", "hidden-private", 0.1, "mallory"),
    event("direct", "dm", 0.1, "mallory"),
    systemEvent("join", "public", 2, "member_joined", "dana"),
    systemEvent("created", "public", 36, "channel_created"),
    systemEvent("duplicate-created", "public", 40, "channel_created"),
  ];

  assert.deepEqual(relayPulse(channels, events, NOW), {
    messages1h: 3,
    messages24h: 4,
    voices1h: 2,
    activeChannels1h: 2,
    joins24h: 1,
    newChannels7d: 1,
    latestAt: NOW - 0.25 * 3600,
  });
});

test("explains why a channel is moving in plain language", () => {
  const [live] = rankChannels(
    [channel("live")],
    [event("live-message", "live", 0.5)],
    NOW,
  );
  assert.equal(channelMomentumLabel(live), "1 message in the last hour");

  const [today] = rankChannels(
    [channel("today")],
    [event("today-message", "today", 4)],
    NOW,
  );
  assert.equal(channelMomentumLabel(today), "1 message today");

  const [gathering] = rankChannels(
    [channel("gathering")],
    [
      systemEvent("new", "gathering", 2, "channel_created"),
      systemEvent("new-member", "gathering", 1, "member_joined"),
    ],
    NOW,
  );
  assert.equal(channelMomentumLabel(gathering), "new channel · 1 joined today");
});

test("ranks active users from public-channel messages only", () => {
  const channels = [
    channel("public-a", { name: "alpha" }),
    channel("public-b", { name: "beta" }),
    channel("private", { visibility: "private", isMember: true }),
  ];
  const events = [
    event("a1", "public-a", 1, "alice"),
    event("a2", "public-a", 2, "alice"),
    event("a3", "private", 1, "alice"),
    event("b1", "public-b", 1, "bob"),
    systemEvent("join", "public-b", 1, "member_joined", "bob"),
  ];

  const users = rankActiveUsers(channels, events, NOW);
  assert.deepEqual(
    users.map((user) => [user.pubkey, user.messages24h]),
    [
      ["alice", 2],
      ["bob", 1],
    ],
  );
  assert.deepEqual(users[0].topChannels, [
    { id: "public-a", name: "alpha", messages: 2 },
  ]);
});

test("includes joined private channels and public discoveries, but not DMs", () => {
  const ranked = rankChannels(
    [
      channel("joined-private", { visibility: "private", isMember: true }),
      channel("hidden-private", { visibility: "private" }),
      channel("public"),
      channel("dm", { type: "dm", isMember: true }),
      channel("archived", { archived: true, isMember: true }),
    ],
    [],
    NOW,
  );

  assert.deepEqual(
    ranked.map((item) => item.id).sort(),
    ["joined-private", "public"],
  );
  assert.equal(heatLabel(ranked[0]), "quiet");
});

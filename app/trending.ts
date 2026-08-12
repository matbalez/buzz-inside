export const TREND_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
export const TREND_HALF_LIFE_HOURS = 12;
export const JOIN_HALF_LIFE_HOURS = 48;
export const CREATION_HALF_LIFE_HOURS = 72;
export const MAX_AUTHOR_MESSAGES_PER_HOUR = 3;
export const MESSAGE_EVENT_KINDS = [9, 40002, 45001, 45003] as const;
export const SYSTEM_MESSAGE_KIND = 40099;

export function chunkItems<T>(items: T[], size: number) {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
}

export type TrendChannel = {
  id: string;
  name: string;
  about: string;
  type: string;
  visibility: "open" | "private";
  isMember: boolean;
  members: number;
  archived: boolean;
};

export type TrendEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind?: number;
  tags: string[][];
  content?: string;
};

export type RankedChannel = TrendChannel & {
  score: number;
  relativeHeat: number;
  messages1h: number;
  messages24h: number;
  messages7d: number;
  voices24h: number;
  voices7d: number;
  joins24h: number;
  joins7d: number;
  createdAt?: number;
  lastActivityAt?: number;
  latestEvent?: TrendEvent;
  deepLinkEvent?: TrendEvent;
};

export type ActiveUserChannel = {
  id: string;
  name: string;
  messages: number;
};

export type ActiveUser = {
  pubkey: string;
  messages24h: number;
  latestAt: number;
  topChannels: ActiveUserChannel[];
};

type SystemPayload = {
  type?: string;
  actor?: string;
  target?: string;
};

export function isMessageEvent(event: TrendEvent) {
  return MESSAGE_EVENT_KINDS.includes(
    (event.kind ?? 9) as (typeof MESSAGE_EVENT_KINDS)[number],
  );
}

export function systemPayload(event: TrendEvent): SystemPayload | null {
  if (event.kind !== SYSTEM_MESSAGE_KIND || !event.content) return null;
  try {
    const payload = JSON.parse(event.content) as SystemPayload;
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

export function isAgentProfileEvent(tags: string[][]) {
  return tags.some((tag) => tag.length === 4 && tag[0] === "auth");
}

function channelId(event: TrendEvent) {
  return event.tags.find((tag) => tag[0] === "h")?.[1] || "";
}

function decayedWeight(ageHours: number, halfLifeHours: number) {
  return 2 ** (-ageHours / halfLifeHours);
}

function trendStats(
  channel: TrendChannel,
  events: TrendEvent[],
  now: number,
): Omit<RankedChannel, keyof TrendChannel | "relativeHeat"> {
  const channelEvents = events
    .filter((event) => {
      const age = now - event.created_at;
      return (
        channelId(event) === channel.id &&
        age >= 0 &&
        age <= TREND_LOOKBACK_SECONDS
      );
    })
    .sort((a, b) => b.created_at - a.created_at);
  const messageEvents = channelEvents.filter(isMessageEvent);
  const signalEvents = channelEvents.filter((event) => {
    const type = systemPayload(event)?.type;
    return type === "member_joined" || type === "channel_created";
  });
  const relevantEvents = [...messageEvents, ...signalEvents].sort(
    (a, b) => b.created_at - a.created_at,
  );

  const hourlyAuthorCounts = new Map<string, number>();
  const voices24h = new Set<string>();
  const voices7d = new Set<string>();
  let weightedVolume = 0;
  let messages1h = 0;
  let messages24h = 0;

  for (const event of messageEvents) {
    const ageSeconds = now - event.created_at;
    const ageHours = ageSeconds / 3600;
    voices7d.add(event.pubkey);
    if (ageSeconds <= 60 * 60) messages1h += 1;
    if (ageSeconds <= 24 * 60 * 60) {
      messages24h += 1;
      voices24h.add(event.pubkey);
    }

    const hourBucket = Math.floor(event.created_at / 3600);
    const authorBucket = `${event.pubkey}:${hourBucket}`;
    const bucketCount = hourlyAuthorCounts.get(authorBucket) || 0;
    hourlyAuthorCounts.set(authorBucket, bucketCount + 1);
    if (bucketCount >= MAX_AUTHOR_MESSAGES_PER_HOUR) continue;

    weightedVolume += decayedWeight(ageHours, TREND_HALF_LIFE_HOURS);
  }

  const joinEvents = signalEvents.filter(
    (event) => systemPayload(event)?.type === "member_joined",
  );
  const creationEvent = signalEvents.find(
    (event) => systemPayload(event)?.type === "channel_created",
  );
  const joins24h = joinEvents.filter(
    (event) => now - event.created_at <= 24 * 60 * 60,
  ).length;
  const joinScore = joinEvents.reduce(
    (total, event) =>
      total +
      1.5 *
        decayedWeight((now - event.created_at) / 3600, JOIN_HALF_LIFE_HOURS),
    0,
  );
  const creationScore = creationEvent
    ? 5 *
      decayedWeight(
        (now - creationEvent.created_at) / 3600,
        CREATION_HALF_LIFE_HOURS,
      )
    : 0;

  // A conversation with several voices gets a modest lift, but volume and
  // freshness remain the dominant signals. Joins and creation are additive so
  // a promising new room can surface before its first long conversation.
  const breadthMultiplier =
    1 + Math.min(Math.max(voices7d.size - 1, 0), 8) * 0.05;
  const latestEvent = messageEvents[0];

  return {
    score: weightedVolume * breadthMultiplier + joinScore + creationScore,
    messages1h,
    messages24h,
    messages7d: messageEvents.length,
    voices24h: voices24h.size,
    voices7d: voices7d.size,
    joins24h,
    joins7d: joinEvents.length,
    createdAt: creationEvent?.created_at,
    lastActivityAt: relevantEvents[0]?.created_at,
    latestEvent,
    deepLinkEvent: relevantEvents[0],
  };
}

export function rankChannels(
  channels: TrendChannel[],
  events: TrendEvent[],
  now = Math.floor(Date.now() / 1000),
): RankedChannel[] {
  const ranked = channels
    .filter(
      (channel) =>
        channel.type !== "dm" &&
        !channel.archived &&
        (channel.isMember || channel.visibility === "open"),
    )
    .map((channel) => ({
      ...channel,
      ...trendStats(channel, events, now),
      relativeHeat: 0,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.lastActivityAt || 0) - (a.lastActivityAt || 0) ||
        a.name.localeCompare(b.name),
    );

  const leaderScore = ranked[0]?.score || 0;
  return ranked.map((channel) => ({
    ...channel,
    relativeHeat: leaderScore
      ? Math.max(2, Math.round((channel.score / leaderScore) * 100))
      : 0,
  }));
}

export function rankActiveUsers(
  channels: TrendChannel[],
  events: TrendEvent[],
  now = Math.floor(Date.now() / 1000),
): ActiveUser[] {
  const publicChannels = new Map(
    channels
      .filter(
        (channel) =>
          channel.type !== "dm" &&
          !channel.archived &&
          channel.visibility === "open",
      )
      .map((channel) => [channel.id, channel]),
  );
  const users = new Map<
    string,
    { messages24h: number; latestAt: number; channels: Map<string, number> }
  >();

  for (const event of events) {
    if (!isMessageEvent(event)) continue;
    const age = now - event.created_at;
    if (age < 0 || age > 24 * 60 * 60) continue;
    const id = channelId(event);
    if (!publicChannels.has(id)) continue;
    const current = users.get(event.pubkey) || {
      messages24h: 0,
      latestAt: 0,
      channels: new Map<string, number>(),
    };
    current.messages24h += 1;
    current.latestAt = Math.max(current.latestAt, event.created_at);
    current.channels.set(id, (current.channels.get(id) || 0) + 1);
    users.set(event.pubkey, current);
  }

  return [...users.entries()]
    .map(([pubkey, stats]) => ({
      pubkey,
      messages24h: stats.messages24h,
      latestAt: stats.latestAt,
      topChannels: [...stats.channels.entries()]
        .map(([id, messages]) => ({
          id,
          name: publicChannels.get(id)?.name || id,
          messages,
        }))
        .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name))
        .slice(0, 3),
    }))
    .sort(
      (a, b) =>
        b.messages24h - a.messages24h ||
        b.latestAt - a.latestAt ||
        a.pubkey.localeCompare(b.pubkey),
    );
}

export function heatLabel(channel: RankedChannel) {
  if (channel.score >= 20) return "roaring";
  if (channel.score >= 8) return "hot";
  if (channel.score >= 2) return "buzzing";
  if (channel.score > 0) return "warming";
  return "quiet";
}

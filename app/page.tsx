"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getNip07Signer,
  getSignerPublicKey,
  signNip42AuthEvent,
} from "./nostr-signer";
import type { Nip07Signer } from "./nostr-signer";
import { fetchRelayInfo, relayInfoUrls } from "./relay-info";
import {
  chunkItems,
  heatLabel,
  isAgentProfileEvent,
  isMessageEvent,
  MESSAGE_EVENT_KINDS,
  rankActiveUsers,
  rankChannels,
  SYSTEM_MESSAGE_KIND,
  systemPayload,
  TREND_LOOKBACK_SECONDS,
} from "./trending";
import type { ActiveUser, RankedChannel, TrendChannel } from "./trending";

type Phase =
  | "idle"
  | "checking"
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "reconnecting"
  | "error";

type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

type Profile = {
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  isAgent: boolean;
};

type Channel = TrendChannel & {
  memberPubkeys: string[];
};

type BoardFilter = "all" | "joined" | "discover";

const CHANNEL_KINDS = [39000, 39001, 39002];
const REQUIRED_NIPS = [29, 42];
const RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_FILTERS = 10;
const DEFAULT_MAX_LIMIT = 1000;

function getTag(event: NostrEvent, name: string) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function hasTag(event: NostrEvent, name: string) {
  return event.tags.some((tag) => tag[0] === name);
}

function normalizeRelayUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a Buzz relay URL.");

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `wss://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("Relay URLs must use wss:// or ws://.");
  }
  url.hash = "";
  url.search = "";
  return url.toString();
}

function shortKey(value: string) {
  return value ? `${value.slice(0, 8)}…${value.slice(-8)}` : "";
}

function safeProfile(content: string, tags: string[][]): Profile {
  try {
    const value = JSON.parse(content) as unknown;
    return {
      ...(value && typeof value === "object" ? (value as Omit<Profile, "isAgent">) : {}),
      isAgent: isAgentProfileEvent(tags),
    };
  } catch {
    return { isAgent: isAgentProfileEvent(tags) };
  }
}

function upsertEvent(list: NostrEvent[], event: NostrEvent) {
  const map = new Map(list.map((item) => [item.id, item]));
  map.set(event.id, event);
  return [...map.values()].sort((a, b) => b.created_at - a.created_at);
}

function timeLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

function relativeTime(timestamp: number | undefined, now: number) {
  if (!timestamp) return "no recent activity";
  const seconds = Math.max(0, now - timestamp);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function contentWithLinks(content: string) {
  const parts = content.split(/(https?:\/\/[^\s<>"']+)/g);
  return parts.map((part, index) => {
    if (!/^https?:\/\//.test(part)) return part;
    return (
      <a key={`${part}-${index}`} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    );
  });
}

function channelDeepLink(channel: RankedChannel) {
  if (!channel.deepLinkEvent) return "";
  const query = new URLSearchParams({
    channel: channel.id,
    id: channel.deepLinkEvent.id,
  });
  return `buzz://message?${query.toString()}`;
}

export default function Home() {
  const [relayInput, setRelayInput] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [channelEvents, setChannelEvents] = useState<NostrEvent[]>([]);
  const [trendEvents, setTrendEvents] = useState<NostrEvent[]>([]);
  const [directoryReady, setDirectoryReady] = useState(false);
  const [loadingTrends, setLoadingTrends] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [boardFilter, setBoardFilter] = useState<BoardFilter>("all");
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const socketRef = useRef<WebSocket | null>(null);
  const signerRef = useRef<Nip07Signer | null>(null);
  const authEventIdRef = useRef("");
  const identityRef = useRef("");
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const challengeTimerRef = useRef<number | null>(null);
  const openSocketRef = useRef<(url: string, reconnecting: boolean) => void>(
    () => {},
  );
  const profileQueueRef = useRef(new Set<string>());
  const profileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trendRequestKeyRef = useRef("");
  const maxFiltersRef = useRef(DEFAULT_MAX_FILTERS);
  const maxLimitRef = useRef(DEFAULT_MAX_LIMIT);
  const pendingTrendSubscriptionsRef = useRef(new Set<string>());
  const detailMessagesRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback((payload: unknown[]) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("The relay connection is not open.");
    }
    socket.send(JSON.stringify(payload));
  }, []);

  const queueProfile = useCallback(
    (eventPubkey: string) => {
      if (!eventPubkey || profiles[eventPubkey]) return;
      profileQueueRef.current.add(eventPubkey);
      if (profileTimerRef.current) return;

      profileTimerRef.current = setTimeout(() => {
        profileTimerRef.current = null;
        const authors = [...profileQueueRef.current].slice(0, 100);
        authors.forEach((item) => profileQueueRef.current.delete(item));
        if (!authors.length || socketRef.current?.readyState !== WebSocket.OPEN) {
          return;
        }
        socketRef.current.send(
          JSON.stringify([
            "REQ",
            `profiles-${Date.now()}`,
            { kinds: [0], authors, limit: authors.length },
          ]),
        );
      }, 80);
    },
    [profiles],
  );

  const clearSession = useCallback(() => {
    if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
    profileTimerRef.current = null;
    profileQueueRef.current.clear();
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (challengeTimerRef.current !== null) {
      window.clearTimeout(challengeTimerRef.current);
      challengeTimerRef.current = null;
    }
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
    signerRef.current = null;
    authEventIdRef.current = "";
    identityRef.current = "";
    reconnectAttemptRef.current = 0;
    trendRequestKeyRef.current = "";
    maxFiltersRef.current = DEFAULT_MAX_FILTERS;
    maxLimitRef.current = DEFAULT_MAX_LIMIT;
    pendingTrendSubscriptionsRef.current.clear();
    setRelayUrl("");
    setPubkey("");
    setProfiles({});
    setChannelEvents([]);
    setTrendEvents([]);
    setDirectoryReady(false);
    setLoadingTrends(false);
    setSessionReady(false);
    setBoardFilter("all");
    setSelectedChannelId("");
    setError("");
    setPhase("idle");
  }, []);

  useEffect(() => clearSession, [clearSession]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  const subscribeSessionData = useCallback(
    (identity: string) => {
      trendRequestKeyRef.current = "";
      pendingTrendSubscriptionsRef.current.clear();
      setDirectoryReady(false);
      send(["REQ", "channels", { kinds: CHANNEL_KINDS, limit: 1000 }]);
      send([
        "REQ",
        "self-profile",
        { kinds: [0], authors: [identity], limit: 1 },
      ]);
    },
    [send],
  );

  const handleRelayMessage = useCallback(
    (raw: MessageEvent<string>) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (!Array.isArray(message) || typeof message[0] !== "string") return;

      if (message[0] === "OK") {
        const [, eventId, accepted, reason] = message as [
          string,
          string,
          boolean,
          string?,
        ];
        if (eventId === authEventIdRef.current) {
          if (!accepted) {
            shouldReconnectRef.current = false;
            signerRef.current = null;
            setSessionReady(false);
            setError(reason || "The relay rejected authentication.");
            setPhase("error");
            socketRef.current?.close();
            return;
          }
          reconnectAttemptRef.current = 0;
          setError("");
          setSessionReady(true);
          setPhase("authenticated");
          subscribeSessionData(identityRef.current);
        }
        return;
      }

      if (message[0] === "NOTICE") {
        const notice = typeof message[1] === "string" ? message[1] : "";
        if (notice) setError(notice);
        return;
      }

      if (message[0] === "EOSE") {
        const subscription = String(message[1] || "");
        if (subscription === "channels") setDirectoryReady(true);
        if (subscription.startsWith("trending-view-")) {
          pendingTrendSubscriptionsRef.current.delete(subscription);
          if (!pendingTrendSubscriptionsRef.current.size) {
            setLoadingTrends(false);
          }
        }
        return;
      }

      if (message[0] !== "EVENT") return;
      const subscription = String(message[1] || "");
      const event = message[2] as NostrEvent;
      if (!event?.id || !event.pubkey) return;

      if (event.kind === 0) {
        setProfiles((current) => ({
          ...current,
          [event.pubkey]: safeProfile(event.content, event.tags),
        }));
        return;
      }

      if (subscription === "channels") {
        setChannelEvents((current) => upsertEvent(current, event));
        return;
      }
      if (
        MESSAGE_EVENT_KINDS.includes(
          event.kind as (typeof MESSAGE_EVENT_KINDS)[number],
        ) ||
        event.kind === SYSTEM_MESSAGE_KIND
      ) {
        if (isMessageEvent(event)) queueProfile(event.pubkey);
        const payload = systemPayload(event);
        if (payload?.actor) queueProfile(payload.actor);
        if (payload?.target) queueProfile(payload.target);
        setTrendEvents((current) => upsertEvent(current, event));
      }
    },
    [queueProfile, subscribeSessionData],
  );

  const openSocket = useCallback(
    (nextRelayUrl: string, reconnecting: boolean) => {
      if (!signerRef.current || !shouldReconnectRef.current) return;
      if (challengeTimerRef.current !== null) {
        window.clearTimeout(challengeTimerRef.current);
      }
      authEventIdRef.current = "";
      setPhase(reconnecting ? "reconnecting" : "connecting");

      const socket = new WebSocket(nextRelayUrl);
      let authChallenge = "";
      socketRef.current = socket;
      challengeTimerRef.current = window.setTimeout(() => {
        if (!authEventIdRef.current && socketRef.current === socket) {
          setError("The relay did not issue a NIP-42 challenge. Retrying…");
          socket.close();
        }
      }, 12_000);

      socket.onopen = () => {
        setPhase(reconnecting ? "reconnecting" : "authenticating");
      };
      socket.onerror = () => setError("The relay connection failed. Retrying…");
      socket.onclose = () => {
        if (challengeTimerRef.current !== null) {
          window.clearTimeout(challengeTimerRef.current);
          challengeTimerRef.current = null;
        }
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (!shouldReconnectRef.current || !signerRef.current) {
          setPhase((current) => (current === "idle" ? current : "error"));
          return;
        }

        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(1_000 * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
        reconnectAttemptRef.current = attempt + 1;
        setPhase("reconnecting");
        setError(`relay disconnected · retrying in ${Math.ceil(delay / 1000)}s`);
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          openSocketRef.current(nextRelayUrl, true);
        }, delay);
      };
      socket.onmessage = (message) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }

        if (
          Array.isArray(parsed) &&
          parsed[0] === "AUTH" &&
          typeof parsed[1] === "string"
        ) {
          if (authChallenge || authEventIdRef.current) return;
          const signer = signerRef.current;
          const identity = identityRef.current;
          const challenge = parsed[1];
          if (!signer || !identity) return;
          authChallenge = challenge;
          if (challengeTimerRef.current !== null) {
            window.clearTimeout(challengeTimerRef.current);
            challengeTimerRef.current = null;
          }

          void signNip42AuthEvent({
            signer,
            pubkey: identity,
            relayUrl: nextRelayUrl,
            challenge,
          })
            .then((authEvent) => {
              if (
                socketRef.current !== socket ||
                socket.readyState !== WebSocket.OPEN ||
                signerRef.current !== signer ||
                identityRef.current !== identity
              ) {
                return;
              }
              authEventIdRef.current = authEvent.id;
              socket.send(JSON.stringify(["AUTH", authEvent]));
            })
            .catch((caught) => {
              if (socketRef.current !== socket) return;
              shouldReconnectRef.current = false;
              signerRef.current = null;
              setSessionReady(false);
              setError(
                caught instanceof Error
                  ? caught.message
                  : "The Nostr signer rejected authentication.",
              );
              setPhase("error");
              socket.close();
            });
          return;
        }
        handleRelayMessage(message);
      };
    },
    [handleRelayMessage],
  );

  useEffect(() => {
    openSocketRef.current = openSocket;
  }, [openSocket]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPhase("checking");

    try {
      const nextRelayUrl = normalizeRelayUrl(relayInput);
      const info = await fetchRelayInfo(nextRelayUrl);
      if (info) {
        const supported = new Set(info.supported_nips || []);
        const missing = REQUIRED_NIPS.filter((nip) => !supported.has(nip));
        if (missing.length) {
          throw new Error(
            `This relay is missing required Buzz capabilities: NIP-${missing.join(", NIP-")}.`,
          );
        }
      }

      const advertisedMaxFilters = info?.limitation?.max_filters;
      maxFiltersRef.current =
        typeof advertisedMaxFilters === "number" && advertisedMaxFilters > 0
          ? Math.floor(advertisedMaxFilters)
          : DEFAULT_MAX_FILTERS;
      const advertisedMaxLimit = info?.limitation?.max_limit;
      maxLimitRef.current =
        typeof advertisedMaxLimit === "number" && advertisedMaxLimit > 0
          ? Math.floor(advertisedMaxLimit)
          : DEFAULT_MAX_LIMIT;

      const signer = getNip07Signer(window);
      const nextPubkey = await getSignerPublicKey(signer);
      signerRef.current = signer;
      shouldReconnectRef.current = true;
      reconnectAttemptRef.current = 0;
      setRelayUrl(nextRelayUrl);
      setPubkey(nextPubkey);
      identityRef.current = nextPubkey;
      openSocketRef.current(nextRelayUrl, false);
    } catch (caught) {
      signerRef.current = null;
      shouldReconnectRef.current = false;
      setError(caught instanceof Error ? caught.message : "Could not connect.");
      setPhase("error");
    }
  }

  const channels = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const event of [...channelEvents].reverse()) {
      const id = getTag(event, "d") || getTag(event, "h");
      if (!id) continue;
      const current = map.get(id) || {
        id,
        name: id,
        about: "",
        type: "stream",
        visibility: "open" as const,
        isMember: false,
        members: 0,
        memberPubkeys: [],
        archived: false,
      };

      if (event.kind === 39000) {
        current.name = getTag(event, "name") || current.name;
        current.about =
          getTag(event, "purpose") ||
          getTag(event, "topic") ||
          getTag(event, "about") ||
          current.about;
        current.type = getTag(event, "t") || current.type;
        const visibility = getTag(event, "visibility");
        current.visibility =
          hasTag(event, "private") || visibility === "private"
            ? "private"
            : "open";
        current.archived = getTag(event, "archived") === "true";
      } else if (event.kind === 39002) {
        current.memberPubkeys = [
          ...new Set(
            event.tags
              .filter((tag) => tag[0] === "p" && tag[1])
              .map((tag) => tag[1]),
          ),
        ];
        current.members = current.memberPubkeys.length;
      }
      current.isMember = current.memberPubkeys.includes(pubkey);
      map.set(id, current);
    }
    return [...map.values()].filter(
      (channel) =>
        channel.type !== "dm" &&
        !channel.archived &&
        (channel.isMember || channel.visibility === "open"),
    );
  }, [channelEvents, pubkey]);

  useEffect(() => {
    if (!sessionReady || !directoryReady || !channels.length) return;
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    const channelIds = channels.map((channel) => channel.id).sort();
    const requestKey = channelIds.join(":");
    if (trendRequestKeyRef.current === requestKey) return;
    trendRequestKeyRef.current = requestKey;
    setLoadingTrends(true);
    const since = Math.floor(Date.now() / 1000) - TREND_LOOKBACK_SECONDS;
    const filters = channelIds.flatMap((id) => [
      {
        kinds: [...MESSAGE_EVENT_KINDS],
        "#h": [id],
        since,
        // Use the relay's advertised ceiling. The previous fixed 250-event cap
        // truncated busy channels and made reply-inclusive 24h totals look low.
        limit: maxLimitRef.current,
      },
      {
        kinds: [SYSTEM_MESSAGE_KIND],
        "#h": [id],
        since,
        // Keep discovery signals separate so a burst of joins cannot crowd
        // conversational events out of a channel's message count.
        limit: maxLimitRef.current,
      },
    ]);
    const batches = chunkItems(filters, maxFiltersRef.current);
    pendingTrendSubscriptionsRef.current = new Set(
      batches.map((_, index) => `trending-view-${index}`),
    );
    batches.forEach((batch, index) => {
      send(["REQ", `trending-view-${index}`, ...batch]);
    });
  }, [channels, directoryReady, send, sessionReady]);

  const rankedChannels = useMemo(
    () => rankChannels(channels, trendEvents, now),
    [channels, now, trendEvents],
  );
  const filteredChannels = useMemo(
    () =>
      rankedChannels.filter((channel) => {
        if (boardFilter === "joined") return channel.isMember;
        if (boardFilter === "discover") return !channel.isMember;
        return true;
      }),
    [boardFilter, rankedChannels],
  );
  const activeUsers = useMemo(
    () =>
      rankActiveUsers(channels, trendEvents, now)
        // Profiles arrive asynchronously. Require a loaded, positively human
        // kind:0 profile so agents never flash into the leaderboard.
        .filter((user) => profiles[user.pubkey]?.isAgent === false)
        .slice(0, 12),
    [channels, now, profiles, trendEvents],
  );
  const selectedChannel =
    rankedChannels.find((channel) => channel.id === selectedChannelId) || null;
  const selectedEvents = useMemo(
    () =>
      selectedChannel
        ? trendEvents
            .filter(
              (event) =>
                isMessageEvent(event) &&
                getTag(event, "h") === selectedChannel.id,
            )
            .slice(0, 24)
            .sort((a, b) => a.created_at - b.created_at)
        : [],
    [selectedChannel, trendEvents],
  );

  useEffect(() => {
    if (!selectedChannelId) return;
    const frame = window.requestAnimationFrame(() => {
      const node = detailMessagesRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedChannelId]);

  const identityProfile = profiles[pubkey];
  const identityName =
    identityProfile?.display_name || identityProfile?.name || shortKey(pubkey);
  const relayDisplay = relayUrl.replace(/\/$/, "");
  const relayInfoUrl = relayUrl ? relayInfoUrls(relayUrl)[0] : "";
  const joinedCount = rankedChannels.filter((channel) => channel.isMember).length;
  const discoverCount = rankedChannels.length - joinedCount;

  return (
    <main className={sessionReady ? "session-shell" : undefined}>
      <header
        className={sessionReady ? "site-header authenticated" : "site-header"}
      >
        <div className="relay-header">
          <a className="wordmark" href="#" aria-label="Buzz Inside home">
            buzz inside
          </a>
          <span className="slash">/</span>
          <span>trending channels</span>
          {sessionReady ? (
            <>
              <span className="slash">/</span>
              <a href={relayInfoUrl} target="_blank" rel="noreferrer">
                {relayDisplay}
              </a>
            </>
          ) : null}
        </div>
        {sessionReady ? (
          <div className="session-summary">
            <span
              className={
                phase === "reconnecting" ? "status-dot reconnecting" : "status-dot"
              }
              aria-hidden="true"
            />
            {phase === "reconnecting" ? <span>reconnecting</span> : null}
            <span>{identityName}</span>
            <button className="text-button" type="button" onClick={clearSession}>
              clear session
            </button>
          </div>
        ) : (
          <span className="quiet">nothing is stored</span>
        )}
      </header>

      {!sessionReady ? (
        <section className="entry">
          <p className="eyebrow">live relay activity</p>
          <h1>Where&apos;s the buzz?</h1>
          <p className="lede">
            See which channels are moving right now—both the rooms you&apos;re in
            and public ones you haven&apos;t discovered yet.
          </p>

          <form className="connect-form" onSubmit={connect}>
            <label htmlFor="relay">relay</label>
            <input
              id="relay"
              name="relay"
              type="text"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="wss://your-buzz-relay.example"
              value={relayInput}
              onChange={(event) => setRelayInput(event.target.value)}
              disabled={phase !== "idle" && phase !== "error"}
              required
            />

            <button
              className="primary-button"
              type="submit"
              disabled={phase !== "idle" && phase !== "error"}
            >
              {phase === "checking" && "checking relay…"}
              {phase === "connecting" && "connecting…"}
              {phase === "authenticating" && "authenticating…"}
              {phase === "reconnecting" && "reconnecting…"}
              {(phase === "idle" || phase === "error") &&
                "continue with Nostr signer →"}
            </button>
            <p className="signer-note">
              Uses an installed NIP-07 signer. Need one? Try{" "}
              <a
                href="https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp"
                target="_blank"
                rel="noreferrer"
              >
                nos2x for Chromium
              </a>{" "}
              ·{" "}
              <a
                href="https://addons.mozilla.org/firefox/addon/nos2x-fox/"
                target="_blank"
                rel="noreferrer"
              >
                nos2x-fox for Firefox
              </a>{" "}
              ·{" "}
              <a
                href="https://github.com/getAlby/lightning-browser-extension"
                target="_blank"
                rel="noreferrer"
              >
                Alby
              </a>
              .
            </p>
          </form>

          {error ? (
            <div className="error" role="alert">
              <p>{error}</p>
              {phase === "reconnecting" ? (
                <button className="text-button" type="button" onClick={clearSession}>
                  stop retrying
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="privacy-note">
            <p>no backend · no analytics · no DMs · read-only</p>
            <p>
              Activity is ranked in this tab from data your identity can already
              read. Your private key stays in your signer; this page receives only
              your public key and a signed relay authentication event.
            </p>
          </div>
        </section>
      ) : (
        <div className={selectedChannel ? "trend-workspace with-detail" : "trend-workspace"}>
          <section className="trend-board" aria-labelledby="trend-title">
            <div className="board-intro">
              <div>
                <p className="eyebrow">live relay signal · past 24 hours</p>
                <div className="board-title-line">
                  <h1 id="trend-title">Where&apos;s the buzz?</h1>
                  <p className="board-lede">
                    Messages, replies, new joins, and newly created channels.
                  </p>
                </div>
              </div>
              <div className="board-summary" aria-label="Channel totals">
                <span>{joinedCount} joined</span>
                <span>{discoverCount} to discover</span>
              </div>
            </div>

            {error ? (
              <p className="inline-error" role="alert">
                relay notice: {error}
              </p>
            ) : null}

            <div className="signal-grid">
              <section className="channel-panel" aria-label="Trending channels">
                <div className="board-toolbar">
                  <div className="filter-tabs" aria-label="Filter channels">
                    {(["all", "joined", "discover"] as BoardFilter[]).map((filter) => (
                      <button
                        className={boardFilter === filter ? "filter-tab active" : "filter-tab"}
                        key={filter}
                        type="button"
                        onClick={() => setBoardFilter(filter)}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                  <span className="quiet">
                    {loadingTrends ? "reading the relay…" : "updates live"}
                  </span>
                </div>

                <div className="trend-list" aria-live="polite" aria-busy={loadingTrends}>
                  {!filteredChannels.length && !loadingTrends ? (
                    <div className="empty">
                      <p>No channels match this view.</p>
                    </div>
                  ) : null}
                  {filteredChannels.map((channel, index) => (
                    <TrendRow
                      channel={channel}
                      index={rankedChannels.indexOf(channel) + 1 || index + 1}
                      key={channel.id}
                      now={now}
                      selected={channel.id === selectedChannelId}
                      onSelect={() =>
                        setSelectedChannelId((current) =>
                          current === channel.id ? "" : channel.id,
                        )
                      }
                    />
                  ))}
                </div>

                <details className="score-note">
                  <summary>how the ranking works</summary>
                  <p>
                    Every top-level post and nested reply counts. Messages lose
                    half their weight every 12 hours; one-author floods are
                    damped, while more voices add a small lift. Recent joins and
                    channel creation add separate, decaying discovery boosts.
                    Public and joined private channels are ranked; DMs are never
                    included.
                  </p>
                </details>
              </section>

              <ActiveUsersPanel
                channels={rankedChannels}
                users={activeUsers}
                profiles={profiles}
                loading={loadingTrends}
              />
            </div>
          </section>

          {selectedChannel ? (
            <aside className="channel-detail" aria-label={`${selectedChannel.name} details`}>
              <div className="detail-heading">
                {channelDeepLink(selectedChannel) ? (
                  <a
                    className="eyebrow channel-name-link"
                    href={channelDeepLink(selectedChannel)}
                  >
                    #{selectedChannel.name}
                  </a>
                ) : (
                  <span className="eyebrow">#{selectedChannel.name}</span>
                )}
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setSelectedChannelId("")}
                >
                  close
                </button>
              </div>
              <div className="detail-status">
                <span className={selectedChannel.isMember ? "membership joined" : "membership discover"}>
                  {selectedChannel.isMember ? "joined" : "public · not joined"}
                </span>
                <span>{selectedChannel.members} members</span>
              </div>
              {selectedChannel.about ? (
                <p className="detail-about">{selectedChannel.about}</p>
              ) : null}
              <dl className="detail-stats">
                <div>
                  <dt>last 24h</dt>
                  <dd>{selectedChannel.messages24h} messages</dd>
                </div>
                <div>
                  <dt>voices</dt>
                  <dd>{selectedChannel.voices24h}</dd>
                </div>
                <div>
                  <dt>last post</dt>
                  <dd>{relativeTime(selectedChannel.latestEvent?.created_at, now)}</dd>
                </div>
                <div>
                  <dt>new joins</dt>
                  <dd>{selectedChannel.joins24h} / 24h</dd>
                </div>
              </dl>

              <div className="detail-section-heading">
                recent messages · oldest → newest
              </div>
              <div className="detail-messages" ref={detailMessagesRef}>
                {selectedEvents.length ? (
                  selectedEvents.map((event) => (
                    <article className="detail-message" key={event.id}>
                      <div className="message-meta">
                        <span className="author">
                          {profiles[event.pubkey]?.display_name ||
                            profiles[event.pubkey]?.name ||
                            shortKey(event.pubkey)}
                        </span>
                        <time dateTime={new Date(event.created_at * 1000).toISOString()}>
                          {timeLabel(event.created_at)}
                        </time>
                      </div>
                      <div className="message-body">
                        {contentWithLinks(event.content)}
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="quiet">No messages in the seven-day window.</p>
                )}
              </div>

              {channelDeepLink(selectedChannel) ? (
                <a className="buzz-link" href={channelDeepLink(selectedChannel)}>
                  open latest in Buzz →
                </a>
              ) : null}
            </aside>
          ) : null}
        </div>
      )}

      <footer className="site-footer">
        <span>local ranking · no backend</span>
        <a
          href="https://github.com/matbalez/buzz-inside"
          target="_blank"
          rel="noreferrer"
        >
          buzz inside is open source
        </a>
      </footer>
    </main>
  );
}

function TrendRow({
  channel,
  index,
  now,
  selected,
  onSelect,
}: {
  channel: RankedChannel;
  index: number;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const link = channelDeepLink(channel);
  return (
    <div className={selected ? "trend-row selected" : "trend-row"}>
      <button
        aria-expanded={selected}
        aria-label={`Preview ${channel.name}`}
        className="trend-row-hit"
        type="button"
        onClick={onSelect}
      />
      <span className="trend-rank">{String(index).padStart(2, "0")}</span>
      <span className="trend-channel">
        {link ? (
          <a className="trend-name channel-name-link" href={link}>
            # {channel.name}
          </a>
        ) : (
          <span className="trend-name"># {channel.name}</span>
        )}
        <span className="trend-about">
          {channel.about || `${channel.members} member channel`}
        </span>
      </span>
      <span className="trend-signal">
        <span className="heat-track" aria-hidden="true">
          <span style={{ width: `${channel.relativeHeat}%` }} />
        </span>
        <span className="heat-label">
          {heatLabel(channel)}
          {channel.createdAt ? " · new" : ""}
        </span>
      </span>
      <span className="trend-metrics">
        <span>{channel.messages24h} msgs / 24h</span>
        <span>
          {channel.voices24h} voices
          {channel.joins24h ? ` · +${channel.joins24h} joined` : ""}
        </span>
        <span>{relativeTime(channel.lastActivityAt, now)}</span>
      </span>
      <span className={channel.isMember ? "membership joined" : "membership discover"}>
        {channel.isMember ? "joined" : "discover"}
      </span>
      <span className="row-arrow" aria-hidden="true">→</span>
    </div>
  );
}

function ActiveUsersPanel({
  channels,
  users,
  profiles,
  loading,
}: {
  channels: RankedChannel[];
  users: ActiveUser[];
  profiles: Record<string, Profile>;
  loading: boolean;
}) {
  return (
    <aside className="people-panel" aria-labelledby="active-users-title">
      <div className="people-heading">
        <div>
          <p className="eyebrow">public channels · past 24h</p>
          <h2 id="active-users-title">Most active users</h2>
        </div>
        <span>{users.length ? `top ${users.length}` : "—"}</span>
      </div>
      <div className="people-list" aria-live="polite" aria-busy={loading}>
        {!users.length && !loading ? (
          <p className="quiet">No public-channel messages in this window.</p>
        ) : null}
        {users.map((user, index) => {
          const profile = profiles[user.pubkey];
          const name =
            profile?.display_name || profile?.name || shortKey(user.pubkey);
          return (
            <article className="person-row" key={user.pubkey}>
              <span className="person-rank">{String(index + 1).padStart(2, "0")}</span>
              <div className="person-main">
                <div className="person-name-line">
                  <strong>{name}</strong>
                  <span>{user.messages24h} msgs</span>
                </div>
                <ul className="person-channels">
                  {user.topChannels.map((channel) => {
                    const ranked = channels.find((item) => item.id === channel.id);
                    const link = ranked ? channelDeepLink(ranked) : "";
                    return (
                      <li key={channel.id}>
                        {link ? (
                          <a className="channel-name-link" href={link}>
                            #{channel.name}
                          </a>
                        ) : (
                          <span>#{channel.name}</span>
                        )}{" "}
                        <b>{channel.messages}</b>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}

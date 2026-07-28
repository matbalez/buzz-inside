"use client";

import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";

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

type RelayInfo = {
  name?: string;
  description?: string;
  pubkey?: string;
  supported_nips?: number[];
  limitation?: {
    auth_required?: boolean;
  };
};

type Profile = {
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
};

type Channel = {
  id: string;
  name: string;
  about: string;
  picture?: string;
  type: string;
  isPublic: boolean;
  isOpen: boolean;
  members: number;
  admins: number;
};

type FeedMode = "recent" | "search" | "happenings";
type Visibility = "any" | "open" | "private";

type HappeningPayload = {
  type?: string;
  actor?: string;
  target?: string;
};

const MESSAGE_KINDS = [9, 40002, 45001, 45003];
const SYSTEM_MESSAGE_KIND = 40099;
const CHANNEL_TIMELINE_KINDS = [...MESSAGE_KINDS, SYSTEM_MESSAGE_KIND];
const CHANNEL_KINDS = [39000, 39001, 39002];
const REQUIRED_NIPS = [29, 42, 50];
const RECONNECT_MAX_DELAY_MS = 30_000;

function getTag(event: NostrEvent, name: string) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
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

function relayInfoUrls(relayUrl: string) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const standard = url.toString();
  const fallback = new URL("/info", url.origin).toString();
  return standard === fallback ? [standard] : [standard, fallback];
}

async function fetchRelayInfo(relayUrl: string) {
  let lastError: unknown;

  for (const url of relayInfoUrls(relayUrl)) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/nostr+json" },
      });
      if (!response.ok) throw new Error(`NIP-11 returned ${response.status}.`);
      return (await response.json()) as RelayInfo;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not read relay information.");
}

function decodeSecret(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("nsec1")) {
    throw new Error("Enter an nsec key for this controlled local prototype.");
  }

  const decoded = nip19.decode(trimmed);
  if (decoded.type !== "nsec") throw new Error("That is not a valid nsec.");
  return decoded.data;
}

function shortKey(value: string) {
  if (!value) return "";
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function kindLabel(kind: number) {
  if (kind === 9) return "message";
  if (kind === 40002) return "channel";
  if (kind === 45001) return "forum";
  if (kind === 45003) return "comment";
  return `kind ${kind}`;
}

function timeLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
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

function safeProfile(content: string): Profile {
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === "object" ? (value as Profile) : {};
  } catch {
    return {};
  }
}

function happeningPayload(event: NostrEvent): HappeningPayload | null {
  if (event.kind !== SYSTEM_MESSAGE_KIND) return null;
  try {
    const payload = JSON.parse(event.content) as HappeningPayload;
    if (
      payload.type !== "channel_created" &&
      payload.type !== "member_joined"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function upsertEvent(list: NostrEvent[], event: NostrEvent) {
  const map = new Map(list.map((item) => [item.id, item]));
  map.set(event.id, event);
  return [...map.values()].sort((a, b) => b.created_at - a.created_at);
}

export default function Home() {
  const [relayInput, setRelayInput] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [relayUrl, setRelayUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [channelEvents, setChannelEvents] = useState<NostrEvent[]>([]);
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [threadEvents, setThreadEvents] = useState<NostrEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<NostrEvent | null>(null);
  const [query, setQuery] = useState("");
  const [selectedChannel, setSelectedChannel] = useState("all");
  const [visibility, setVisibility] = useState<Visibility>("any");
  const [author, setAuthor] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [feedMode, setFeedMode] = useState<FeedMode>("recent");
  const [loadingResults, setLoadingResults] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const secretKeyRef = useRef<Uint8Array | undefined>(undefined);
  const authEventIdRef = useRef("");
  const identityRef = useRef("");
  const activeSearchRef = useRef("");
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const challengeTimerRef = useRef<number | null>(null);
  const openSocketRef = useRef<(url: string, reconnecting: boolean) => void>(
    () => {},
  );
  const profileQueueRef = useRef(new Set<string>());
  const profileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToBottomRef = useRef(false);
  const nearBottomRef = useRef(true);
  const preserveScrollRef = useRef<{
    height: number;
    top: number;
  } | null>(null);

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
    secretKeyRef.current?.fill(0);
    secretKeyRef.current = undefined;
    authEventIdRef.current = "";
    identityRef.current = "";
    activeSearchRef.current = "";
    reconnectAttemptRef.current = 0;
    preserveScrollRef.current = null;
    shouldScrollToBottomRef.current = false;
    nearBottomRef.current = true;
    setSecretInput("");
    setRelayUrl("");
    setPubkey("");
    setProfiles({});
    setChannelEvents([]);
    setEvents([]);
    setThreadEvents([]);
    setSelectedEvent(null);
    setFeedMode("recent");
    setLoadingResults(false);
    setSessionReady(false);
    setError("");
    setPhase("idle");
  }, []);

  useEffect(() => clearSession, [clearSession]);

  const subscribeSessionData = useCallback(
    (identity: string) => {
      send(["REQ", "channels", { kinds: CHANNEL_KINDS, limit: 1000 }]);
      send([
        "REQ",
        "self-profile",
        { kinds: [0], authors: [identity], limit: 1 },
      ]);

      if (feedMode === "happenings") {
        send([
          "REQ",
          "happenings-view",
          { kinds: [SYSTEM_MESSAGE_KIND], limit: 200 },
        ]);
      } else if (feedMode === "search" && query.trim()) {
        const subscription = "search-view";
        activeSearchRef.current = subscription;
        const filter: Record<string, unknown> = {
          kinds: MESSAGE_KINDS,
          search: query.trim(),
          limit: 100,
        };
        if (selectedChannel !== "all") filter["#h"] = [selectedChannel];
        if (dateFrom) {
          filter.since = Math.floor(
            new Date(`${dateFrom}T00:00:00`).getTime() / 1000,
          );
        }
        if (dateTo) {
          filter.until = Math.floor(
            new Date(`${dateTo}T23:59:59`).getTime() / 1000,
          );
        }
        send(["REQ", subscription, filter]);
      } else if (selectedChannel !== "all") {
        send([
          "REQ",
          "channel-view",
          {
            kinds: CHANNEL_TIMELINE_KINDS,
            "#h": [selectedChannel],
            limit: 200,
          },
        ]);
        shouldScrollToBottomRef.current = true;
      } else {
        send(["REQ", "recent-view", { kinds: MESSAGE_KINDS, limit: 75 }]);
      }
      setLoadingResults(true);
    },
    [dateFrom, dateTo, feedMode, query, selectedChannel, send],
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
            secretKeyRef.current?.fill(0);
            secretKeyRef.current = undefined;
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
        if (
          subscription !== "channels" &&
          subscription !== "self-profile" &&
          !subscription.startsWith("profiles-") &&
          !subscription.startsWith("thread-")
        ) {
          setLoadingResults(false);
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
          [event.pubkey]: safeProfile(event.content),
        }));
        return;
      }

      queueProfile(event.pubkey);
      const happening = happeningPayload(event);
      if (happening?.actor) queueProfile(happening.actor);
      if (happening?.target) queueProfile(happening.target);
      if (subscription === "channels") {
        setChannelEvents((current) => upsertEvent(current, event));
      } else if (subscription.startsWith("thread-")) {
        setThreadEvents((current) => upsertEvent(current, event));
      } else if (
        MESSAGE_KINDS.includes(event.kind) ||
        (event.kind === SYSTEM_MESSAGE_KIND && happening)
      ) {
        setEvents((current) => upsertEvent(current, event));
      }
    },
    [queueProfile, subscribeSessionData],
  );

  const openSocket = useCallback(
    (nextRelayUrl: string, reconnecting: boolean) => {
      if (!secretKeyRef.current || !shouldReconnectRef.current) return;
      if (challengeTimerRef.current !== null) {
        window.clearTimeout(challengeTimerRef.current);
      }
      authEventIdRef.current = "";
      setPhase(reconnecting ? "reconnecting" : "connecting");

      const socket = new WebSocket(nextRelayUrl);
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
      socket.onerror = () => {
        setError("The relay connection failed. Retrying…");
      };
      socket.onclose = () => {
        if (challengeTimerRef.current !== null) {
          window.clearTimeout(challengeTimerRef.current);
          challengeTimerRef.current = null;
        }
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (!shouldReconnectRef.current || !secretKeyRef.current) {
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
          typeof parsed[1] === "string" &&
          secretKeyRef.current
        ) {
          const authEvent = finalizeEvent(
            {
              kind: 22242,
              created_at: Math.floor(Date.now() / 1000),
              content: "",
              tags: [
                ["relay", nextRelayUrl],
                ["challenge", parsed[1]],
              ],
            },
            secretKeyRef.current,
          );
          authEventIdRef.current = authEvent.id;
          socket.send(JSON.stringify(["AUTH", authEvent]));
          setSecretInput("");
          if (challengeTimerRef.current !== null) {
            window.clearTimeout(challengeTimerRef.current);
            challengeTimerRef.current = null;
          }
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

    let secretKey: Uint8Array | undefined;
    let nextRelayUrl = "";
    try {
      nextRelayUrl = normalizeRelayUrl(relayInput);
      secretKey = decodeSecret(secretInput);
      const nextPubkey = getPublicKey(secretKey);
      const info = await fetchRelayInfo(nextRelayUrl);
      const supported = new Set(info.supported_nips || []);
      const missing = REQUIRED_NIPS.filter((nip) => !supported.has(nip));
      if (missing.length) {
        throw new Error(
          `This relay is missing required Buzz capabilities: NIP-${missing.join(", NIP-")}.`,
        );
      }

      secretKeyRef.current?.fill(0);
      secretKeyRef.current = secretKey;
      secretKey = undefined;
      shouldReconnectRef.current = true;
      reconnectAttemptRef.current = 0;
      setSecretInput("");
      setRelayUrl(nextRelayUrl);
      setPubkey(nextPubkey);
      identityRef.current = nextPubkey;
      openSocketRef.current(nextRelayUrl, false);
    } catch (caught) {
      secretKey?.fill(0);
      secretKeyRef.current?.fill(0);
      secretKeyRef.current = undefined;
      shouldReconnectRef.current = false;
      setSecretInput("");
      setError(caught instanceof Error ? caught.message : "Could not connect.");
      setPhase("error");
    }
  }

  const allChannels = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const event of [...channelEvents].reverse()) {
      const id = getTag(event, "d") || getTag(event, "h");
      if (!id) continue;
      const current = map.get(id) || {
        id,
        name: id,
        about: "",
        type: "stream",
        isPublic: false,
        isOpen: false,
        members: 0,
        admins: 0,
      };

      if (event.kind === 39000) {
        current.name = getTag(event, "name") || current.name;
        current.about = getTag(event, "about") || current.about;
        current.picture = getTag(event, "picture") || current.picture;
        current.type =
          getTag(event, "t") || getTag(event, "channel_type") || current.type;
        current.isPublic = event.tags.some((tag) => tag[0] === "public");
        current.isOpen = event.tags.some((tag) => tag[0] === "open");
      } else if (event.kind === 39001) {
        current.admins = event.tags.filter((tag) => tag[0] === "p").length;
      } else if (event.kind === 39002) {
        current.members = event.tags.filter((tag) => tag[0] === "p").length;
      }
      map.set(id, current);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [channelEvents]);

  const channels = useMemo(
    () => allChannels.filter((channel) => channel.type !== "dm"),
    [allChannels],
  );

  const channelMap = useMemo(
    () => new Map(allChannels.map((channel) => [channel.id, channel])),
    [allChannels],
  );

  const visibleEvents = useMemo(() => {
    const authorNeedle = author.trim().toLowerCase();
    return events.filter((event) => {
      const channelId = getTag(event, "h") || "";
      if (selectedChannel !== "all" && channelId !== selectedChannel) {
        return false;
      }
      const channel = channelMap.get(channelId);
      if (channel?.type === "dm") return false;
      if (event.kind === SYSTEM_MESSAGE_KIND && !happeningPayload(event)) {
        return false;
      }
      if (visibility === "open" && !channel?.isPublic) return false;
      if (visibility === "private" && channel?.isPublic) return false;
      if (authorNeedle) {
        const profile = profiles[event.pubkey];
        const haystack = [
          event.pubkey,
          profile?.display_name,
          profile?.name,
          profile?.nip05,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(authorNeedle)) return false;
      }
      return true;
    });
  }, [
    author,
    channelMap,
    events,
    profiles,
    selectedChannel,
    visibility,
  ]);

  function runSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    closeViewSubscriptions();
    const previous = activeSearchRef.current;
    if (previous) send(["CLOSE", previous]);

    const subscription = "search-view";
    activeSearchRef.current = subscription;
    const filter: Record<string, unknown> = {
      kinds: MESSAGE_KINDS,
      search: query.trim(),
      limit: 100,
    };
    if (selectedChannel !== "all") filter["#h"] = [selectedChannel];
    if (dateFrom) {
      filter.since = Math.floor(new Date(`${dateFrom}T00:00:00`).getTime() / 1000);
    }
    if (dateTo) {
      filter.until = Math.floor(
        new Date(`${dateTo}T23:59:59`).getTime() / 1000,
      );
    }
    setEvents([]);
    setSelectedEvent(null);
    setThreadEvents([]);
    setFeedMode("search");
    setLoadingResults(true);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      send(["REQ", subscription, filter]);
    }
  }

  function closeActiveSearch() {
    if (
      activeSearchRef.current &&
      socketRef.current?.readyState === WebSocket.OPEN
    ) {
      send(["CLOSE", activeSearchRef.current]);
    }
    activeSearchRef.current = "";
  }

  function closeViewSubscriptions() {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    for (const subscription of [
      "recent-view",
      "happenings-view",
      "channel-view",
      "older-view",
    ]) {
      send(["CLOSE", subscription]);
    }
  }

  function showRecent() {
    closeViewSubscriptions();
    closeActiveSearch();
    setEvents([]);
    setSelectedEvent(null);
    setThreadEvents([]);
    setSelectedChannel("all");
    setFeedMode("recent");
    setLoadingResults(true);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      send(["REQ", "recent-view", { kinds: MESSAGE_KINDS, limit: 75 }]);
    }
  }

  function showHappenings() {
    closeViewSubscriptions();
    closeActiveSearch();
    setEvents([]);
    setSelectedEvent(null);
    setThreadEvents([]);
    setSelectedChannel("all");
    setFeedMode("happenings");
    setLoadingResults(true);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      send([
        "REQ",
        "happenings-view",
        { kinds: [SYSTEM_MESSAGE_KIND], limit: 200 },
      ]);
    }
  }

  function showChannel(channelId: string) {
    closeViewSubscriptions();
    closeActiveSearch();
    setEvents([]);
    setSelectedEvent(null);
    setThreadEvents([]);
    setSelectedChannel(channelId);
    setFeedMode("recent");
    setLoadingResults(true);
    nearBottomRef.current = true;
    shouldScrollToBottomRef.current = true;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      send([
        "REQ",
        "channel-view",
        {
          kinds: CHANNEL_TIMELINE_KINDS,
          "#h": [channelId],
          limit: 200,
        },
      ]);
    }
  }

  function loadOlder() {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    const oldest = events.at(-1)?.created_at;
    if (!oldest) return;
    const subscription = "older-view";
    send(["CLOSE", subscription]);
    setLoadingResults(true);
    const filter: Record<string, unknown> = {
      kinds: MESSAGE_KINDS,
      until: oldest - 1,
      limit: 75,
    };
    if (feedMode === "search") filter.search = query.trim();
    if (selectedChannel !== "all") filter["#h"] = [selectedChannel];
    if (feedMode === "happenings") filter.kinds = [SYSTEM_MESSAGE_KIND];
    if (selectedChannel !== "all" && feedMode !== "search") {
      filter.kinds = CHANNEL_TIMELINE_KINDS;
      const node = resultsRef.current;
      if (node) {
        preserveScrollRef.current = {
          height: node.scrollHeight,
          top: node.scrollTop,
        };
      }
    }
    send(["REQ", subscription, filter]);
  }

  function openThread(event: NostrEvent) {
    setSelectedEvent(event);
    setThreadEvents([event]);
    const markedRoot = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "root",
    )?.[1];
    const firstEventTag = event.tags.find((tag) => tag[0] === "e")?.[1];
    const rootId = markedRoot || firstEventTag || event.id;
    const subscription = `thread-${event.id.slice(0, 12)}`;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      send([
        "REQ",
        subscription,
        { ids: [...new Set([rootId, event.id])] },
        { kinds: MESSAGE_KINDS, "#e": [rootId], limit: 200 },
      ]);
    }
    window.history.pushState(null, "", `#${event.id}`);
  }

  const identityProfile = profiles[pubkey];
  const identityName =
    identityProfile?.display_name || identityProfile?.name || shortKey(pubkey);
  const relayDisplay = relayUrl.replace(/\/$/, "");
  const relayInfoUrl = relayUrl ? relayInfoUrls(relayUrl)[0] : "";
  const orderedVisibleEvents = useMemo(
    () =>
      selectedChannel !== "all" && feedMode !== "search"
        ? [...visibleEvents].sort((a, b) => a.created_at - b.created_at)
        : visibleEvents,
    [feedMode, selectedChannel, visibleEvents],
  );
  const viewTitle =
    feedMode === "search"
      ? "results"
      : feedMode === "happenings"
        ? "Channel happenings"
        : selectedChannel === "all"
          ? "Recent activity"
          : `# ${channelMap.get(selectedChannel)?.name || selectedChannel}`;

  useEffect(() => {
    if (loadingResults) return;
    const node = resultsRef.current;
    if (!node) return;

    const preserved = preserveScrollRef.current;
    if (preserved) {
      node.scrollTop = node.scrollHeight - preserved.height + preserved.top;
      preserveScrollRef.current = null;
      return;
    }

    if (
      selectedChannel !== "all" &&
      feedMode !== "search" &&
      (shouldScrollToBottomRef.current || nearBottomRef.current)
    ) {
      node.scrollTop = node.scrollHeight;
      shouldScrollToBottomRef.current = false;
    }
  }, [feedMode, loadingResults, orderedVisibleEvents.length, selectedChannel]);

  return (
    <main>
      <header className="site-header">
        <div className="relay-header">
          <a
            className="wordmark"
            href="#"
            aria-label="Buzz Inside home"
            onClick={(event) => {
              if (!sessionReady) return;
              event.preventDefault();
              showRecent();
              window.history.replaceState(null, "", window.location.pathname);
            }}
          >
            buzz inside
          </a>
          <span className="slash">/</span>
          <span>read only</span>
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
          <p className="eyebrow">private workspace search</p>
          <h1>Look inside your Buzz.</h1>
          <p className="lede">
            Connect directly to your relay. Search everything you can already
            read. Your key and workspace content stay in this tab.
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

            <div className="label-row">
              <label htmlFor="secret">nsec</label>
              <span>memory only · cleared with this session</span>
            </div>
            <input
              id="secret"
              name="secret"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="nsec1…"
              value={secretInput}
              onChange={(event) => setSecretInput(event.target.value)}
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
              {(phase === "idle" || phase === "error") && "connect →"}
            </button>
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
              this app doesn&apos;t persist your nsec; it keeps it in this tab&apos;s
              memory only to sign relay authentication events
            </p>
          </div>
        </section>
      ) : (
        <div className="workspace">
          <aside className="sidebar">
            <nav aria-label="Channels">
              <div className="nav-heading">
                <span>channels</span>
                <span>{channels.length || "—"}</span>
              </div>
              <button
                className={
                  selectedChannel === "all" && feedMode === "recent"
                    ? "channel active"
                    : "channel"
                }
                type="button"
                onClick={showRecent}
              >
                <span>Recent activity</span>
              </button>
              <button
                className={feedMode === "happenings" ? "channel active" : "channel"}
                type="button"
                onClick={showHappenings}
              >
                <span>Channel happenings</span>
              </button>
              {channels.map((channel) => (
                <button
                  className={
                    selectedChannel === channel.id ? "channel active" : "channel"
                  }
                  type="button"
                  key={channel.id}
                  onClick={() => showChannel(channel.id)}
                  title={channel.about}
                >
                  <span># {channel.name}</span>
                  <span className="visibility-mark">
                    {channel.isPublic ? "open" : "private"}
                  </span>
                </button>
              ))}
            </nav>
          </aside>

          <section className="content">
            <form className="search" onSubmit={runSearch}>
              <div className="search-line">
                <label className="sr-only" htmlFor="search">
                  Search Buzz
                </label>
                <input
                  id="search"
                  type="search"
                  placeholder="search your Buzz"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button type="submit">search →</button>
              </div>
              <details>
                <summary>filters</summary>
                <div className="filters">
                  <label>
                    <span>visibility</span>
                    <select
                      value={visibility}
                      onChange={(event) =>
                        setVisibility(event.target.value as Visibility)
                      }
                    >
                      <option value="any">any</option>
                      <option value="open">open</option>
                      <option value="private">private</option>
                    </select>
                  </label>
                  <label>
                    <span>author</span>
                    <input
                      type="text"
                      placeholder="name or pubkey"
                      value={author}
                      onChange={(event) => setAuthor(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>from</span>
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(event) => setDateFrom(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>to</span>
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(event) => setDateTo(event.target.value)}
                    />
                  </label>
                </div>
              </details>
            </form>

            <div className="result-heading">
              <div>
                <span>{viewTitle}</span>
                <span className="quiet"> {orderedVisibleEvents.length}</span>
              </div>
              {feedMode === "search" ? (
                <button className="text-button" type="button" onClick={showRecent}>
                  show recent
                </button>
              ) : null}
            </div>

            {error ? (
              <p className="inline-error" role="alert">
                relay notice: {error}
              </p>
            ) : null}

            <div
              className="results"
              aria-live="polite"
              aria-busy={loadingResults}
              ref={resultsRef}
              onScroll={(event) => {
                const node = event.currentTarget;
                nearBottomRef.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 48;
              }}
            >
              {events.length && selectedChannel !== "all" ? (
                <button
                  className="load-more"
                  type="button"
                  onClick={loadOlder}
                  disabled={loadingResults}
                >
                  load older
                </button>
              ) : null}
              {!orderedVisibleEvents.length && !loadingResults ? (
                <div className="empty">
                  <p>
                    {feedMode === "happenings"
                      ? "No channel happenings found."
                      : "No matching messages."}
                  </p>
                  {feedMode !== "happenings" ? (
                    <p>Try another query or loosen the filters.</p>
                  ) : null}
                </div>
              ) : null}
              {orderedVisibleEvents.map((event) => {
                const channel = channelMap.get(getTag(event, "h") || "");
                const happening = happeningPayload(event);
                return happening ? (
                  <Happening
                    key={event.id}
                    event={event}
                    payload={happening}
                    channel={channel}
                    profiles={profiles}
                    onSelectChannel={showChannel}
                  />
                ) : (
                  <Message
                    key={event.id}
                    event={event}
                    channel={channel}
                    profile={profiles[event.pubkey]}
                    selected={selectedEvent?.id === event.id}
                    onOpen={() => openThread(event)}
                  />
                );
              })}
              {loadingResults ? <p className="loading">reading relay…</p> : null}
              {events.length && selectedChannel === "all" ? (
                <button
                  className="load-more"
                  type="button"
                  onClick={loadOlder}
                  disabled={loadingResults}
                >
                  load older
                </button>
              ) : null}
            </div>
          </section>

          {selectedEvent ? (
            <aside className="thread" aria-label="Thread context">
              <div className="thread-header">
                <span>thread</span>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => {
                    setSelectedEvent(null);
                    setThreadEvents([]);
                    window.history.replaceState(
                      null,
                      "",
                      window.location.pathname,
                    );
                  }}
                >
                  close
                </button>
              </div>
              {threadEvents
                .slice()
                .sort((a, b) => a.created_at - b.created_at)
                .map((event) => (
                  <Message
                    compact
                    key={event.id}
                    event={event}
                    channel={channelMap.get(getTag(event, "h") || "")}
                    profile={profiles[event.pubkey]}
                  />
                ))}
            </aside>
          ) : null}
        </div>
      )}
    </main>
  );
}

function Happening({
  event,
  payload,
  channel,
  profiles,
  onSelectChannel,
}: {
  event: NostrEvent;
  payload: HappeningPayload;
  channel?: Channel;
  profiles: Record<string, Profile>;
  onSelectChannel: (channelId: string) => void;
}) {
  const subject =
    payload.type === "member_joined"
      ? payload.target || payload.actor || ""
      : payload.actor || "";
  const profile = profiles[subject];
  const name =
    profile?.display_name || profile?.name || shortKey(subject) || "Someone";
  const action =
    payload.type === "channel_created" ? "created" : "joined";

  return (
    <article className="message happening">
      <div className="message-meta">
        <time dateTime={new Date(event.created_at * 1000).toISOString()}>
          {timeLabel(event.created_at)}
        </time>
      </div>
      <div className="message-body">
        <span className="author">{name}</span> {action}{" "}
        {channel ? (
          <button
            className="channel-link"
            type="button"
            onClick={() => onSelectChannel(channel.id)}
          >
            # {channel.name}
          </button>
        ) : (
          <span># {getTag(event, "h") || "channel"}</span>
        )}
      </div>
    </article>
  );
}

function Message({
  event,
  channel,
  profile,
  selected = false,
  compact = false,
  onOpen,
}: {
  event: NostrEvent;
  channel?: Channel;
  profile?: Profile;
  selected?: boolean;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const name = profile?.display_name || profile?.name || shortKey(event.pubkey);
  const body: ReactNode = contentWithLinks(event.content);
  return (
    <article
      className={[
        "message",
        selected ? "selected" : "",
        compact ? "compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="message-meta">
        <span className="author">{name}</span>
        <span>{channel ? `# ${channel.name}` : "workspace"}</span>
        <span>{kindLabel(event.kind)}</span>
        <time dateTime={new Date(event.created_at * 1000).toISOString()}>
          {timeLabel(event.created_at)}
        </time>
      </div>
      <div className="message-body">{body}</div>
      {onOpen ? (
        <button className="thread-link" type="button" onClick={onOpen}>
          context →
        </button>
      ) : null}
    </article>
  );
}

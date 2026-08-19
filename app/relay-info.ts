export type RelayInfo = {
  supported_nips?: number[];
  limitation?: {
    max_filters?: number;
    max_limit?: number;
  };
};

type FetchRelayInfo = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function relayInfoUrls(relayUrl: string) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const standard = url.toString();
  const fallback = new URL("/info", url.origin).toString();
  return standard === fallback ? [standard] : [standard, fallback];
}

export async function fetchRelayInfo(
  relayUrl: string,
  request: FetchRelayInfo = fetch,
) {
  for (const url of relayInfoUrls(relayUrl)) {
    try {
      const response = await request(url, {
        cache: "no-store",
        headers: { Accept: "application/nostr+json" },
      });
      if (!response.ok) continue;
      return (await response.json()) as RelayInfo;
    } catch {
      // Some otherwise usable relays omit browser CORS headers for NIP-11.
      // The WebSocket connection remains the authoritative capability check.
    }
  }
  return null;
}

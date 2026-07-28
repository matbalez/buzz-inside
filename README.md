# Buzz Inside

Buzz Inside is a local-first, read-only browsing interface for private
[Buzz](https://buzz.xyz) relays. It connects directly from the browser to a
relay, authenticates with NIP-42, and lets an authorized member browse and
search the channels their identity can access.

## What it does

- discovers NIP-29 channels without including DMs
- shows recent cross-channel activity
- loads each channel at its newest activity and scrolls upward for history
- searches relay content with NIP-50
- shows channel creation and member-join events
- keeps relay browsing and thread context read-only
- automatically reconnects and re-authenticates after relay interruptions
- lets a signed-in Flint member explicitly create a six-hour contribution
  channel with a prewritten project invitation

## Security model

- no application backend or analytics
- no browser storage, cookies, or local database
- no DMs; browsing relays never receive content writes
- the nsec is decoded only in the current page's memory
- key bytes sign NIP-42 authentication events and, only after the user presses
  **fix it in buzz**, one channel-creation event and one invitation message
- key bytes are overwritten when the session is cleared or the page closes
- restrictive CSP, permissions, framing, referrer, and content-type headers

The key remains in page memory for the life of an authenticated session so the
app can reconnect without asking for it again. Use Buzz Inside only on a device,
browser, identity, and relay you trust.

## Building relay

The relay being browsed and the building relay are intentionally independent.
The **fix it in buzz** button always opens a separate temporary NIP-42
connection to `wss://flint.communities.buzz.xyz/`. Non-members are rejected
before any write. For members, the browser signs a public NIP-29 stream-channel
creation event with a six-hour idle TTL; the relay automatically makes the
signer its owner/member. The browser then signs the project invitation as the
channel's first message and closes the temporary connection after both writes
are acknowledged.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verification

```bash
npm run lint
npm test
npm audit --omit=dev
```

## Production

The project builds a standalone Node.js server and includes a minimal Fly.io
container configuration:

```bash
fly deploy
```

No server-side secrets or runtime environment variables are required.

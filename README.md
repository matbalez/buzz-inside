# Buzz Inside

Buzz Inside is a local-first, read-only browser for private
[Buzz](https://buzz.xyz) relays. It connects directly from the browser to a
relay, authenticates with NIP-42, and lets an authorized member browse and
search the channels their identity can access.

## What it does

- discovers NIP-29 channels without including DMs
- shows recent cross-channel activity
- loads each channel at its newest activity and scrolls upward for history
- searches relay content with NIP-50
- shows channel creation and member-join events
- renders thread context without exposing any write action
- automatically reconnects and re-authenticates after relay interruptions

## Security model

- no application backend or analytics
- no browser storage, cookies, or local database
- no DMs and no Nostr write paths
- the nsec is decoded only in the current page's memory
- key bytes are used only to sign NIP-42 authentication events
- key bytes are overwritten when the session is cleared or the page closes
- restrictive CSP, permissions, framing, referrer, and content-type headers

The key remains in page memory for the life of an authenticated session so the
app can reconnect without asking for it again. Use Buzz Inside only on a device,
browser, identity, and relay you trust.

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

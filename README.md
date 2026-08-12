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
are acknowledged. Once complete, a dialog shows the new channel name and offers
a `buzz://message` deep link that opens the channel at its project invitation in
the local Buzz app.

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

## GitHub Project to Buzz bridge

The `Send Ready for Design issues to Buzz` workflow polls Mat's personal
GitHub Project 1 every five minutes. For each `matbalez/buzz-inside` issue in
`Ready for Design`, it creates one permanent open Buzz stream channel, posts
the issue title/body/link, and adds a `buzz://message` deep link to an issue
comment. A hidden marker and deterministic recovery query make later runs
idempotent, including a retry after the relay write succeeds but the GitHub
comment update does not.

The workflow needs two repository secrets under **Settings → Secrets and
variables → Actions**:

- `PROJECT_TOKEN`: a classic personal access token with only `read:project`,
  used to query the personal Project. GitHub documents that scope for read-only
  Project API access: <https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects#authentication>
- `BUZZ_PRIVATE_KEY`: Mat's `nsec` (or its 64-character hex form), used only in
  the workflow runner to authenticate and sign the Buzz events. This key grants
  the full Buzz identity; never put it in source, an issue, a workflow input, or
  a command-line argument.

Set the secrets without putting either value in shell history:

```bash
gh secret set PROJECT_TOKEN --repo matbalez/buzz-inside
gh secret set BUZZ_PRIVATE_KEY --repo matbalez/buzz-inside
```

Each command prompts for the value and uploads it as an encrypted repository
secret. The relay defaults to `wss://flint.communities.buzz.xyz/`. To override
it, add the non-secret repository variable `BUZZ_RELAY_URL`.

After this workflow is merged into the default branch, test issue 11 by moving
it to `Ready for Design`, opening **Actions → Send Ready for Design issues to
Buzz → Run workflow**, entering `11`, and running it. The issue should briefly
show a provisioning comment; that same comment is then replaced with the Buzz
link. Re-running the workflow or moving the issue away and back must not create
another channel.

## Contributing

Contributions from people and their coding agents are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development and pull-request
workflow.

Buzz Inside is open source under the [MIT License](LICENSE).

## Production

The project builds a standalone Node.js server and includes a minimal Fly.io
container configuration:

```bash
fly deploy
```

No server-side secrets or runtime environment variables are required.

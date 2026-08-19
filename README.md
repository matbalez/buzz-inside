# Buzz Inside

Buzz Inside answers one question: **where is the buzz on this relay?**

It connects directly from the browser to a [Buzz](https://buzz.xyz) relay,
authenticates with NIP-42, and ranks the channels the current identity can
read. The board includes joined channels and public channels the user has not
joined yet; private channels appear only for their members, and DMs never
appear.

## How trending works

- the browser requests up to seven days of message and channel activity per
  visible channel, using the relay's advertised result ceiling
- top-level posts, direct replies, and nested replies all count as messages
- each message loses half its weight every 12 hours, so fresh activity rises
- no more than three messages from one author in one hour count toward score
- several active authors provide a small breadth bonus
- recent member joins and newly created channels receive separate, decaying
  discovery boosts without inflating the visible message total
- raw 24-hour message and author counts remain visible beside the score
- a public-channel leaderboard shows the most active users over 24 hours and
  their top three channels; NIP-OA agent identities are excluded
- channel names link directly to their latest activity in Buzz, and channel
  previews read oldest-to-newest with the latest message at the bottom
- ranking happens entirely in the current tab—there is no backend index

The score is intentionally simple and visible in the UI so it can be tuned from
real relay use instead of becoming a mysterious recommendation system.

## Security model

- no application backend, analytics, browser storage, cookies, or local database
- no DMs and no content writes
- authentication uses a user-installed NIP-07 signer such as nos2x or Alby
- the page never requests, receives, or stores the user's private key
- the signer is asked only for NIP-42 authentication events (kind `22242`)
- every signed event is checked locally against the identity, relay, challenge,
  timestamp, event ID, and signature before it is sent
- restrictive CSP, permissions, framing, referrer, and content-type headers

The authenticated relay socket exists only for the current tab. A reconnect
requires a fresh, connection-bound signature from the installed signer.

Install a NIP-07 signer before connecting:

- [nos2x for Chrome and Chromium](https://chromewebstore.google.com/detail/nos2x/kpgefcfmnafjgpblomihpgmejjdanjjp)
- [nos2x-fox for Firefox](https://addons.mozilla.org/firefox/addon/nos2x-fox/)
- [Alby for Chromium and Firefox](https://github.com/getAlby/lightning-browser-extension)

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

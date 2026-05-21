# Party P2P

A Partiful-inspired event invite PWA that keeps event data off a central application server. The PWA is a static site that can be hosted on Cloudflare Pages, GitHub Pages, Vite preview, or any other static host. A host machine separately runs:

1. A Node room peer powered by `peerjs` with Node WebRTC shims.

PeerJS Cloud is used for signaling. Event data still travels over WebRTC data channels between guests and the host-run room peer.

Guests open a QR/link, connect to the room peer over PeerJS/WebRTC data channels, and receive a live replicated event state. The first browser client that successfully joins a fresh room becomes the room admin.

This is a prototype scaffold, not a production security audit.

## Features

- Partiful-like invite UI without Partiful assets or branding.
- PeerJS/WebRTC data-channel sync.
- Host-run Node room peer using `peerjs`, `@roamhq/wrtc`, `ws`, and `xhr2`.
- Public PeerJS Cloud signaling, with no self-hosted PeerServer.
- Static PWA hosting. The room host only needs the app URL for generated invites.
- Room invite QR in the terminal and inside the PWA.
- Secure room secret in the URL hash, so it is not sent to the static web server.
- First joined guest becomes admin.
- Admin can edit event details, pin an OpenStreetMap location, pin/delete posts, and delete comments.
- Guests can RSVP, post, comment, and export their encrypted offline backup.
- PWA manifest and service worker for install/offline app shell.

## Quick start

```bash
npm install
npm run dev
npm run host:demo
```

Open the printed invite URL or scan the terminal QR code. Keep the host process running while guests are connected.

Host URL defaults live in `~/.party-p2p/.partyrc`:

```json
{
  "host": "https://robertinglin.github.io/party-p2p/"
}
```

For a deployed static app, configure the host URL, then start or restart rooms normally:

```bash
npx party-p2p configure set host https://robertinglin.github.io/party-p2p/
npm run build
npm run start -- rooftop-disco
```

Restart an existing room by session ID:

```bash
npm run start -- rooftop-disco
```

The start command reuses `host/data/<session-id>.json`, including the saved room secret and admin records.

Real environment variables override `~/.party-p2p/.partyrc`, and CLI flags such as `--app-url` override both.

## Server CLI

After the package is published, run a host from anywhere with:

```bash
npx party-p2p rooftop-disco
```

The npm CLI stores room files in `~/.party-p2p/<session-id>.json`. Starting the same session ID again reuses that file, including the saved room secret and admin records.

The CLI reads `~/.party-p2p/.partyrc` before it starts the host, so this works without passing `--app-url` every time:

```bash
npx party-p2p configure set host https://robertinglin.github.io/party-p2p/
```

Useful CLI options:

```bash
npx party-p2p rooftop-disco --app-url https://robertinglin.github.io/party-p2p/
npx party-p2p rooftop-disco --title "Rooftop Disco" --location "Brooklyn rooftop"
```

## GitHub Pages deploy

The client deploys through GitHub Actions from `.github/workflows/deploy-client.yml`. In the GitHub repo settings, set Pages source to **GitHub Actions**. Pushes to `main` build the Vite client and publish `client/dist` to:

```text
https://robertinglin.github.io/party-p2p/
```

## npm publish

The server CLI publishes through GitHub Actions from `.github/workflows/publish-npm.yml` using npm trusted publishing. In npm package settings, add a GitHub Actions trusted publisher:

```text
Owner: robertinglin
Repository: party-p2p
Workflow filename: publish-npm.yml
Allowed action: npm publish
```

Pushes to `main` that touch server/package files bump a patch version, tag it, and publish to npm. You can also run the workflow manually and choose `patch`, `minor`, or `major`.

## Host commands

```bash
npm run host -- \
  --room rooftop-disco \
  --title "Rooftop Disco" \
  --date "2026-06-20" \
  --time "8:00 PM" \
  --location "Brooklyn rooftop" \
  --app-url https://robertinglin.github.io/party-p2p/
```

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--room` | Human room name; also becomes the deterministic room peer ID. |
| `--app-url` | URL where the static PWA is hosted. Defaults to `HOST_URL` or `APP_URL`, then `host` from `~/.party-p2p/.partyrc`, then `http://localhost:4273/`. Use `https://robertinglin.github.io/party-p2p/` for GitHub Pages. |
| `--secret` | Override/generated room secret. If omitted, a random one is saved in `host/data/<room>.json`. |
| `--ice` | Comma-separated ICE server URLs. Defaults to Google STUN for convenience. |

## How it works

```text
Static PWA host ── serves HTML/CSS/JS ── Browser PWA
                                             │
                                             │ WebRTC DataConnection
                                             │
                                      Node room peer (peerjs + @roamhq/wrtc)
      │                                           │
      └──── signaling only via PeerJS Cloud ──────┘
```

PeerJS Cloud brokers PeerJS connection setup. The static app host only serves assets. The event state itself is sent through WebRTC `DataConnection` messages to the host room peer. The host room peer validates the room secret proof and admin token, applies mutations, persists state locally, then broadcasts the updated state to connected clients.

If the public PeerJS Cloud signaling socket drops, the Node host reconnects with the same room peer ID. Existing WebRTC data channels can stay open while the reconnect lets later guests join.

## First admin rule

When `host/data/<room>.json` has no admins yet, the first valid `client/hello` gets an admin token. That token is stored in the browser's local storage and must be included with admin mutations. The host stores only a hash of the token.

To reset admins during development, stop the host and delete `host/data/<room>.json`.

## Offline backup

Every state snapshot received by the PWA is encrypted with AES-GCM using a key derived from the room secret and saved to browser storage. When the app shell is offline, it can still display the most recent backup for the same room URL. The backup can also be downloaded from the app.

## Static Hosting

Service workers and some browser APIs require a secure context. `localhost` is treated as secure for development, but real mobile testing should use an HTTPS static host such as Cloudflare Pages, GitHub Pages, or another trusted static hosting service. Pass that URL to `npm run host -- --app-url ...` so QR codes and copied invite links point at the hosted app.

## NAT / WAN limitations

PeerJS Cloud removes the need to expose a host-run signaling endpoint, but WebRTC still needs peers to establish a route. LAN usage should be straightforward. Across the public internet, NATs can block direct connections; you may need configured STUN/TURN services. TURN is a relay server, so using one weakens the “no central server” goal for connectivity, though not necessarily for application state ownership.

## Project layout

```text
client/
  src/                 React PWA source
  public/              manifest, service worker, icons
host/
  host.cjs             host-run room peer and local state owner
  nodePeer.cjs         PeerJS Node shims and PeerJS Cloud client setup
  data/                local room state, created at runtime
```

## Protocol summary

- `client/hello`: client identity, room name, and room-secret proof.
- `host/welcome`: full state snapshot, role, and optional first-admin token.
- `client/mutation`: RSVP/post/comment/admin event mutation.
- `host/state`: full state snapshot broadcast after each accepted mutation.
- `host/error`: rejection or connection error.

## Production hardening ideas

- Replace whole-state broadcasts with signed append-only operation logs.
- Add admin transfer / multi-admin invite tokens.
- Add CRDT state for multi-host failover.
- Add an authenticated import flow for encrypted backups.
- Add rate limiting per peer and content-size quotas.
- Add optional E2EE payload encryption where only room members can read state, not the host process.

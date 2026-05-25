# Party P2P

A Partiful-inspired event invite PWA that keeps event data off a central application server. The PWA is a static site that can be hosted on Cloudflare Pages, GitHub Pages, Vite preview, or any other static host. A host machine runs local room state and a party relay process.

PeerJS Cloud is used for signaling. Guests open a QR/link, connect to the relay room peer over PeerJS/WebRTC data channels, and the relay routes room messages to the local host process over loopback IPC. The first browser client that successfully joins a fresh room becomes the room admin.

This is a prototype scaffold, not a production security audit.

## Features

- Partiful-like invite UI without Partiful assets or branding.
- PeerJS/WebRTC data-channel sync.
- Relay-owned PeerJS room peer using `peerjs`, `@roamhq/wrtc`, `ws`, and `xhr2`.
- Optional persistent party relay with signed, encrypted Nostr events routed over PeerJS data channels.
- Public PeerJS Cloud signaling, with no self-hosted PeerServer.
- Static PWA hosting. The room host only needs the app URL for generated invites.
- Room invite QR in the terminal and inside the PWA.
- Secure room secret in the URL hash, so it is not sent to the static web server.
- First joined guest becomes admin.
- Admin can edit event details, pin an OpenStreetMap location, lock guest nicknames, mute guest posting, pin/delete posts, and delete comments.
- Guests can RSVP, post, comment, and export their encrypted offline backup.
- PWA manifest and service worker for install/offline app shell.

## Quick start

Requires Node 22.12+ for built-in `node:sqlite` relay storage.

Pick a short slug for the party and run the host:

```bash
npx party-p2p friday-rooftop
```

Open the printed invite URL or scan the terminal QR code. Keep that terminal open while guests are connected.

The npm CLI stores room files in `~/.party-p2p/<session-id>.json`. Starting the same session ID again reuses that file, including the saved room secret and admin records.

Host URL defaults live in `~/.party-p2p/.partyrc`. Configure this once when your static client is deployed somewhere other than the built-in default:

```bash
npx party-p2p configure set host https://party-p2p.github.io/
npx party-p2p friday-rooftop
```

Real environment variables override `~/.party-p2p/.partyrc`, and CLI flags such as `--app-url` override both.

## Run Local

For local development, run the static client and the host in separate terminals:

```bash
npm install
npm run dev
```

Then start a local room host pointed at Vite:

```bash
npm run start -- friday-rooftop --app-url http://localhost:42729/
```

Or run both with one command:

```bash
npm run local -- friday-rooftop
```

The local start command reuses `host/data/<session-id>.json`, including the saved room secret and admin records.

## Server CLI

Run a host from anywhere with:

```bash
npx party-p2p rooftop-disco
```

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
| `--room` | Human room name. The invite uses the local relay's stable PeerJS room ID. |
| `--app-url` | URL where the static PWA is hosted. Defaults to `HOST_URL` or `APP_URL`, then `host` from `~/.party-p2p/.partyrc`, then `http://localhost:42729/`. Use `https://robertinglin.github.io/party-p2p/` for GitHub Pages. |
| `--secret` | Override/generated room secret. If omitted, a random one is saved in `host/data/<room>.json`. |
| `--ice` | Comma-separated ICE server URLs. Defaults to Google STUN for convenience. |

## Persistent relay

Run a relay/cache process with:

```bash
npx party-p2p relay
```

Host processes also do this automatically. On startup, `npx party-p2p <room>` connects to the local relay IPC endpoint from `~/.party-p2p/relay.json`; if that relay is not running, it starts one. Browser clients connect to the relay peer, and the relay routes `client/hello`, mutations, and Nostr messages to the local host over IPC.

Useful relay flags:

```bash
npx party-p2p relay \
  --host 127.0.0.1 \
  --port 42777 \
  --storage ~/.party-p2p/relay \
  --max-events 10000 \
  --relay-peer peerjs:party-p2p-relay-other-relay
```

The relay's local port is IPC for host processes and local tests. It stores accepted events in `events.sqlite` with Node's built-in `node:sqlite` module. The relay is not a Nostr server; it owns two PeerJS peers: a room peer for browser clients and an explicit `-relay` peer for relay-to-relay traffic. Nostr relay probes, history queries, and mirroring use the `-relay` peer so relays do not connect to crowded client rooms.

The relay accepts Nostr protocol arrays on IPC and PeerJS data channels, validates that stored events are `party-p2p` events, routes room state messages to the host process, and mirrors accepted events to configured relay peers. If a relay hint omits the suffix, it is normalized to `peerjs:<peerId>-relay`.

Accepted party events are real Nostr events signed and verified with `nostr-tools`. Chat message payloads must be encrypted with the invite room secret before publishing; the relay validates hashes and Nostr signatures but cannot read message text.

Clients keep a per-party relay book in browser storage. They remember the invite relay mesh address, relays announced by the room relay, and relays they see later in `relay.hints`. The browser can probe known `peerjs:<roomPeerId>-relay` relays with a tiny Nostr `REQ`, mark live/offline status, query live relays, dedupe events by Nostr event id, and send known relay hints back to the room relay.

Relays also learn `relayHints` from hosts and clients. Learned relay addresses are normalized, deduped, and dialed by the relay's PeerJS peer so relay-to-relay mirroring can form automatically. Relay mesh links are retried with backoff after disconnects. Persisted event catch-up uses a Merkle tree over signed Nostr event ids: relays compare roots, request mismatched branches, ask for missing event ids, and receive those events through the normal signed `["EVENT", event]` path. Room protocol traffic is relayed over that mesh too: a client can connect to any reachable low-load relay room peer, and `client/hello`, mutations, direct host replies, broadcasts, and close notices are routed between relays until they reach the host relay or client relay.

Clients ask known relay mesh peers for `relay.status` before joining the room. They prefer a live relay with the lowest advertised client load and fall back to the invite's room peer if no alternate relay can reach the host. If the selected route drops, the client refreshes relay status, reconnects to a live relay, and retries pending mutations with the same mutation ids until the host sends a matching `acceptedMutationId`. Host mutation handling is idempotent, so duplicate retries are safe.

The relay also exposes:

```text
GET /health
GET /
```

## How it works

```text
Static PWA host ── serves HTML/CSS/JS ── Browser PWA
                                             │
                                             │ WebRTC DataConnection
                                             │
                                      Party relay peer (peerjs + @roamhq/wrtc)
                                             │
                                             │ loopback IPC
                                             │
                                      Host room state process
      │
      └──── signaling only via PeerJS Cloud
```

PeerJS Cloud brokers PeerJS connection setup. The static app host only serves assets. The event state itself is sent through WebRTC `DataConnection` messages to the relay room peer. The relay forwards room protocol messages to the host process over local IPC. The host validates the room secret proof and admin token, applies mutations, persists state locally, then asks the relay to send replies or broadcast the updated state to connected clients.

If the public PeerJS Cloud signaling socket drops, the relay process owns reconnecting the stable room peer ID. Existing WebRTC data channels can stay open while the reconnect lets later guests join.

## First admin rule

When `host/data/<room>.json` has no admins yet, the first valid `client/hello` gets an admin token. That token is stored in the browser's local storage and must be included with admin mutations. The host stores only a hash of the token.

To reset admins during development, stop the host and delete `host/data/<room>.json`.

## Offline backup

Every state snapshot received by the PWA is encrypted with AES-GCM using a key derived from the room secret and saved to browser storage. When the app shell is offline, it can still display the most recent backup for the same room URL. The backup can also be downloaded from the app.

## Static Hosting

Service workers and some browser APIs require a secure context. `localhost` is treated as secure for development, but real mobile testing should use an HTTPS static host such as Cloudflare Pages, GitHub Pages, or another trusted static hosting service. Pass that URL to `npm run host -- --app-url ...` so QR codes and copied invite links point at the hosted app.

For Chrome to open QR invite links in the installed PWA, install the PWA from the same URL that the host uses for invite links. For example, if users install `https://robert.inglin.github.io/party-p2p/`, configure the host with that exact origin/path:

```bash
npx party-p2p configure set host https://robert.inglin.github.io/party-p2p/
```

The manifest uses a relative app id, start URL, and scope so the same static build works from root domains and subpaths. Chrome can then treat `#/room/...` invite URLs as in-scope launches and navigate the existing installed app window when supported.

## NAT / WAN limitations

PeerJS Cloud removes the need to expose a host-run signaling endpoint, but WebRTC still needs peers to establish a route. LAN usage should be straightforward. Across the public internet, NATs can block direct connections; you may need configured STUN/TURN services. TURN is a relay server, so using one weakens the “no central server” goal for connectivity, though not necessarily for application state ownership.

## Project layout

```text
client/
  src/                 React PWA source
  public/              manifest, service worker, icons
host/
  host.cjs             local room state owner connected to relay IPC
  relay.cjs            PeerJS room relay, IPC router, and Nostr event cache
  nodePeer.cjs         PeerJS Node shims and PeerJS Cloud client setup
  data/                local room state, created at runtime
```

## Protocol summary

- `client/hello`: client identity, room name, and room-secret proof.
- `host/welcome`: full state snapshot, role, and optional first-admin token.
- `client/mutation`: RSVP/post/comment/admin event mutation.
- `host/state`: full state snapshot broadcast after each accepted mutation.
- `host/error`: rejection or connection error.
- `["EVENT", nostrEvent]`: publish one signed encrypted party event through the room relay.
- `["REQ", subscriptionId, filter]`: query or subscribe to party relay history/live events.
- `["CLOSE", subscriptionId]`: close a relay subscription.
- `relay.hints`: share known `peerjs:<roomPeerId>-relay` relays so clients and relays can auto-mesh without dialing client rooms.
- `relay.events.root` / `relay.events.branch` / `relay.events.want`: relay-only Merkle sync for eventually consistent persisted event logs.

## Production hardening ideas

- Replace whole-state broadcasts with signed append-only operation logs.
- Add admin transfer / multi-admin invite tokens.
- Add CRDT state for multi-host failover.
- Add an authenticated import flow for encrypted backups.
- Add rate limiting per peer and content-size quotas.
- Add optional E2EE payload encryption where only room members can read state, not the host process.

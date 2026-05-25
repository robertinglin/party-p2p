# Architecture notes

## Roles

- **PeerJS Cloud**: public signaling service. It helps peers find each other and exchange connection metadata.
- **Party relay**: long-lived PeerJS room peer/cache process. It owns the public room peer ID for browser clients and a separate explicit `-relay` PeerJS ID for relay-to-relay traffic. It routes room protocol messages to the host over local IPC, stores signed `party-p2p` Nostr events in `node:sqlite`, serves history by party, and mirrors accepted events to other party relays.
- **Host process**: local state owner connected to the relay through a loopback IPC WebSocket. It validates room secret proofs and admin tokens, persists room state locally, and asks the relay to reply/broadcast to clients.
- **Static app host**: any static hosting service that serves the built PWA assets.
- **Browser PWA**: installable event app. It connects to the relay room peer, renders event details, writes mutations, shows QR sharing, and saves encrypted local backups.
- **OpenStreetMap**: public map tiles and search used by the browser UI for venue pinning. Map coordinates are stored in room state.

## Why not one browser as host?

A browser tab can be a PeerJS peer, but it disappears when closed. The relay process gives rooms a stable PeerJS ID while still keeping app data on the host machine rather than a third-party app server.

PeerJS Cloud is only used for signaling. The static app host only serves assets. Application state is sent over WebRTC data channels between browser clients and the relay room peer, then routed to the host process over loopback IPC.

The relay keeps the stable room ID and reconnects to PeerJS Cloud if the signaling socket drops. That preserves the public-cloud setup path without requiring a host-run PeerServer.

The host reads app URL defaults from `~/.party-p2p/.partyrc`; `host` is the static app address used to generate invite links. Real `APP_URL` or `HOST_URL` environment variables override the rc file, and command-line flags override both. The npm CLI stores reusable room files beside that rc file in `~/.party-p2p/<session-id>.json`, and the relay identity/IPC address in `~/.party-p2p/relay.json`.

## Security model

The QR URL carries a random room secret in the fragment. Browsers do not send fragments to HTTP servers. The client sends a SHA-256 room proof derived from the secret, room name, and client ID. The host verifies the proof without receiving the raw secret.

The first valid guest in a new room receives an admin token. Admin mutations must include that token; the host stores only a SHA-256 hash of it.

Persistent relay chat events use the same room secret as a shared encryption secret. The relay validates event hashes and Nostr signatures with `nostr-tools`, then persists ciphertext payloads locally and mirrors them over PeerJS data channels. Relay operators and clients without the invite secret can see party IDs, timestamps, and sender public keys, but not chat message text.

Clients maintain a per-party relay book in browser storage. Invite relays, relay announcements from the room relay, and relays carried by other clients are stored as `peerjs:<roomPeerId>-relay` addresses. Clients can probe those relay mesh peers with Nostr `REQ` messages, mark them live/offline, query live relays, and merge verified events by id.

Relays learn relay hints from host registration, client hello messages, and `relay.hints` messages. A relay normalizes and dedupes those addresses, appends `-relay` when needed, dials newly learned relay mesh peers through PeerJS, retries disconnected mesh links with backoff, and relies on event id dedupe to prevent mirror loops. Persisted event logs converge through Merkle reconciliation over individual signed Nostr event ids. Relays exchange `relay.events.root`, request mismatched branches, send `relay.events.want` for missing ids, and transfer missing entries as ordinary signed `EVENT` messages, so the same validation and dedupe path handles live mirroring and catch-up. The relay mesh also carries room protocol envelopes, so clients do not need to attach directly to the host relay. `client/hello`, mutations, host replies, broadcasts, and close notices are flooded or routed through relay peers with relay-scoped client ids and message-id dedupe.

Before joining a room, clients query known `-relay` mesh peers for `relay.status`. The selected room peer is the live relay with the lowest advertised client load, with the invite room peer as the fallback. If a route drops, the client marks that relay offline, refreshes relay status, reconnects, and retries pending mutations with the same ids until the host acknowledges them. A reconnect also receives the latest host state, so missed broadcasts are healed by the next `host/welcome` or mutation ack.

This model protects casual access but is not a complete security architecture for hostile networks. Use HTTPS for real deployments.

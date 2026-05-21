# Architecture notes

## Roles

- **PeerJS Cloud**: public signaling service. It helps peers find each other and exchange connection metadata.
- **Room peer**: host-run Node process using `peerjs` with Node WebRTC/browser shims. It owns room state, validates mutations, persists state locally, and broadcasts snapshots.
- **Static app host**: any static hosting service that serves the built PWA assets.
- **Browser PWA**: installable event app. It connects to the room peer, renders event details, writes mutations, shows QR sharing, and saves encrypted local backups.
- **OpenStreetMap**: public map tiles and search used by the browser UI for venue pinning. Map coordinates are stored in room state.

## Why not one browser as host?

A browser tab can be a PeerJS peer, but it disappears when closed. The Node room peer gives the room a stable deterministic peer ID derived from the room name, while still keeping app data on the host machine rather than a third-party app server.

PeerJS Cloud is only used for signaling. The static app host only serves assets. Application state is sent over WebRTC data channels between browser clients and the Node room peer.

The Node room peer keeps the deterministic room ID and reconnects to PeerJS Cloud if the signaling socket drops. That preserves the public-cloud setup path without requiring a host-run PeerServer.

The room peer reads host defaults from the project `.env`; `HOST_URL` is the static app address used to generate invite links.

## Security model

The QR URL carries a random room secret in the fragment. Browsers do not send fragments to HTTP servers. The client sends a SHA-256 room proof derived from the secret, room name, and client ID. The host verifies the proof without receiving the raw secret.

The first valid guest in a new room receives an admin token. Admin mutations must include that token; the host stores only a SHA-256 hash of it.

This model protects casual access but is not a complete security architecture for hostile networks. Use HTTPS for real deployments.

export type RelaySource = "invite" | "host" | "client" | "relay";

export type KnownRelay = {
  address: string;
  firstSeenAt: number;
  lastSeenAt: number;
  lastLiveAt?: number;
  lastFailedAt?: number;
  lastLoad?: number;
  roomPeerId?: string;
  source?: RelaySource;
};

const RELAY_BOOK_PREFIX = "party-p2p:relays:";
const RELAY_MESH_SUFFIX = "-relay";
const memoryStorage = new Map<string, string>();

function storageKey(partyId: string): string {
  return `${RELAY_BOOK_PREFIX}${partyId}`;
}

function readStorage(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    return value ?? memoryStorage.get(key) ?? null;
  } catch {
    return memoryStorage.get(key) ?? null;
  }
}

function writeStorage(key: string, value: string): void {
  memoryStorage.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Hardened browser storage settings can reject writes; keep session memory.
  }
}

export function relayPeerIdFromAddress(address: string): string | undefined {
  const trimmed = String(address || "").trim();
  if (!trimmed) return undefined;
  const rawPeerId = trimmed.startsWith("peerjs:") ? trimmed.slice("peerjs:".length) : trimmed;
  if (!/^[a-zA-Z0-9_-]{3,128}$/.test(rawPeerId)) return undefined;
  if (rawPeerId.endsWith(RELAY_MESH_SUFFIX)) return rawPeerId;
  return `${rawPeerId.slice(0, 128 - RELAY_MESH_SUFFIX.length)}${RELAY_MESH_SUFFIX}`;
}

export function normalizeRelayAddress(address: string): string | undefined {
  const peerId = relayPeerIdFromAddress(address);
  return peerId ? `peerjs:${peerId}` : undefined;
}

export function roomPeerIdFromRelayAddress(address: string): string | undefined {
  const peerId = relayPeerIdFromAddress(address);
  if (!peerId) return undefined;
  return peerId.endsWith(RELAY_MESH_SUFFIX) ? peerId.slice(0, -RELAY_MESH_SUFFIX.length) : peerId;
}

export function loadKnownRelays(partyId: string): KnownRelay[] {
  const raw = readStorage(storageKey(partyId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as KnownRelay[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((relay) => Boolean(normalizeRelayAddress(relay.address)));
  } catch {
    return [];
  }
}

function saveKnownRelays(partyId: string, relays: KnownRelay[]): KnownRelay[] {
  const deduped = new Map<string, KnownRelay>();
  for (const relay of relays) {
    const address = normalizeRelayAddress(relay.address);
    if (!address) continue;
    const existing = deduped.get(address);
    deduped.set(address, {
      ...existing,
      ...relay,
      address,
      roomPeerId: relay.roomPeerId || roomPeerIdFromRelayAddress(address),
      lastLoad: relay.lastLoad ?? existing?.lastLoad,
      firstSeenAt: Math.min(existing?.firstSeenAt ?? relay.firstSeenAt, relay.firstSeenAt),
      lastSeenAt: Math.max(existing?.lastSeenAt ?? relay.lastSeenAt, relay.lastSeenAt)
    });
  }
  const sorted = Array.from(deduped.values()).sort((left, right) => {
    return (right.lastLiveAt || right.lastSeenAt) - (left.lastLiveAt || left.lastSeenAt);
  });
  writeStorage(storageKey(partyId), JSON.stringify(sorted));
  return sorted;
}

export function rememberRelay(partyId: string, address: string, source: RelaySource = "client", now = Date.now()): KnownRelay[] {
  const normalized = normalizeRelayAddress(address);
  if (!normalized) return loadKnownRelays(partyId);
  const relays = loadKnownRelays(partyId);
  const existing = relays.find((relay) => relay.address === normalized);
  const next: KnownRelay = {
    ...existing,
    address: normalized,
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now,
    source
  };
  return saveKnownRelays(partyId, [next, ...relays.filter((relay) => relay.address !== normalized)]);
}

export function rememberRelays(partyId: string, addresses: string[], source: RelaySource = "client", now = Date.now()): KnownRelay[] {
  let relays = loadKnownRelays(partyId);
  for (const address of addresses) {
    const normalized = normalizeRelayAddress(address);
    if (!normalized) continue;
    const existing = relays.find((relay) => relay.address === normalized);
    const next: KnownRelay = {
      ...existing,
      address: normalized,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
      source
    };
    relays = [next, ...relays.filter((relay) => relay.address !== normalized)];
  }
  return saveKnownRelays(partyId, relays);
}

export function markRelayLive(partyId: string, address: string, now = Date.now()): KnownRelay[] {
  const normalized = normalizeRelayAddress(address);
  if (!normalized) return loadKnownRelays(partyId);
  const relays = loadKnownRelays(partyId);
  const existing = relays.find((relay) => relay.address === normalized);
  return saveKnownRelays(partyId, [
    {
      ...existing,
      address: normalized,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
      lastLiveAt: now
    },
    ...relays.filter((relay) => relay.address !== normalized)
  ]);
}

export function markRelayOffline(partyId: string, address: string, now = Date.now()): KnownRelay[] {
  const normalized = normalizeRelayAddress(address);
  if (!normalized) return loadKnownRelays(partyId);
  const relays = loadKnownRelays(partyId);
  const existing = relays.find((relay) => relay.address === normalized);
  if (!existing) return relays;
  return saveKnownRelays(partyId, [
    {
      ...existing,
      lastSeenAt: now,
      lastFailedAt: now
    },
    ...relays.filter((relay) => relay.address !== normalized)
  ]);
}

export function markRelayStatus(
  partyId: string,
  address: string,
  status: { roomPeerId?: string; load?: { clients?: number } },
  now = Date.now()
): KnownRelay[] {
  const normalized = normalizeRelayAddress(address);
  if (!normalized) return loadKnownRelays(partyId);
  const relays = loadKnownRelays(partyId);
  const existing = relays.find((relay) => relay.address === normalized);
  return saveKnownRelays(partyId, [
    {
      ...existing,
      address: normalized,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
      lastLiveAt: now,
      lastLoad: typeof status.load?.clients === "number" ? status.load.clients : existing?.lastLoad,
      roomPeerId: status.roomPeerId || existing?.roomPeerId || roomPeerIdFromRelayAddress(normalized)
    },
    ...relays.filter((relay) => relay.address !== normalized)
  ]);
}

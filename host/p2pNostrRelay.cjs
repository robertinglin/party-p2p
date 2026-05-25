const crypto = require("node:crypto");
const { matchFilters } = require("nostr-tools/filter");
const { PARTY_NOSTR_KIND, nostrEventToPartyEvent, validatePartyEvent } = require("./partyEvent.cjs");

const RELAY_ADDRESS_PREFIX = "peerjs:";
const RELAY_MESH_SUFFIX = "-relay";
const DEFAULT_MAX_RELAY_EVENTS = 10000;
const MERKLE_PROTOCOL_VERSION = 1;
const MERKLE_LEAF_EVENT_LIMIT = 16;
const MERKLE_MAX_WANT_IDS = 200;
const HEX_PREFIX_PATTERN = /^[0-9a-f]{0,64}$/;

function isNostrMessage(message) {
  return Array.isArray(message) && ["EVENT", "REQ", "CLOSE"].includes(message[0]);
}

function isMerkleMessage(message) {
  return Boolean(message && typeof message === "object" && typeof message.type === "string" && message.type.startsWith("relay.events."));
}

function relayAddressForPeerId(peerId) {
  return `${RELAY_ADDRESS_PREFIX}${peerId}`;
}

function relayMeshPeerIdForRoomPeerId(peerId) {
  const value = String(peerId || "").trim();
  if (!value) return undefined;
  return `${value.slice(0, 128 - RELAY_MESH_SUFFIX.length)}${RELAY_MESH_SUFFIX}`;
}

function relayMeshPeerIdFromAddressPeerId(peerId) {
  const value = String(peerId || "").trim();
  if (!value) return undefined;
  if (value.endsWith(RELAY_MESH_SUFFIX)) return value.slice(0, 128);
  return `${value.slice(0, 128 - RELAY_MESH_SUFFIX.length)}${RELAY_MESH_SUFFIX}`;
}

function relayMeshAddressForPeerId(peerId) {
  const meshPeerId = relayMeshPeerIdForRoomPeerId(peerId);
  return meshPeerId ? relayAddressForPeerId(meshPeerId) : undefined;
}

function relayMeshAddressFromAddress(address) {
  const peerId = peerIdFromRelayAddress(address);
  const meshPeerId = relayMeshPeerIdFromAddressPeerId(peerId);
  return meshPeerId ? relayAddressForPeerId(meshPeerId) : undefined;
}

function peerIdFromRelayAddress(address) {
  if (typeof address !== "string") return undefined;
  const trimmed = address.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith(RELAY_ADDRESS_PREFIX) ? trimmed.slice(RELAY_ADDRESS_PREFIX.length) : trimmed;
}

function randomRelayPeerId(roomName = "relay") {
  const suffix = crypto.randomBytes(8).toString("base64url").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return `party-p2p-${roomName}-${suffix}`.slice(0, 120);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sendMessage(conn, message) {
  try {
    if (conn.open === false) return;
    conn.send(message);
  } catch {
    // Closed WebRTC data channels are expected during mobile sleep/reconnects.
  }
}

const sendNostr = sendMessage;

function sortedEventIds(events) {
  return Array.from(events.keys()).sort();
}

function merkleHash(kind, parts) {
  return sha256Hex(`party-p2p:relay-events:v1:${kind}:${parts.join("|")}`);
}

function summarizeMerkleIds(prefix, ids) {
  if (ids.length <= MERKLE_LEAF_EVENT_LIMIT || prefix.length >= 64) {
    return {
      prefix,
      count: ids.length,
      hash: merkleHash("leaf", ids),
      ids
    };
  }

  const groups = new Map();
  for (const id of ids) {
    const childPrefix = `${prefix}${id[prefix.length]}`;
    const group = groups.get(childPrefix) || [];
    group.push(id);
    groups.set(childPrefix, group);
  }

  const children = Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([childPrefix, childIds]) => summarizeMerkleIds(childPrefix, childIds));
  return {
    prefix,
    count: ids.length,
    hash: merkleHash("branch", children.map((child) => `${child.prefix}:${child.count}:${child.hash}`)),
    children: children.map((child) => ({
      prefix: child.prefix,
      count: child.count,
      hash: child.hash
    }))
  };
}

function isValidMerklePrefix(value) {
  return typeof value === "string" && HEX_PREFIX_PATTERN.test(value);
}

function eventIdPartyId(event) {
  const tag = event.tags.find((item) => item[0] === "d");
  return tag?.[1] || "";
}

function validateRelayEvent(nostrEvent, validationOptions) {
  if (!nostrEvent || typeof nostrEvent !== "object" || nostrEvent.kind !== PARTY_NOSTR_KIND) {
    return { ok: false, code: "invalid", message: "Only party-p2p Nostr events are accepted" };
  }

  let partyEvent;
  try {
    partyEvent = nostrEventToPartyEvent(nostrEvent);
  } catch {
    return { ok: false, code: "invalid", message: "Invalid party-p2p Nostr event" };
  }

  const validation = validatePartyEvent(partyEvent, validationOptions);
  if (!validation.ok) return validation;
  return { ok: true, event: partyEvent };
}

class P2PNostrRelay {
  constructor(options = {}) {
    this.events = new Map();
    this.subscriptions = new Map();
    this.relayConnections = new Set();
    this.maxEvents = options.maxEvents || DEFAULT_MAX_RELAY_EVENTS;
    this.storage = options.storage;
    this.validationOptions = {
      requireEncryptedChat: true,
      ...options.validationOptions
    };

    for (const event of this.storage?.loadEvents() || []) {
      const validation = validateRelayEvent(event, this.validationOptions);
      if (validation.ok) this.events.set(event.id, event);
    }
  }

  attachConnection(conn, options = {}) {
    this.subscriptions.set(conn, new Map());
    if (options.relayPeer) this.relayConnections.add(conn);

    conn.on("data", (message) => {
      if (isNostrMessage(message)) this.handleMessage(conn, message);
      else if (isMerkleMessage(message)) this.handleMerkleMessage(conn, message);
    });
    conn.on("close", () => this.detachConnection(conn));
    conn.on("error", () => this.detachConnection(conn));

    if (options.relayPeer) {
      this.sendMerkleRoot(conn);
    }
  }

  detachConnection(conn) {
    this.subscriptions.delete(conn);
    this.relayConnections.delete(conn);
  }

  connectRelayPeer(peer, relayAddress) {
    const peerId = relayMeshPeerIdFromAddressPeerId(peerIdFromRelayAddress(relayAddress));
    if (!peerId || peerId === peer.id) return undefined;

    const conn = peer.connect(peerId, {
      reliable: true,
      serialization: "json",
      metadata: {
        partyP2PRelay: true
      }
    });
    conn.on("open", () => this.attachConnection(conn, { relayPeer: true }));
    return conn;
  }

  handleMessage(conn, message) {
    switch (message[0]) {
      case "EVENT":
        this.handleEvent(conn, message);
        break;
      case "REQ":
        this.handleReq(conn, message);
        break;
      case "CLOSE":
        this.handleClose(conn, message);
        break;
    }
  }

  handleMerkleMessage(conn, message) {
    switch (message.type) {
      case "relay.events.root":
        this.handleMerkleRoot(conn, message);
        break;
      case "relay.events.branch.request":
        this.handleMerkleBranchRequest(conn, message);
        break;
      case "relay.events.branch":
        this.handleMerkleBranch(conn, message);
        break;
      case "relay.events.want":
        this.handleMerkleWant(conn, message);
        break;
    }
  }

  handleEvent(conn, message) {
    const nostrEvent = typeof message[1] === "object" ? message[1] : message[2];
    const result = this.publish(nostrEvent, conn);
    if (typeof message[1] === "object") {
      sendNostr(conn, ["OK", nostrEvent?.id || "", result.ok, result.message || ""]);
    }
  }

  handleReq(conn, message) {
    const subscriptionId = String(message[1] || "");
    const filters = message.slice(2).filter((filter) => filter && typeof filter === "object");
    if (!subscriptionId || filters.length === 0) {
      sendNostr(conn, ["NOTICE", "REQ requires a subscription id and at least one filter"]);
      return;
    }

    this.subscriptions.get(conn)?.set(subscriptionId, filters);
    for (const event of this.query(filters)) {
      sendNostr(conn, ["EVENT", subscriptionId, event]);
    }
    sendNostr(conn, ["EOSE", subscriptionId]);
  }

  handleClose(conn, message) {
    this.subscriptions.get(conn)?.delete(String(message[1] || ""));
  }

  publish(nostrEvent, originConn) {
    const validation = validateRelayEvent(nostrEvent, this.validationOptions);
    if (!validation.ok) return { ok: false, message: validation.message };
    if (this.events.has(nostrEvent.id)) return { ok: true, duplicate: true, message: "duplicate" };

    this.events.set(nostrEvent.id, nostrEvent);
    const removedIds = this.trimEvents();
    this.storage?.insertEvent(nostrEvent);
    if (removedIds.length > 0) this.storage?.deleteEvents(removedIds);
    this.broadcast(nostrEvent, originConn);
    this.mirror(nostrEvent, originConn);
    this.announceMerkleRoot(originConn);
    return { ok: true, duplicate: false };
  }

  eventIdsForPrefix(prefix = "") {
    return sortedEventIds(this.events).filter((id) => id.startsWith(prefix));
  }

  merkleBranch(prefix = "") {
    if (!isValidMerklePrefix(prefix)) return undefined;
    return summarizeMerkleIds(prefix, this.eventIdsForPrefix(prefix));
  }

  merkleRoot() {
    return this.merkleBranch("");
  }

  sendMerkleRoot(conn) {
    const root = this.merkleRoot();
    sendMessage(conn, {
      type: "relay.events.root",
      version: MERKLE_PROTOCOL_VERSION,
      count: root.count,
      root: root.hash
    });
  }

  announceMerkleRoot(originConn) {
    for (const conn of this.relayConnections) {
      if (conn !== originConn) this.sendMerkleRoot(conn);
    }
  }

  sendMerkleBranchRequest(conn, prefix) {
    sendMessage(conn, {
      type: "relay.events.branch.request",
      version: MERKLE_PROTOCOL_VERSION,
      prefix
    });
  }

  sendMerkleBranch(conn, prefix) {
    const branch = this.merkleBranch(prefix);
    if (!branch) return;
    sendMessage(conn, {
      type: "relay.events.branch",
      version: MERKLE_PROTOCOL_VERSION,
      branch
    });
  }

  sendMerkleWant(conn, ids) {
    const missingIds = ids.filter((id) => typeof id === "string" && !this.events.has(id)).slice(0, MERKLE_MAX_WANT_IDS);
    if (missingIds.length === 0) return;
    sendMessage(conn, {
      type: "relay.events.want",
      version: MERKLE_PROTOCOL_VERSION,
      ids: missingIds
    });
  }

  handleMerkleRoot(conn, message) {
    if (message.version !== MERKLE_PROTOCOL_VERSION) return;
    const local = this.merkleRoot();
    if (message.root === local.hash && message.count === local.count) return;
    this.sendMerkleBranchRequest(conn, "");
    this.sendMerkleBranch(conn, "");
  }

  handleMerkleBranchRequest(conn, message) {
    if (message.version !== MERKLE_PROTOCOL_VERSION || !isValidMerklePrefix(message.prefix)) return;
    this.sendMerkleBranch(conn, message.prefix);
  }

  handleMerkleBranch(conn, message) {
    if (message.version !== MERKLE_PROTOCOL_VERSION) return;
    const branch = message.branch;
    if (!branch || !isValidMerklePrefix(branch.prefix) || typeof branch.hash !== "string") return;

    const local = this.merkleBranch(branch.prefix);
    if (!local || (local.hash === branch.hash && local.count === branch.count)) return;

    if (Array.isArray(branch.ids)) {
      this.sendMerkleWant(conn, branch.ids);
      return;
    }

    const children = Array.isArray(branch.children) ? branch.children : [];
    for (const child of children) {
      if (!child || !isValidMerklePrefix(child.prefix) || typeof child.hash !== "string") continue;
      const localChild = this.merkleBranch(child.prefix);
      if (!localChild || localChild.hash !== child.hash || localChild.count !== child.count) {
        this.sendMerkleBranchRequest(conn, child.prefix);
      }
    }
  }

  handleMerkleWant(conn, message) {
    if (message.version !== MERKLE_PROTOCOL_VERSION || !Array.isArray(message.ids)) return;
    for (const id of message.ids.slice(0, MERKLE_MAX_WANT_IDS)) {
      const event = this.events.get(id);
      if (event) sendNostr(conn, ["EVENT", event]);
    }
  }

  query(filters) {
    return Array.from(this.events.values())
      .filter((event) => matchFilters(filters, event))
      .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
  }

  broadcast(nostrEvent, originConn) {
    for (const [conn, subscriptions] of this.subscriptions) {
      if (conn === originConn && this.relayConnections.has(conn)) continue;
      for (const [subscriptionId, filters] of subscriptions) {
        if (matchFilters(filters, nostrEvent)) sendNostr(conn, ["EVENT", subscriptionId, nostrEvent]);
      }
    }
  }

  mirror(nostrEvent, originConn) {
    for (const conn of this.relayConnections) {
      if (conn !== originConn) sendNostr(conn, ["EVENT", nostrEvent]);
    }
  }

  trimEvents() {
    if (this.events.size <= this.maxEvents) return [];
    const keep = Array.from(this.events.values())
      .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))
      .slice(-this.maxEvents);
    const keepIds = new Set(keep.map((event) => event.id));
    const removedIds = Array.from(this.events.keys()).filter((id) => !keepIds.has(id));
    this.events = new Map(keep.map((event) => [event.id, event]));
    return removedIds;
  }

  stats() {
    const parties = new Set();
    for (const event of this.events.values()) {
      const partyId = eventIdPartyId(event);
      if (partyId) parties.add(partyId);
    }
    return {
      parties: parties.size,
      events: this.events.size,
      relayConnections: this.relayConnections.size
    };
  }
}

module.exports = {
  DEFAULT_MAX_RELAY_EVENTS,
  MERKLE_LEAF_EVENT_LIMIT,
  MERKLE_PROTOCOL_VERSION,
  P2PNostrRelay,
  isMerkleMessage,
  isNostrMessage,
  peerIdFromRelayAddress,
  randomRelayPeerId,
  relayAddressForPeerId,
  relayMeshAddressFromAddress,
  relayMeshAddressForPeerId,
  relayMeshPeerIdFromAddressPeerId,
  relayMeshPeerIdForRoomPeerId
};

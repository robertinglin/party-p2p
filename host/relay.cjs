#!/usr/bin/env node

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { createNodePeer } = require("./nodePeer.cjs");
const { userDataDir } = require("./partyRc.cjs");
const { DEFAULT_RELAY_IPC_HOST, DEFAULT_RELAY_IPC_PORT, ensureRelayConfig } = require("./relayConfig.cjs");
const {
  P2PNostrRelay,
  isNostrMessage,
  peerIdFromRelayAddress,
  relayMeshAddressFromAddress,
  relayMeshAddressForPeerId,
  relayMeshPeerIdFromAddressPeerId,
  relayMeshPeerIdForRoomPeerId
} = require("./p2pNostrRelay.cjs");
const { createSqliteRelayStorage } = require("./sqliteRelayStorage.cjs");

const DEFAULT_MAX_EVENTS = 10000;
const MAX_SEEN_RELAY_MESSAGES = 1000;
const RELAY_RECONNECT_BASE_MS = 1000;
const RELAY_RECONNECT_MAX_MS = 30000;
let ipcClientSeq = 0;

function defaultStoragePath() {
  return path.join(userDataDir(), "relay");
}

function resolveStoragePath(value) {
  const raw = String(value || defaultStoragePath());
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return path.resolve(raw);
}

function parseRelayPeers(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIceServers(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((urls) => ({ urls }));
}

function parseArgs(argv) {
  const args = {
    ipcHost: process.env.PARTY_P2P_RELAY_IPC_HOST || DEFAULT_RELAY_IPC_HOST,
    ipcPort: Number(process.env.PARTY_P2P_RELAY_IPC_PORT || DEFAULT_RELAY_IPC_PORT),
    storagePath: process.env.PARTY_P2P_RELAY_STORAGE || defaultStoragePath(),
    relayPeerId: process.env.PARTY_P2P_RELAY_PEER_ID || undefined,
    relayPeers: parseRelayPeers(process.env.PARTY_P2P_RELAY_PEERS),
    maxEvents: Number(process.env.PARTY_P2P_RELAY_MAX_EVENTS || DEFAULT_MAX_EVENTS),
    iceServers: process.env.ICE_SERVERS || "stun:stun.l.google.com:19302"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    switch (key) {
      case "host":
      case "ipc-host":
        args.ipcHost = value;
        index += 1;
        break;
      case "port":
      case "ipc-port":
        args.ipcPort = Number(value);
        index += 1;
        break;
      case "storage":
        args.storagePath = value;
        index += 1;
        break;
      case "relay-peer-id":
        args.relayPeerId = value;
        index += 1;
        break;
      case "relay-peer":
        args.relayPeers.push(value);
        index += 1;
        break;
      case "max-events":
        args.maxEvents = Number(value);
        index += 1;
        break;
      case "ice":
        args.iceServers = value;
        index += 1;
        break;
      default:
        console.warn(`Unknown relay option: ${token}`);
    }
  }

  args.storagePath = resolveStoragePath(args.storagePath);
  return args;
}

class WebSocketRelayConnection {
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    this.peer = `ipc_${++ipcClientSeq}`;
    this.handlers = {
      data: [],
      close: [],
      error: []
    };

    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        this.send(["NOTICE", "Invalid JSON"]);
        return;
      }
      for (const handler of this.handlers.data) handler(message);
    });
    socket.on("close", () => {
      this.open = false;
      for (const handler of this.handlers.close) handler();
    });
    socket.on("error", (error) => {
      this.open = false;
      for (const handler of this.handlers.error) handler(error);
    });
  }

  send(message) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.socket.close();
  }

  on(event, callback) {
    this.handlers[event]?.push(callback);
  }
}

function createPartyRelay(options = {}) {
  const relayConfig = ensureRelayConfig({
    dataDir: options.dataDir,
    ipcHost: options.ipcHost || options.host,
    ipcPort: options.ipcPort ?? options.port,
    relayPeerId: options.relayPeerId
  });
  const config = {
    ipcHost: options.ipcHost || options.host || relayConfig.ipcHost,
    ipcPort: Number.isInteger(options.ipcPort) ? options.ipcPort : Number.isInteger(options.port) ? options.port : relayConfig.ipcPort,
    storagePath: options.storagePath || defaultStoragePath(),
    relayPeerId: options.relayPeerId || relayConfig.relayPeerId,
    relayMeshPeerId: relayMeshPeerIdForRoomPeerId(options.relayPeerId || relayConfig.relayPeerId),
    relayAddress: relayMeshAddressForPeerId(options.relayPeerId || relayConfig.relayPeerId),
    relayPeers: options.relayPeers || [],
    maxEvents: options.maxEvents || DEFAULT_MAX_EVENTS,
    iceServers: options.iceServers || [{ urls: "stun:stun.l.google.com:19302" }],
    startPeer: options.startPeer !== false
  };

  const startedAt = Date.now();
  const storage = options.storage || createSqliteRelayStorage(config.storagePath);
  const relay = new P2PNostrRelay({
    maxEvents: config.maxEvents,
    storage
  });
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  const clientConnections = new Map();
  const clientRooms = new Map();
  const clientRoutes = new Map();
  const hostConnections = new Map();
  const knownRelayAddresses = new Set(config.relayPeers.map(normalizeRelayAddress).filter(Boolean));
  const icedRelayAddresses = new Set();
  const relayConnections = new Set();
  const relayConnectionByAddress = new Map();
  const relayReconnectTimers = new Map();
  const relayReconnectDelays = new Map();
  const remoteClientRoutes = new Map();
  const seenRelayMessageIds = new Set();
  const seenRelayMessageOrder = [];
  let relayMessageSeq = 0;
  let roomPeer;
  let relayPeer;
  let closePromise;
  let closing = false;

  function debugRelay(message) {
    if (process.env.PARTY_P2P_RELAY_DEBUG === "1") console.log(`party-p2p relay debug: ${message}`);
  }

  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const body = JSON.stringify({
        ok: true,
        protocol: "party-p2p-peer-relay",
        version: 1,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        relayPeerId: config.relayPeerId,
        relayMeshPeerId: config.relayMeshPeerId,
        relayAddress: config.relayAddress,
        roomHosts: hostConnections.size,
        clients: clientConnections.size,
        knownRelays: knownRelayAddresses.size,
        icedRelays: icedRelayAddresses.size,
        relayLoad: relayLoad(),
        ...relay.stats()
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
      return;
    }

    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("party-p2p peer relay\n\nThis is not a Nostr server.\nIt routes Nostr protocol messages over party-p2p PeerJS data channels.\n");
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket) => {
    attachConnection(new WebSocketRelayConnection(socket));
  });

  function normalizeRelayAddress(address) {
    return relayMeshAddressFromAddress(address);
  }

  function learnRelayAddress(address) {
    const normalized = normalizeRelayAddress(address);
    if (!normalized || normalized === config.relayAddress) return;
    knownRelayAddresses.add(normalized);
    connectKnownRelay(normalized);
  }

  function learnRelayHints(relayHints) {
    if (!Array.isArray(relayHints)) return;
    for (const address of relayHints) learnRelayAddress(address);
  }

  function relayLoad() {
    return {
      clients: clientConnections.size,
      roomHosts: hostConnections.size,
      relayConnections: relayConnections.size,
      knownRelays: knownRelayAddresses.size,
      icedRelays: icedRelayAddresses.size
    };
  }

  function relayStatusMessage(requestId) {
    return {
      type: "relay.status.ok",
      requestId,
      relayAddress: config.relayAddress,
      roomPeerId: config.relayPeerId,
      relayMeshPeerId: config.relayMeshPeerId,
      relayHints: relayHints(),
      icedRelayHints: Array.from(icedRelayAddresses),
      load: relayLoad()
    };
  }

  function scopedPeerId(conn) {
    if (!conn.partyP2PPeerId) conn.partyP2PPeerId = `${config.relayMeshPeerId}:${conn.peer}`;
    return conn.partyP2PPeerId;
  }

  function clientRouteKey(roomName, clientId) {
    if (typeof roomName !== "string" || !roomName || typeof clientId !== "string" || !clientId) return undefined;
    return `${roomName}:${clientId}`;
  }

  function rememberClientRoute(conn, roomName, clientId, peerId) {
    const key = clientRouteKey(roomName, clientId);
    if (!key) return;
    conn.partyP2PRoomName = roomName;
    conn.partyP2PClientId = clientId;
    clientRoutes.set(key, { conn, peerId });
  }

  function nextRelayMessageId(type) {
    relayMessageSeq += 1;
    return `${config.relayMeshPeerId}:${type}:${Date.now()}:${relayMessageSeq}`;
  }

  function rememberRelayMessage(id) {
    if (typeof id !== "string" || !id) return false;
    if (seenRelayMessageIds.has(id)) return false;
    seenRelayMessageIds.add(id);
    seenRelayMessageOrder.push(id);
    while (seenRelayMessageOrder.length > MAX_SEEN_RELAY_MESSAGES) {
      const oldId = seenRelayMessageOrder.shift();
      if (oldId) seenRelayMessageIds.delete(oldId);
    }
    return true;
  }

  function sendRelayEnvelope(message, originConn) {
    const envelope = {
      ...message,
      id: message.id || nextRelayMessageId(message.type)
    };
    let sent = 0;
    rememberRelayMessage(envelope.id);
    for (const relayConn of relayConnections) {
      if (relayConn !== originConn) {
        relayConn.send(envelope);
        sent += 1;
      }
    }
    return sent;
  }

  function relayPeerIdForAddress(address) {
    return relayMeshPeerIdFromAddressPeerId(peerIdFromRelayAddress(address));
  }

  function clearRelayReconnect(address) {
    const timer = relayReconnectTimers.get(address);
    if (timer) clearTimeout(timer);
    relayReconnectTimers.delete(address);
  }

  function iceRelayAddress(address) {
    const normalized = normalizeRelayAddress(address);
    if (!normalized || normalized === config.relayAddress) return;
    knownRelayAddresses.add(normalized);
    icedRelayAddresses.add(normalized);
    const conn = relayConnectionByAddress.get(normalized);
    if (conn) relayConnectionByAddress.delete(normalized);
    for (const [peerId, relayConn] of remoteClientRoutes) {
      if (relayConn === conn) remoteClientRoutes.delete(peerId);
    }
    for (const [key, route] of clientRoutes) {
      if (route.conn === conn) clientRoutes.delete(key);
    }
    conn?.close?.();
    scheduleRelayReconnect(normalized);
  }

  function uniceRelayAddress(address) {
    const normalized = normalizeRelayAddress(address);
    if (!normalized || normalized === config.relayAddress) return;
    knownRelayAddresses.add(normalized);
    icedRelayAddresses.delete(normalized);
  }

  function scheduleRelayReconnect(address) {
    if (closing) return;
    const normalized = normalizeRelayAddress(address);
    if (!normalized || normalized === config.relayAddress || relayReconnectTimers.has(normalized)) return;
    const delay = relayReconnectDelays.get(normalized) || RELAY_RECONNECT_BASE_MS;
    const timer = setTimeout(() => {
      relayReconnectTimers.delete(normalized);
      relayReconnectDelays.set(normalized, Math.min(delay * 2, RELAY_RECONNECT_MAX_MS));
      connectKnownRelay(normalized);
    }, delay);
    relayReconnectTimers.set(normalized, timer);
  }

  function connectKnownRelay(address) {
    const normalized = normalizeRelayAddress(address);
    if (!normalized || normalized === config.relayAddress) return;
    const existing = relayConnectionByAddress.get(normalized);
    if (existing && existing.open !== false) return;
    if (!relayPeer?.open) {
      scheduleRelayReconnect(normalized);
      return;
    }

    const peerId = relayPeerIdForAddress(normalized);
    if (!peerId || peerId === relayPeer.id) return;
    const conn = relayPeer.connect(peerId, {
      reliable: true,
      serialization: "json",
      metadata: {
        partyP2PRelay: true
      }
    });
    conn.partyP2PRelayAddress = normalized;
    relayConnectionByAddress.set(normalized, conn);
    conn.on("open", () => {
      uniceRelayAddress(normalized);
      clearRelayReconnect(normalized);
      relayReconnectDelays.delete(normalized);
      attachConnection(conn, { relayPeer: true });
    });
    conn.on("close", () => scheduleRelayReconnect(normalized));
    conn.on("error", () => scheduleRelayReconnect(normalized));
  }

  function sendHostUnavailable(conn) {
    conn.send({
      type: "host/error",
      protocol: 1,
      code: "host-unavailable",
      message: "The room host is not connected to this relay."
    });
  }

  function latestClientRoute(roomName, clientId) {
    const route = clientRoutes.get(clientRouteKey(roomName, clientId));
    if (!route) return undefined;
    if (route.conn?.open === false) {
      clientRoutes.delete(clientRouteKey(roomName, clientId));
      return undefined;
    }
    return route;
  }

  function sendToClient(peerId, message, roomName) {
    const conn = clientConnections.get(peerId);
    if (conn && conn.open !== false) {
      debugRelay(`host.send direct ${peerId} ${message?.type || "message"}`);
      conn.send(message);
      return;
    }

    const relayConn = remoteClientRoutes.get(peerId);
    if (relayConn && relayConn.open !== false) {
      debugRelay(`host.send relay route ${peerId} ${message?.type || "message"}`);
      relayConn.send({
        type: "relay.host",
        id: nextRelayMessageId("relay.host"),
        peerId,
        message
      });
      return;
    }

    const latestRoute = latestClientRoute(roomName, message?.clientId);
    if (latestRoute?.conn) {
      if (clientConnections.get(latestRoute.peerId) === latestRoute.conn) {
        debugRelay(`host.send latest direct ${latestRoute.peerId} ${message?.type || "message"}`);
        latestRoute.conn.send(message);
        return;
      }
      debugRelay(`host.send latest relay route ${latestRoute.peerId} ${message?.type || "message"}`);
      latestRoute.conn.send({
        type: "relay.host",
        id: nextRelayMessageId("relay.host"),
        peerId: latestRoute.peerId,
        message
      });
      return;
    }

    debugRelay(`host.send relay envelope ${peerId} ${message?.type || "message"}`);
    sendRelayEnvelope({
      type: "relay.host",
      peerId,
      message
    });
  }

  function broadcastToRoom(roomName, message) {
    for (const [conn, clientRoomName] of clientRooms) {
      if (clientRoomName === roomName && conn.open !== false) conn.send(message);
    }
  }

  function sendHostBroadcastRoute(route, message, sentConns, sentPeerIds) {
    if (!route?.conn || route.conn.open === false || sentPeerIds.has(route.peerId)) return false;
    sentPeerIds.add(route.peerId);
    if (clientConnections.get(route.peerId) === route.conn) {
      if (!sentConns.has(route.conn)) {
        debugRelay(`host.broadcast latest direct ${route.peerId} ${message?.type || "message"}`);
        route.conn.send(message);
        sentConns.add(route.conn);
      }
      return true;
    }
    debugRelay(`host.broadcast latest relay route ${route.peerId} ${message?.type || "message"}`);
    route.conn.send({
      type: "relay.host",
      id: nextRelayMessageId("relay.host"),
      peerId: route.peerId,
      message
    });
    return true;
  }

  function broadcastHostToRoom(roomName, message) {
    const sentConns = new Set();
    const sentPeerIds = new Set();
    for (const [conn, clientRoomName] of clientRooms) {
      if (clientRoomName !== roomName || conn.open === false) continue;
      debugRelay(`host.broadcast direct ${conn.partyP2PPeerId || conn.peer || "unknown"} ${message?.type || "message"}`);
      conn.send(message);
      sentConns.add(conn);
      if (conn.partyP2PPeerId) sentPeerIds.add(conn.partyP2PPeerId);
    }

    const routePrefix = `${roomName}:`;
    for (const [key, route] of clientRoutes) {
      if (!key.startsWith(routePrefix)) continue;
      if (route.conn?.open === false) {
        clientRoutes.delete(key);
        continue;
      }
      sendHostBroadcastRoute(route, message, sentConns, sentPeerIds);
    }
  }

  function relayHints() {
    return [config.relayAddress, ...knownRelayAddresses];
  }

  function relayHintMessage(roomName) {
    return {
      type: "relay.hints",
      roomName,
      relayHints: relayHints(),
      icedRelayHints: Array.from(icedRelayAddresses)
    };
  }

  function relayDisconnectingMessage() {
    return {
      type: "relay.disconnecting",
      relayAddress: config.relayAddress,
      roomPeerId: config.relayPeerId,
      relayMeshPeerId: config.relayMeshPeerId
    };
  }

  function announceRelayDisconnecting() {
    const message = relayDisconnectingMessage();
    for (const conn of clientConnections.values()) conn.send(message);
    for (const conn of relayConnections) conn.send(message);
  }

  function closePeerConnections() {
    const connections = new Set([
      ...clientConnections.values(),
      ...relayConnections
    ]);
    for (const conn of connections) conn.close?.();
  }

  function routeClientMessage(conn, message) {
    const roomName = typeof message.roomName === "string" ? message.roomName : undefined;
    if (!roomName) return;
    learnRelayHints(message.relayHints);

    const peerId = scopedPeerId(conn);
    clientConnections.set(peerId, conn);
    rememberClientRoute(conn, roomName, message.clientId, peerId);
    if (message.type === "client/hello") {
      clientRooms.set(conn, roomName);
      conn.send(relayHintMessage(roomName));
    }

    const host = hostConnections.get(roomName);
    if (host) {
      host.send({
        type: "relay/client-message",
        peerId,
        message
      });
      return;
    }

    if (relayConnections.size === 0) {
      sendHostUnavailable(conn);
      return;
    }

    sendRelayEnvelope({
      type: "relay.client",
      roomName,
      peerId,
      message
    });
  }

  function handleHostMessage(conn, message) {
    switch (message.type) {
      case "host.register": {
        if (typeof message.roomName !== "string" || !message.roomName) {
          conn.send({ type: "host.register.error", message: "roomName is required" });
          return;
        }
        learnRelayHints(message.relayHints);
        hostConnections.set(message.roomName, conn);
        conn.hostRoomName = message.roomName;
        conn.send({
          type: "host.register.ok",
          roomName: message.roomName,
          relayPeerId: config.relayPeerId,
          relayAddress: config.relayAddress
        });
        return;
      }
      case "host.send":
        sendToClient(message.peerId, message.message, conn.hostRoomName);
        return;
      case "host.broadcast": {
        broadcastHostToRoom(message.roomName, message.message);
        sendRelayEnvelope({
          type: "relay.broadcast",
          roomName: message.roomName,
          message: message.message
        });
        return;
      }
      case "host.close": {
        const client = clientConnections.get(message.peerId);
        if (client) {
          client.close?.();
          return;
        }
        sendRelayEnvelope({
          type: "relay.client.close",
          peerId: message.peerId
        });
        return;
      }
      default:
        return;
    }
  }

  function handleRelayEnvelope(conn, message) {
    if (!message || typeof message !== "object" || !rememberRelayMessage(message.id)) return;

    switch (message.type) {
      case "relay.status":
        conn.send(relayStatusMessage(message.requestId));
        return;
      case "relay.client": {
        if (typeof message.peerId !== "string" || typeof message.roomName !== "string") return;
        remoteClientRoutes.set(message.peerId, conn);
        rememberClientRoute(conn, message.roomName, message.message?.clientId, message.peerId);
        const host = hostConnections.get(message.roomName);
        if (host) {
          host.send({
            type: "relay/client-message",
            peerId: message.peerId,
            message: message.message
          });
          return;
        }
        const sent = sendRelayEnvelope(message, conn);
        if (sent === 0) {
          conn.send({
            type: "relay.host",
            id: nextRelayMessageId("relay.host"),
            peerId: message.peerId,
            message: {
              type: "host/error",
              protocol: 1,
              code: "host-unavailable",
              message: "The room host is not connected to this relay."
            }
          });
        }
        return;
      }
      case "relay.host": {
        if (typeof message.peerId !== "string") return;
        const client = clientConnections.get(message.peerId);
        if (client) {
          client.send(message.message);
          return;
        }
        const relayConn = remoteClientRoutes.get(message.peerId);
        if (relayConn && relayConn !== conn) {
          relayConn.send(message);
          return;
        }
        sendRelayEnvelope(message, conn);
        return;
      }
      case "relay.broadcast":
        if (typeof message.roomName !== "string") return;
        broadcastToRoom(message.roomName, message.message);
        sendRelayEnvelope(message, conn);
        return;
      case "relay.client.close": {
        if (typeof message.peerId !== "string") return;
        remoteClientRoutes.delete(message.peerId);
        const client = clientConnections.get(message.peerId);
        if (client) {
          client.close?.();
          return;
        }
        const host = message.roomName ? hostConnections.get(message.roomName) : undefined;
        if (host) {
          host.send({
            type: "relay/client-close",
            peerId: message.peerId
          });
          return;
        }
        sendRelayEnvelope(message, conn);
        return;
      }
      default:
        return;
    }
  }

  function isRelayEnvelopeMessage(message) {
    return message?.type === "relay.client"
      || message?.type === "relay.host"
      || message?.type === "relay.broadcast"
      || message?.type === "relay.client.close";
  }

  function handleConnectionData(conn, message) {
    if (isNostrMessage(message)) return;
    if (!message || typeof message !== "object") return;
    if (isRelayEnvelopeMessage(message)) {
      handleRelayEnvelope(conn, message);
      return;
    }
    if (message.type === "relay.status.ok") {
      if (message.relayAddress) {
        conn.partyP2PRelayAddress = normalizeRelayAddress(message.relayAddress);
        uniceRelayAddress(message.relayAddress);
      }
      learnRelayHints(message.relayHints);
      return;
    }
    if (message.type === "relay.add") {
      learnRelayAddress(message.relayAddress);
      conn.send({
        type: "relay.add.ok",
        requestId: message.requestId,
        relayAddress: normalizeRelayAddress(message.relayAddress)
      });
      return;
    }
    if (message.type === "relay.status") {
      conn.send(relayStatusMessage(message.requestId));
      return;
    }
    if (message.type === "relay.disconnecting") {
      iceRelayAddress(message.relayAddress || conn.partyP2PRelayAddress);
      broadcastToRoom(message.roomName, relayHintMessage(message.roomName));
      return;
    }
    if (typeof message.type === "string" && message.type.startsWith("relay.") && relayConnections.has(conn)) {
      handleRelayEnvelope(conn, message);
      return;
    }
    if (message.type === "relay.hints") {
      learnRelayHints(message.relayHints);
      if (typeof message.roomName === "string") {
        broadcastToRoom(message.roomName, relayHintMessage(message.roomName));
      }
      return;
    }
    if (typeof message.type === "string" && message.type.startsWith("host.")) {
      handleHostMessage(conn, message);
      return;
    }
    routeClientMessage(conn, message);
  }

  function cleanupConnection(conn) {
    if (conn.partyP2PCleaned) return;
    conn.partyP2PCleaned = true;
    const peerId = conn.partyP2PPeerId;
    if (peerId) clientConnections.delete(peerId);
    const routeKey = clientRouteKey(conn.partyP2PRoomName, conn.partyP2PClientId);
    if (routeKey && clientRoutes.get(routeKey)?.conn === conn) clientRoutes.delete(routeKey);
    relayConnections.delete(conn);
    const relayAddress = conn.partyP2PRelayAddress;
    if (relayAddress && relayConnectionByAddress.get(relayAddress) === conn) {
      relayConnectionByAddress.delete(relayAddress);
      scheduleRelayReconnect(relayAddress);
    }
    const roomName = clientRooms.get(conn);
    clientRooms.delete(conn);
    if (roomName && peerId) {
      const host = hostConnections.get(roomName);
      if (host) {
        host.send({
          type: "relay/client-close",
          peerId
        });
      } else {
        sendRelayEnvelope({
          type: "relay.client.close",
          roomName,
          peerId
        }, conn);
      }
    }
    for (const [remotePeerId, relayConn] of remoteClientRoutes) {
      if (relayConn === conn) remoteClientRoutes.delete(remotePeerId);
    }
    if (conn.hostRoomName && hostConnections.get(conn.hostRoomName) === conn) {
      hostConnections.delete(conn.hostRoomName);
    }
  }

  function attachConnection(conn, options = {}) {
    if (options.relayPeer) relayConnections.add(conn);
    relay.attachConnection(conn, { relayPeer: Boolean(options.relayPeer) });
    conn.on("data", (message) => handleConnectionData(conn, message));
    conn.on("close", () => cleanupConnection(conn));
    conn.on("error", () => cleanupConnection(conn));
    if (options.relayPeer) {
      conn.send(relayStatusMessage());
    }
  }

  function isTransientPeerError(error) {
    const type = error?.type;
    const message = error?.message || "";
    return type === "network"
      || type === "peer-unavailable"
      || message.includes("Lost connection to server")
      || message.includes("Could not connect to peer");
  }

  function handlePeerError(peer, label, error) {
    if (!isTransientPeerError(error)) {
      console.error(`${label} error:`, error);
      return;
    }
    console.warn(`${label} transient error: ${error?.message || String(error)}`);
    if (error?.type === "network" && !peer.destroyed) peer.reconnect?.();
  }

  async function startPeer() {
    if (!config.startPeer) return;
    roomPeer = await createNodePeer(config.relayPeerId, config.iceServers);
    relayPeer = await createNodePeer(config.relayMeshPeerId, config.iceServers);

    roomPeer.on("open", (id) => {
      console.log(`party-p2p room relay peer is live as ${id}`);
    });
    roomPeer.on("connection", (conn) => {
      attachConnection(conn, { relayPeer: false });
    });
    roomPeer.on("error", (error) => {
      handlePeerError(roomPeer, "party-p2p room relay peer", error);
    });

    relayPeer.on("open", (id) => {
      console.log(`party-p2p relay mesh peer is live as ${id}`);
      for (const address of knownRelayAddresses) connectKnownRelay(address);
    });
    relayPeer.on("connection", (conn) => {
      attachConnection(conn, { relayPeer: true });
    });
    relayPeer.on("error", (error) => {
      handlePeerError(relayPeer, "party-p2p relay mesh peer", error);
    });
  }

  return {
    config,
    relay,
    server,
    wss,
    attachConnection,
    async listen() {
      await startPeer();
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.ipcPort, config.ipcHost, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
      closing = true;
      await Promise.resolve();
      announceRelayDisconnecting();
      closePeerConnections();
      const peerToDestroy = roomPeer;
      const relayPeerToDestroy = relayPeer;
      roomPeer = undefined;
      relayPeer = undefined;
      for (const timer of relayReconnectTimers.values()) clearTimeout(timer);
      relayReconnectTimers.clear();
      await new Promise((resolve) => {
        for (const socket of wss.clients) socket.close();
        wss.close(() => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        });
      });
      storage.close?.();
      setTimeout(() => {
        try {
          peerToDestroy?.destroy();
        } catch {}
        try {
          relayPeerToDestroy?.destroy();
        } catch {}
      }, 0);
      })();
      return closePromise;
    },
    crash() {
      setTimeout(() => {
        void this.close();
      }, 0);
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const relay = createPartyRelay({
    ipcHost: args.ipcHost,
    ipcPort: args.ipcPort,
    storagePath: args.storagePath,
    relayPeerId: args.relayPeerId,
    relayPeers: args.relayPeers,
    maxEvents: args.maxEvents,
    iceServers: parseIceServers(args.iceServers)
  });
  await relay.listen();
  console.log("party-p2p relay IPC is live.");
  console.log(`IPC:        ws://${relay.config.ipcHost}:${relay.config.ipcPort}`);
  console.log(`Room peer:  ${relay.config.relayPeerId}`);
  console.log(`Mesh peer:  ${relay.config.relayMeshPeerId}`);
  console.log(`Mesh addr:  ${relay.config.relayAddress}`);
  console.log(`Storage:    ${relay.config.storagePath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  WebSocketRelayConnection,
  createPartyRelay,
  defaultStoragePath,
  parseArgs,
  resolveStoragePath
};

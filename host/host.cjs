#!/usr/bin/env node
/*
  Host-run PeerJS room service.

  This process creates a Node PeerJS room peer through PeerJS Cloud. Browser
  clients load the static PWA from APP_URL and connect to this peer over WebRTC
  data channels; event data is not stored on a third-party server.
*/

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const qrcode = require("qrcode-terminal");
const { applyPartyRcDefaults } = require("./partyRc.cjs");
const { createNodePeer } = require("./nodePeer.cjs");

const DEFAULT_DATA_DIR = path.join(__dirname, "data");
const PROTOCOL = 1;
const DEFAULT_APP_URL = "http://localhost:4273/";
const DEFAULT_LOCATION_PIN = { lat: 40.6782, lng: -73.9442, zoom: 13 };

function parseArgs(argv) {
  const args = {
    room: process.env.ROOM || "rooftop-disco",
    title: process.env.TITLE || "Rooftop Disco",
    date: process.env.DATE || "2026-06-20",
    time: process.env.TIME || "8:00 PM",
    location: process.env.LOCATION || "Brooklyn rooftop",
    description: process.env.DESCRIPTION || "Bring a friend, a snack, and one song for the shared playlist.",
    appUrl: process.env.APP_URL || process.env.HOST_URL || DEFAULT_APP_URL,
    roomSecret: process.env.ROOM_SECRET || "",
    dataDir: process.env.PARTY_P2P_DATA_DIR || DEFAULT_DATA_DIR,
    theme: process.env.THEME || "sunset",
    iceServers: process.env.ICE_SERVERS || "stun:stun.l.google.com:19302"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.replace(/^--/, "");
    const value = argv[index + 1];
    switch (key) {
      case "room": args.room = value; index += 1; break;
      case "title": args.title = value; index += 1; break;
      case "date": args.date = value; index += 1; break;
      case "time": args.time = value; index += 1; break;
      case "location": args.location = value; index += 1; break;
      case "description": args.description = value; index += 1; break;
      case "app-url": args.appUrl = value; index += 1; break;
      case "host-url": args.appUrl = value; index += 1; break;
      case "secret": args.roomSecret = value; index += 1; break;
      case "data-dir": args.dataDir = value; index += 1; break;
      case "ice": args.iceServers = value; index += 1; break;
      default:
        console.warn(`Unknown option: ${token}`);
    }
  }

  args.room = slugifyRoom(args.room);
  args.dataDir = path.resolve(args.dataDir);
  return args;
}

function attachDataDir(store, dataDir) {
  Object.defineProperty(store, "dataDir", {
    value: dataDir,
    configurable: true,
    writable: true
  });
  return store;
}

function slugifyRoom(value) {
  return String(value || "party")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "party";
}

function roomToPeerId(roomName) {
  return `party-p2p-${slugifyRoom(roomName)}`;
}

function normalizeAppUrl(value) {
  return String(value || DEFAULT_APP_URL).trim().replace(/#.*$/, "");
}

function buildInviteUrl(appUrl, roomName, roomPeerId, roomSecret) {
  const params = new URLSearchParams();
  params.set("roomPeerId", roomPeerId);
  params.set("secret", roomSecret);
  return `${normalizeAppUrl(appUrl)}#/room/${encodeURIComponent(roomName)}?${params.toString()}`;
}

function randomSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function secretProof(secret, roomName, clientId) {
  return sha256Hex(`${secret}:${roomName}:${clientId}`);
}

function parseIceServers(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((urls) => ({ urls }));
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeLocationPin(value) {
  if (!value || typeof value !== "object") return undefined;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  const zoom = Number(value.zoom);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return {
    lat: clampNumber(lat, -85.05112878, 85.05112878),
    lng: ((((lng + 180) % 360) + 360) % 360) - 180,
    zoom: Math.round(clampNumber(Number.isFinite(zoom) ? zoom : 13, 2, 18))
  };
}

function defaultState(args) {
  const now = Date.now();
  return {
    version: 0,
    updatedAt: now,
    details: {
      id: `event_${args.room}`,
      roomName: args.room,
      title: args.title,
      date: args.date,
      time: args.time,
      location: args.location,
      description: args.description,
      coverEmoji: "🪩",
      dressCode: "Come festive",
      hostNote: "First connected guest becomes admin and can edit this page.",
      locationPin: DEFAULT_LOCATION_PIN,
      theme: ["sunset", "mint", "violet", "citrus"].includes(args.theme) ? args.theme : "sunset"
    },
    guests: {},
    posts: [
      {
        id: "welcome_post",
        authorId: "room-host",
        authorName: "Room host",
        body: "Welcome! Event updates, ride shares, and questions can live here.",
        createdAt: now,
        pinned: true
      }
    ],
    comments: [],
    adminIds: []
  };
}

function stateFile(dataDir, roomName) {
  return path.join(dataDir, `${roomName}.json`);
}

function loadStore(args) {
  fs.mkdirSync(args.dataDir, { recursive: true });
  const file = stateFile(args.dataDir, args.room);
  if (fs.existsSync(file)) {
    const store = attachDataDir(JSON.parse(fs.readFileSync(file, "utf8")), args.dataDir);
    if (args.roomSecret && args.roomSecret !== store.roomSecret) {
      console.warn("Using ROOM_SECRET/--secret from CLI instead of saved room secret.");
      store.roomSecret = args.roomSecret;
    }
    store.admins ||= {};
    store.seenMutations ||= [];
    return store;
  }
  const store = attachDataDir({
    roomName: args.room,
    roomPeerId: roomToPeerId(args.room),
    roomSecret: args.roomSecret || randomSecret(),
    admins: {},
    seenMutations: [],
    state: defaultState(args)
  }, args.dataDir);
  saveStore(store);
  return store;
}

function saveStore(store) {
  fs.mkdirSync(store.dataDir, { recursive: true });
  fs.writeFileSync(stateFile(store.dataDir, store.roomName), JSON.stringify(store, null, 2));
}

function touchState(store) {
  store.state.version += 1;
  store.state.updatedAt = Date.now();
  saveStore(store);
}

function guestForProfile(store, profile, peerId, role) {
  const existing = store.state.guests[profile.id];
  const now = Date.now();
  const nameLocked = Boolean(existing?.nameLocked);
  const guest = {
    id: profile.id,
    peerId,
    name: nameLocked ? existing.name : String(profile.name || "Guest").slice(0, 80),
    avatar: nameLocked ? existing.avatar : String(profile.avatar || "✨").slice(0, 8),
    rsvp: existing?.rsvp || "unset",
    role,
    joinedAt: existing?.joinedAt || now,
    lastSeenAt: now,
    nameLocked,
    chatDisabled: Boolean(existing?.chatDisabled)
  };
  store.state.guests[profile.id] = guest;
  return guest;
}

function hashAdminToken(token) {
  return sha256Hex(`admin:${token}`);
}

function isAdmin(store, clientId, token) {
  const record = store.admins[clientId];
  if (!record || !token) return false;
  return record.tokenHash === hashAdminToken(token);
}

function createAdminGrant(store, clientId) {
  const token = randomSecret();
  store.admins[clientId] = { tokenHash: hashAdminToken(token), grantedAt: Date.now() };
  if (!store.state.adminIds.includes(clientId)) store.state.adminIds.push(clientId);
  return token;
}

function send(conn, message) {
  try {
    if (conn.open) conn.send(message);
  } catch (error) {
    console.error("Failed to send message", error);
  }
}

function broadcast(connections, state, acceptedMutationId) {
  for (const conn of connections.values()) {
    send(conn, { type: "host/state", protocol: PROTOCOL, state, acceptedMutationId });
  }
}

function requireString(value, max = 4000) {
  return String(value || "").slice(0, max);
}

function hasPayloadKey(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function applyMutation(store, mutation, role) {
  const state = store.state;
  const guest = state.guests[mutation.clientId];
  const authorName = guest?.name || "Guest";
  const isAdminRole = role === "admin";
  const payload = mutation.payload || {};

  if (store.seenMutations.includes(mutation.id)) return { changed: false };
  store.seenMutations.push(mutation.id);
  store.seenMutations = store.seenMutations.slice(-500);

  switch (mutation.op) {
    case "guest.update": {
      const existing = state.guests[mutation.clientId];
      if (!existing) return { changed: false, error: "Unknown guest." };
      if (existing.nameLocked && (hasPayloadKey(payload, "name") || hasPayloadKey(payload, "avatar"))) {
        return { changed: false, error: "This guest's name is locked by the host." };
      }
      const rsvp = payload.rsvp;
      if (["yes", "maybe", "no", "unset"].includes(rsvp)) existing.rsvp = rsvp;
      if (payload.name) existing.name = requireString(payload.name, 80);
      if (payload.avatar) existing.avatar = requireString(payload.avatar, 8);
      existing.lastSeenAt = Date.now();
      break;
    }
    case "guest.moderate": {
      if (!isAdminRole) return { changed: false, error: "Only admins can moderate guests." };
      const target = state.guests[requireString(payload.guestId, 120)];
      if (!target) return { changed: false, error: "Guest not found." };
      if (hasPayloadKey(payload, "nameLocked")) target.nameLocked = Boolean(payload.nameLocked);
      if (hasPayloadKey(payload, "chatDisabled")) target.chatDisabled = Boolean(payload.chatDisabled);
      break;
    }
    case "event.update": {
      if (!isAdminRole) return { changed: false, error: "Only admins can edit event details." };
      const allowed = ["title", "date", "time", "location", "description", "coverEmoji", "dressCode", "hostNote", "theme"];
      for (const key of allowed) {
        if (hasPayloadKey(payload, key)) {
          state.details[key] = requireString(payload[key], key === "description" || key === "hostNote" ? 5000 : 300);
        }
      }
      if (hasPayloadKey(payload, "locationPin")) {
        const locationPin = sanitizeLocationPin(payload.locationPin);
        if (locationPin) state.details.locationPin = locationPin;
        else delete state.details.locationPin;
      }
      if (!["sunset", "mint", "violet", "citrus"].includes(state.details.theme)) state.details.theme = "sunset";
      break;
    }
    case "post.add": {
      if (guest?.chatDisabled) return { changed: false, error: "Posting is disabled for this guest." };
      const body = requireString(payload.body, 4000).trim();
      if (!body) return { changed: false, error: "Post body is empty." };
      state.posts.push({ id: crypto.randomUUID(), authorId: mutation.clientId, authorName, body, createdAt: Date.now() });
      break;
    }
    case "post.delete": {
      const post = state.posts.find((item) => item.id === payload.id);
      if (!post) return { changed: false, error: "Post not found." };
      if (!isAdminRole && post.authorId !== mutation.clientId) return { changed: false, error: "Only admins or the author can delete this post." };
      post.deleted = true;
      break;
    }
    case "post.pin": {
      if (!isAdminRole) return { changed: false, error: "Only admins can pin posts." };
      const post = state.posts.find((item) => item.id === payload.id);
      if (!post) return { changed: false, error: "Post not found." };
      post.pinned = Boolean(payload.pinned);
      break;
    }
    case "comment.add": {
      if (guest?.chatDisabled) return { changed: false, error: "Posting is disabled for this guest." };
      const body = requireString(payload.body, 1800).trim();
      if (!body) return { changed: false, error: "Comment body is empty." };
      state.comments.push({ id: crypto.randomUUID(), authorId: mutation.clientId, authorName, body, createdAt: Date.now() });
      break;
    }
    case "comment.delete": {
      const comment = state.comments.find((item) => item.id === payload.id);
      if (!comment) return { changed: false, error: "Comment not found." };
      if (!isAdminRole && comment.authorId !== mutation.clientId) return { changed: false, error: "Only admins or the author can delete this comment." };
      comment.deleted = true;
      break;
    }
    default:
      return { changed: false, error: `Unsupported mutation: ${mutation.op}` };
  }

  touchState(store);
  return { changed: true };
}

async function main() {
  applyPartyRcDefaults();
  const args = parseArgs(process.argv.slice(2));
  const store = loadStore(args);
  const roomPeerId = store.roomPeerId || roomToPeerId(args.room);
  const appUrl = normalizeAppUrl(args.appUrl);
  const shareUrl = buildInviteUrl(appUrl, store.roomName, roomPeerId, store.roomSecret);
  const iceServers = parseIceServers(args.iceServers);

  const peer = await createNodePeer(roomPeerId, iceServers);

  const connections = new Map();
  const connectionRoles = new Map();
  let announced = false;
  let reconnectTimer;

  function scheduleReconnect() {
    if (reconnectTimer || peer.destroyed) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (peer.destroyed || !peer.disconnected) return;
      console.warn("Reconnecting to PeerJS Cloud...");
      try {
        peer.reconnect();
      } catch (error) {
        console.error("PeerJS Cloud reconnect failed:", error);
        scheduleReconnect();
      }
    }, 1500);
  }

  peer.on("open", (id) => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }

    if (announced) {
      console.log(`Reconnected to PeerJS Cloud as ${id}.`);
      return;
    }

    announced = true;
    console.log("\nParty P2P host is live.");
    console.log(`Room:        ${store.roomName}`);
    console.log(`Room peer:   ${id}`);
    console.log("Signaling:   PeerJS Cloud");
    console.log(`App URL:     ${appUrl}`);
    console.log(`Data file:   ${stateFile(store.dataDir, store.roomName)}`);
    console.log(`Invite URL:  ${shareUrl}\n`);
    qrcode.generate(shareUrl, { small: true });
    console.log("\nKeep this process running while guests are connected. Press Ctrl+C to stop.\n");
  });

  peer.on("disconnected", (id) => {
    console.warn(`PeerJS Cloud signaling disconnected for ${id}. Existing data channels may stay open.`);
    scheduleReconnect();
  });

  peer.on("connection", (conn) => {
    console.log("WebRTC data connection from", conn.peer);
    connections.set(conn.peer, conn);

    conn.on("data", (message) => {
      if (!message || typeof message !== "object") return;

      if (message.type === "client/hello") {
        if (message.protocol !== PROTOCOL || message.roomName !== store.roomName) {
          send(conn, { type: "host/error", protocol: PROTOCOL, code: "room-mismatch", message: "Wrong room or protocol." });
          conn.close();
          return;
        }
        const expected = secretProof(store.roomSecret, store.roomName, message.clientId);
        if (message.secretProof !== expected) {
          send(conn, { type: "host/error", protocol: PROTOCOL, code: "bad-secret", message: "Room secret proof did not match." });
          conn.close();
          return;
        }

        let role = isAdmin(store, message.clientId, message.adminToken) ? "admin" : "guest";
        let newAdminToken;
        if (Object.keys(store.admins).length === 0) {
          newAdminToken = createAdminGrant(store, message.clientId);
          role = "admin";
          console.log(`Granted first-join admin to ${message.profile?.name || message.clientId}`);
        }

        guestForProfile(store, message.profile || { id: message.clientId, name: "Guest", avatar: "✨" }, conn.peer, role);
        touchState(store);
        connectionRoles.set(conn.peer, { clientId: message.clientId, role });
        send(conn, { type: "host/welcome", protocol: PROTOCOL, state: store.state, role, clientId: message.clientId, adminToken: newAdminToken });
        broadcast(connections, store.state);
        return;
      }

      if (message.type === "client/mutation") {
        if (message.protocol !== PROTOCOL || message.roomName !== store.roomName) {
          send(conn, { type: "host/error", protocol: PROTOCOL, code: "room-mismatch", message: "Wrong room or protocol." });
          return;
        }
        const mutation = message.mutation;
        if (!mutation || mutation.clientId !== connectionRoles.get(conn.peer)?.clientId) {
          send(conn, { type: "host/error", protocol: PROTOCOL, code: "bad-mutation", message: "Mutation client did not match the connection." });
          return;
        }
        const role = isAdmin(store, mutation.clientId, message.adminToken) ? "admin" : "guest";
        const result = applyMutation(store, mutation, role);
        if (result.error) {
          send(conn, { type: "host/error", protocol: PROTOCOL, code: "mutation-rejected", message: result.error });
          return;
        }
        if (result.changed) broadcast(connections, store.state, mutation.id);
      }
    });

    conn.on("close", () => {
      console.log("WebRTC data connection closed", conn.peer);
      connections.delete(conn.peer);
      connectionRoles.delete(conn.peer);
    });

    conn.on("error", (error) => {
      if (error && error.type === "negotiation-failed") {
        console.warn(`WebRTC data connection negotiation failed for ${conn.peer}: ${error.message || error}`);
      } else {
        console.error("WebRTC data connection error", conn.peer, error);
      }
      connections.delete(conn.peer);
      connectionRoles.delete(conn.peer);
    });
  });

  peer.on("error", (error) => {
    if (error && error.type === "network") {
      console.warn(`PeerJS Cloud signaling error: ${error.message || error}`);
      return;
    }

    console.error("Room peer error:", error);
    if (error && error.type === "unavailable-id") {
      console.error(`The room peer id '${roomPeerId}' is already in use on PeerJS Cloud. Stop the other host or pick a different room name.`);
    }
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  applyMutation,
  defaultState,
  guestForProfile
};

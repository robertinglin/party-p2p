const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const { createPartyRelay, parseArgs } = require("../host/relay.cjs");
const { P2PNostrRelay } = require("../host/p2pNostrRelay.cjs");
const { PARTY_NOSTR_KIND, createChatMessageEvent, generatePartyIdentity, partyEventToNostrEvent } = require("../host/partyEvent.cjs");
const { sqliteFile } = require("../host/sqliteRelayStorage.cjs");

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function makeJsonReader(socket) {
  const queue = [];
  const waiters = [];

  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  });

  socket.on("error", (error) => {
    const waiter = waiters.shift();
    if (waiter) waiter.reject(error);
  });

  return function nextJson() {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });
}

function makeRelayEvent(text = "stored privately", createdAt = 1760000000000) {
  const identity = generatePartyIdentity(1000);
  const event = createChatMessageEvent({
    partyId: "relay-test-room",
    identity,
    roomSecret: "invite-secret",
    text,
    createdAt
  });
  return partyEventToNostrEvent(event);
}

class FakeConn {
  constructor(peer = "fake-peer") {
    this.peer = peer;
    this.open = true;
    this.sent = [];
    this.handlers = { data: [], close: [], error: [] };
  }

  send(message) {
    this.sent.push(message);
    this.remote?.emit("data", message);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
  }

  on(event, callback) {
    this.handlers[event].push(callback);
  }

  emit(event, value) {
    for (const handler of this.handlers[event]) handler(value);
  }
}

function fakeConnectionPair() {
  const left = new FakeConn();
  const right = new FakeConn();
  left.remote = right;
  right.remote = left;
  return [left, right];
}

test("relay IPC publishes, dedupes, queries, subscribes, and exposes health", async (t) => {
  const dataDir = tmpDir("party-p2p-relay-config-");
  const storagePath = tmpDir("party-p2p-relay-storage-");
  const relay = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    startPeer: false
  });
  t.after(async () => {
    await relay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const address = await relay.listen();
  const socket = await connect(`ws://127.0.0.1:${address.port}`);
  const nextJson = makeJsonReader(socket);
  t.after(() => socket.close());

  const nostrEvent = makeRelayEvent();

  socket.send(JSON.stringify(["REQ", "sub_1", { kinds: [PARTY_NOSTR_KIND], "#d": ["relay-test-room"] }]));
  assert.deepEqual(await nextJson(), ["EOSE", "sub_1"]);

  socket.send(JSON.stringify(["EVENT", nostrEvent]));
  const publishMessages = [await nextJson(), await nextJson()];
  assert.deepEqual(publishMessages.find((message) => message[0] === "OK"), ["OK", nostrEvent.id, true, ""]);
  assert.deepEqual(publishMessages.find((message) => message[0] === "EVENT"), ["EVENT", "sub_1", nostrEvent]);

  socket.send(JSON.stringify(["EVENT", nostrEvent]));
  assert.deepEqual(await nextJson(), ["OK", nostrEvent.id, true, "duplicate"]);

  socket.send(JSON.stringify(["REQ", "sub_2", { ids: [nostrEvent.id], limit: 10 }]));
  assert.deepEqual(await nextJson(), ["EVENT", "sub_2", nostrEvent]);
  assert.deepEqual(await nextJson(), ["EOSE", "sub_2"]);

  const health = await getJson(`http://127.0.0.1:${address.port}/health`);
  assert.equal(health.ok, true);
  assert.equal(health.protocol, "party-p2p-peer-relay");
  assert.notEqual(health.relayMeshPeerId, health.relayPeerId);
  assert.match(health.relayMeshPeerId, /-relay$/);
  assert.match(health.relayAddress, /-relay$/);
  assert.equal(health.parties, 1);
  assert.equal(health.events, 1);
});

test("relay persists events in node sqlite storage", async (t) => {
  const dataDir = tmpDir("party-p2p-relay-config-");
  const storagePath = tmpDir("party-p2p-relay-storage-");
  let relayA;
  let relayB;
  let socketA;
  let socketB;
  t.after(async () => {
    socketA?.close();
    socketB?.close();
    await relayA?.close();
    await relayB?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const nostrEvent = makeRelayEvent("persisted privately");
  relayA = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    startPeer: false
  });
  const addressA = await relayA.listen();
  socketA = await connect(`ws://127.0.0.1:${addressA.port}`);
  const nextA = makeJsonReader(socketA);
  socketA.send(JSON.stringify(["EVENT", nostrEvent]));
  assert.deepEqual(await nextA(), ["OK", nostrEvent.id, true, ""]);
  socketA.close();
  await relayA.close();
  relayA = undefined;
  socketA = undefined;

  assert.equal(fs.existsSync(sqliteFile(storagePath)), true);

  relayB = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    startPeer: false
  });

  const addressB = await relayB.listen();
  socketB = await connect(`ws://127.0.0.1:${addressB.port}`);
  const nextB = makeJsonReader(socketB);

  socketB.send(JSON.stringify(["REQ", "sub_persisted", { ids: [nostrEvent.id], limit: 10 }]));
  assert.deepEqual(await nextB(), ["EVENT", "sub_persisted", nostrEvent]);
  assert.deepEqual(await nextB(), ["EOSE", "sub_persisted"]);
});

test("relay cleanup sends one client close per dropped connection", async (t) => {
  const dataDir = tmpDir("party-p2p-relay-config-");
  const storagePath = tmpDir("party-p2p-relay-storage-");
  const relay = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    startPeer: false
  });
  t.after(async () => {
    await relay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const host = new FakeConn("host");
  relay.attachConnection(host);
  host.emit("data", { type: "host.register", roomName: "relay-cleanup-room" });

  const client = new FakeConn("client");
  relay.attachConnection(client);
  client.emit("data", { type: "client/hello", roomName: "relay-cleanup-room", relayHints: [] });

  client.emit("close");
  client.emit("close");
  client.emit("error", new Error("already closed"));

  const closeMessages = host.sent.filter((message) => message.type === "relay/client-close");
  assert.equal(closeMessages.length, 1);
  assert.equal(closeMessages[0].peerId, `${relay.config.relayMeshPeerId}:client`);
});

test("relay trims node sqlite storage with max-events", async (t) => {
  const dataDir = tmpDir("party-p2p-relay-config-");
  const storagePath = tmpDir("party-p2p-relay-storage-");
  let relayA;
  let relayB;
  let socketA;
  let socketB;
  t.after(async () => {
    socketA?.close();
    socketB?.close();
    await relayA?.close();
    await relayB?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const firstEvent = makeRelayEvent("old encrypted message", 1760000000000);
  const secondEvent = makeRelayEvent("kept encrypted message", 1760000001000);
  relayA = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    maxEvents: 1,
    startPeer: false
  });
  const addressA = await relayA.listen();
  socketA = await connect(`ws://127.0.0.1:${addressA.port}`);
  const nextA = makeJsonReader(socketA);

  socketA.send(JSON.stringify(["EVENT", firstEvent]));
  assert.deepEqual(await nextA(), ["OK", firstEvent.id, true, ""]);
  socketA.send(JSON.stringify(["EVENT", secondEvent]));
  assert.deepEqual(await nextA(), ["OK", secondEvent.id, true, ""]);
  socketA.close();
  await relayA.close();
  relayA = undefined;
  socketA = undefined;

  relayB = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    maxEvents: 1,
    startPeer: false
  });
  const addressB = await relayB.listen();
  socketB = await connect(`ws://127.0.0.1:${addressB.port}`);
  const nextB = makeJsonReader(socketB);

  socketB.send(JSON.stringify(["REQ", "sub_trimmed", { kinds: [PARTY_NOSTR_KIND], "#d": ["relay-test-room"], limit: 10 }]));
  assert.deepEqual(await nextB(), ["EVENT", "sub_trimmed", secondEvent]);
  assert.deepEqual(await nextB(), ["EOSE", "sub_trimmed"]);
});

test("relay IPC routes room client messages to the registered host", async (t) => {
  const dataDir = tmpDir("party-p2p-relay-config-");
  const storagePath = tmpDir("party-p2p-relay-storage-");
  const relay = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    startPeer: false
  });
  t.after(async () => {
    await relay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const address = await relay.listen();
  const hostSocket = await connect(`ws://127.0.0.1:${address.port}`);
  const clientSocket = await connect(`ws://127.0.0.1:${address.port}`);
  const nextHostJson = makeJsonReader(hostSocket);
  const nextClientJson = makeJsonReader(clientSocket);
  t.after(() => hostSocket.close());
  t.after(() => clientSocket.close());

  hostSocket.send(JSON.stringify({ type: "host.register", roomName: "relay-test-room", relayHints: ["peerjs:party-p2p-relay-known-one"] }));
  const registered = await nextHostJson();
  assert.equal(registered.type, "host.register.ok");
  assert.equal(registered.roomName, "relay-test-room");

  const hello = {
    type: "client/hello",
    protocol: 1,
    roomName: "relay-test-room",
    clientId: "guest_1",
    relayHints: ["peerjs:party-p2p-relay-known-two"]
  };
  clientSocket.send(JSON.stringify(hello));
  const routed = await nextHostJson();
  assert.equal(routed.type, "relay/client-message");
  assert.deepEqual(routed.message, hello);
  assert.match(routed.peerId, /:ipc_/);

  const relayHints = await nextClientJson();
  assert.equal(relayHints.type, "relay.hints");
  assert.equal(relayHints.roomName, "relay-test-room");
  assert.equal(relayHints.relayHints.includes("peerjs:party-p2p-relay-known-one-relay"), true);
  assert.equal(relayHints.relayHints.includes("peerjs:party-p2p-relay-known-two-relay"), true);

  hostSocket.send(JSON.stringify({
    type: "host.send",
    peerId: routed.peerId,
    message: { type: "host/welcome", protocol: 1, clientId: "guest_1" }
  }));
  assert.deepEqual(await nextClientJson(), { type: "host/welcome", protocol: 1, clientId: "guest_1" });

  hostSocket.send(JSON.stringify({
    type: "host.broadcast",
    roomName: "relay-test-room",
    message: { type: "host/state", protocol: 1, acceptedMutationId: "mut_1" }
  }));
  assert.deepEqual(await nextClientJson(), { type: "host/state", protocol: 1, acceptedMutationId: "mut_1" });

  const health = await getJson(`http://127.0.0.1:${address.port}/health`);
  assert.equal(health.knownRelays, 2);
});

test("relay mesh routes room traffic between client relays and the host relay", async (t) => {
  const dataDirA = tmpDir("party-p2p-relay-config-a-");
  const dataDirB = tmpDir("party-p2p-relay-config-b-");
  const storagePathA = tmpDir("party-p2p-relay-storage-a-");
  const storagePathB = tmpDir("party-p2p-relay-storage-b-");
  const relayA = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir: dataDirA,
    storagePath: storagePathA,
    relayPeerId: "party-p2p-relay-host",
    startPeer: false
  });
  const relayB = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir: dataDirB,
    storagePath: storagePathB,
    relayPeerId: "party-p2p-relay-client",
    startPeer: false
  });
  t.after(async () => {
    await relayA.close();
    await relayB.close();
    fs.rmSync(dataDirA, { recursive: true, force: true });
    fs.rmSync(dataDirB, { recursive: true, force: true });
    fs.rmSync(storagePathA, { recursive: true, force: true });
    fs.rmSync(storagePathB, { recursive: true, force: true });
  });

  const [left, right] = fakeConnectionPair();
  relayA.attachConnection(left, { relayPeer: true });
  relayB.attachConnection(right, { relayPeer: true });
  left.sent.length = 0;
  right.sent.length = 0;

  const addressA = await relayA.listen();
  const addressB = await relayB.listen();
  const hostSocket = await connect(`ws://127.0.0.1:${addressA.port}`);
  const clientSocket = await connect(`ws://127.0.0.1:${addressB.port}`);
  const nextHostJson = makeJsonReader(hostSocket);
  const nextClientJson = makeJsonReader(clientSocket);
  t.after(() => hostSocket.close());
  t.after(() => clientSocket.close());

  hostSocket.send(JSON.stringify({ type: "host.register", roomName: "relay-test-room" }));
  assert.equal((await nextHostJson()).type, "host.register.ok");

  const hello = {
    type: "client/hello",
    protocol: 1,
    roomName: "relay-test-room",
    clientId: "guest_remote",
    relayHints: []
  };
  clientSocket.send(JSON.stringify(hello));
  assert.equal((await nextClientJson()).type, "relay.hints");

  const routed = await nextHostJson();
  assert.equal(routed.type, "relay/client-message");
  assert.deepEqual(routed.message, hello);
  assert.match(routed.peerId, /^party-p2p-relay-client-relay:ipc_/);

  hostSocket.send(JSON.stringify({
    type: "host.send",
    peerId: routed.peerId,
    message: { type: "host/welcome", protocol: 1, clientId: "guest_remote" }
  }));
  assert.deepEqual(await nextClientJson(), { type: "host/welcome", protocol: 1, clientId: "guest_remote" });

  hostSocket.send(JSON.stringify({
    type: "host.broadcast",
    roomName: "relay-test-room",
    message: { type: "host/state", protocol: 1, acceptedMutationId: "mut_remote" }
  }));
  assert.deepEqual(await nextClientJson(), { type: "host/state", protocol: 1, acceptedMutationId: "mut_remote" });
});

test("relay keeps disconnecting relays iced instead of forgetting them", async (t) => {
  const dataDir = tmpDir("party-p2p-relay-config-");
  const storagePath = tmpDir("party-p2p-relay-storage-");
  const relay = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    relayPeerId: "party-p2p-relay-host",
    startPeer: false
  });
  t.after(async () => {
    await relay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const relayConn = new FakeConn("party-p2p-relay-client-relay");
  relay.attachConnection(relayConn, { relayPeer: true });
  relayConn.emit("data", {
    type: "relay.status.ok",
    relayAddress: "peerjs:party-p2p-relay-client-relay",
    relayHints: []
  });

  const address = await relay.listen();
  let health = await getJson(`http://127.0.0.1:${address.port}/health`);
  assert.equal(health.knownRelays, 1);
  assert.equal(health.icedRelays, 0);
  assert.equal(health.relayLoad.icedRelays, 0);
  assert.equal(health.relayLoad.knownRelays, 1);

  relayConn.emit("data", {
    type: "relay.disconnecting",
    relayAddress: "peerjs:party-p2p-relay-client-relay"
  });

  health = await getJson(`http://127.0.0.1:${address.port}/health`);
  assert.equal(health.knownRelays, 1);
  assert.equal(health.icedRelays, 1);
  assert.equal(health.relayLoad.icedRelays, 1);
  assert.equal(health.relayLoad.knownRelays, 1);

  const socket = await connect(`ws://127.0.0.1:${address.port}`);
  const nextJson = makeJsonReader(socket);
  t.after(() => socket.close());
  socket.send(JSON.stringify({ type: "relay.status", requestId: "status_1" }));
  const status = await nextJson();
  assert.equal(status.type, "relay.status.ok");
  assert.equal(status.relayHints.includes("peerjs:party-p2p-relay-client-relay"), true);
  assert.deepEqual(status.icedRelayHints, ["peerjs:party-p2p-relay-client-relay"]);
});

test("relay IPC rejects non-party Nostr events", async (t) => {
  const dataDir = tmpDir("party-p2p-relay-config-");
  const storagePath = tmpDir("party-p2p-relay-storage-");
  const relay = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    storagePath,
    startPeer: false
  });
  t.after(async () => {
    await relay.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storagePath, { recursive: true, force: true });
  });

  const address = await relay.listen();
  const socket = await connect(`ws://127.0.0.1:${address.port}`);
  const nextJson = makeJsonReader(socket);
  t.after(() => socket.close());

  socket.send(JSON.stringify(["EVENT", { id: "bad", kind: 1, tags: [], content: "", created_at: 1, pubkey: "bad", sig: "bad" }]));
  assert.deepEqual(await nextJson(), ["OK", "bad", false, "Only party-p2p Nostr events are accepted"]);
});

test("peer relays mirror accepted party events to each other", () => {
  const relayA = new P2PNostrRelay();
  const relayB = new P2PNostrRelay();
  const [left, right] = fakeConnectionPair();
  const client = new FakeConn();
  const nostrEvent = makeRelayEvent("mirrored privately");

  relayA.attachConnection(left, { relayPeer: true });
  relayB.attachConnection(right, { relayPeer: true });
  relayB.attachConnection(client);

  client.emit("data", ["REQ", "sub_1", { kinds: [PARTY_NOSTR_KIND], "#d": ["relay-test-room"] }]);
  client.sent.length = 0;

  const result = relayA.publish(nostrEvent);

  assert.equal(result.ok, true);
  assert.deepEqual(client.sent, [["EVENT", "sub_1", nostrEvent]]);
  assert.equal(relayB.stats().events, 1);
});

test("peer relays reconcile missed events with merkle branches", () => {
  const relayA = new P2PNostrRelay();
  const relayB = new P2PNostrRelay();
  const events = Array.from({ length: 20 }, (_, index) => makeRelayEvent(`merkle ${index}`, 1760000000000 + index));
  for (const event of events) {
    const result = relayA.publish(event);
    assert.equal(result.ok, true);
  }

  const [left, right] = fakeConnectionPair();
  relayA.attachConnection(left, { relayPeer: true });
  relayB.attachConnection(right, { relayPeer: true });

  assert.equal(relayB.stats().events, events.length);
  assert.equal(right.sent.some((message) => message.type === "relay.events.want"), true);
  assert.equal(left.sent.some((message) => message.type === "relay.events.branch"), true);
});

test("relay CLI expands home storage paths", () => {
  const parsed = parseArgs(["--storage", "~/.party-p2p/relay"]);
  assert.equal(parsed.storagePath, path.join(os.homedir(), ".party-p2p", "relay"));
});

test("relay CLI uses the project-specific default IPC port", () => {
  assert.equal(parseArgs([]).ipcPort, 42777);
});

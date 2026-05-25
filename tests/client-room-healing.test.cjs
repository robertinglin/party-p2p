const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}

class FakeConnection {
  constructor(peerId) {
    this.peer = peerId;
    this.open = false;
    this.sent = [];
    this.handlers = { data: [], close: [], error: [], open: [] };
    setTimeout(() => {
      this.open = true;
      this.emit("open");
    }, 0);
  }

  send(message) {
    this.sent.push(message);
    if (message?.type === "relay.status") {
      this.emit("data", {
        type: "relay.status.ok",
        requestId: message.requestId,
        relayAddress: "peerjs:party-p2p-room-relay",
        roomPeerId: "party-p2p-room",
        relayMeshPeerId: "party-p2p-room-relay",
        relayHints: [],
        load: { clients: 0, roomHosts: 1 }
      });
    }
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

const fakePeers = [];

class FakePeer {
  constructor() {
    this.destroyed = false;
    this.connections = [];
    this.handlers = { open: [], disconnected: [], error: [] };
    fakePeers.push(this);
    setTimeout(() => this.emit("open", "client-peer"), 0);
  }

  connect(peerId) {
    const conn = new FakeConnection(peerId);
    this.connections.push(conn);
    return conn;
  }

  reconnect() {}

  destroy() {
    this.destroyed = true;
    for (const conn of this.connections) conn.close();
  }

  on(event, callback) {
    this.handlers[event].push(callback);
  }

  emit(event, value) {
    for (const handler of this.handlers[event]) handler(value);
  }
}

function loadPeerRoom() {
  require.extensions[".ts"] ||= (mod, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    mod._compile(output, filename);
  };

  const file = path.join(__dirname, "..", "client", "src", "lib", "peerRoom.ts");
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request === "peerjs") return { default: FakePeer };
    if (request.startsWith("./")) return require(path.join(path.dirname(file), request));
    return require(request);
  };
  const fn = new Function("exports", "module", "require", output);
  fn(module.exports, module, localRequire);
  return module.exports;
}

function welcome() {
  return {
    type: "host/welcome",
    protocol: 1,
    role: "guest",
    clientId: "guest_1",
    state: {
      version: 1,
      updatedAt: 1,
      details: {},
      guests: {},
      posts: [],
      comments: [],
      adminIds: []
    }
  };
}

test("client retries pending mutations after reconnecting to a healed route", async () => {
  fakePeers.length = 0;
  const { P2PRoomClient } = loadPeerRoom();
  const client = new P2PRoomClient(
    {
      roomName: "route-healing-room",
      roomPeerId: "party-p2p-room",
      relayAddress: "peerjs:party-p2p-room-relay",
      roomSecret: "secret"
    },
    {
      id: "guest_1",
      name: "Guest",
      avatar: "*"
    },
    {
      onStatus() {},
      onState() {},
      onRole() {},
      onError(message) {
        throw new Error(message);
      }
    }
  );

  await client.start();
  const peer = await waitFor(() => fakePeers[0]);
  const firstRoomConn = await waitFor(() => peer.connections.find((conn) => conn.peer === "party-p2p-room"));
  await waitFor(() => firstRoomConn.sent.find((message) => message.type === "client/hello"));
  firstRoomConn.emit("data", welcome());

  client.sendMutation("post.add", { body: "hello after a route break" });
  const firstMutation = await waitFor(() => firstRoomConn.sent.find((message) => message.type === "client/mutation"));
  firstRoomConn.close();

  const secondRoomConn = await waitFor(() => peer.connections.filter((conn) => conn.peer === "party-p2p-room")[1]);
  await waitFor(() => secondRoomConn.sent.find((message) => message.type === "client/hello"));
  secondRoomConn.emit("data", welcome());

  const retriedMutation = await waitFor(() => secondRoomConn.sent.find((message) => message.type === "client/mutation"));
  assert.equal(retriedMutation.mutation.id, firstMutation.mutation.id);

  secondRoomConn.emit("data", {
    type: "host/state",
    protocol: 1,
    state: welcome().state,
    acceptedMutationId: retriedMutation.mutation.id
  });
  client.destroy();
});

test("client reconnects when a relay announces disconnecting", async () => {
  fakePeers.length = 0;
  const { P2PRoomClient } = loadPeerRoom();
  const client = new P2PRoomClient(
    {
      roomName: "relay-disconnect-room",
      roomPeerId: "party-p2p-room",
      relayAddress: "peerjs:party-p2p-room-relay",
      roomSecret: "secret"
    },
    {
      id: "guest_1",
      name: "Guest",
      avatar: "*"
    },
    {
      onStatus() {},
      onState() {},
      onRole() {},
      onError(message) {
        throw new Error(message);
      }
    }
  );

  await client.start();
  const peer = await waitFor(() => fakePeers[0]);
  const firstRoomConn = await waitFor(() => peer.connections.find((conn) => conn.peer === "party-p2p-room"));
  await waitFor(() => firstRoomConn.sent.find((message) => message.type === "client/hello"));
  firstRoomConn.emit("data", welcome());

  firstRoomConn.emit("data", {
    type: "relay.disconnecting",
    relayAddress: "peerjs:party-p2p-room-relay",
    roomPeerId: "party-p2p-room"
  });

  const secondRoomConn = await waitFor(() => peer.connections.filter((conn) => conn.peer === "party-p2p-room")[1]);
  await waitFor(() => secondRoomConn.sent.find((message) => message.type === "client/hello"));
  client.destroy();
});

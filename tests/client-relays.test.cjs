const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadModule(file) {
  require.extensions[".ts"] ||= (mod, filename) => {
    const tsSource = fs.readFileSync(filename, "utf8");
    mod._compile(ts.transpileModule(tsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  };

  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText;
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request.startsWith("./")) return require(path.join(path.dirname(file), request));
    return require(request);
  };
  const fn = new Function("exports", "module", "require", output);
  fn(module.exports, module, localRequire);
  return module.exports;
}

class FakeConnection {
  constructor(script) {
    this.open = true;
    this.peer = "party-p2p-relay-a";
    this.sent = [];
    this.handlers = { data: [], close: [], error: [], open: [] };
    this.script = script;
  }

  send(message) {
    this.sent.push(message);
    this.script?.(this, message);
  }

  close() {
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

function relayEvent(id, createdAt = 10) {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind: 9321,
    tags: [["d", "relay-test-room"]],
    content: "{}",
    sig: "b".repeat(128)
  };
}

const relayBook = loadModule(path.join(__dirname, "..", "client", "src", "lib", "relayBook.ts"));
const nostrClient = loadModule(path.join(__dirname, "..", "client", "src", "lib", "nostrClient.ts"));

test("client relay book stores normalized relay addresses and liveness", () => {
  const partyId = `relay-book-${Date.now()}`;

  relayBook.rememberRelay(partyId, "party-p2p-relay-a", "invite", 1000);
  relayBook.rememberRelay(partyId, "peerjs:party-p2p-relay-b-relay", "client", 2000);
  relayBook.markRelayLive(partyId, "party-p2p-relay-a", 3000);
  relayBook.markRelayOffline(partyId, "peerjs:party-p2p-relay-b", 4000);

  assert.deepEqual(relayBook.loadKnownRelays(partyId), [
    {
      address: "peerjs:party-p2p-relay-b-relay",
      firstSeenAt: 2000,
      lastSeenAt: 4000,
      lastFailedAt: 4000,
      roomPeerId: "party-p2p-relay-b",
      source: "client"
    },
    {
      address: "peerjs:party-p2p-relay-a-relay",
      firstSeenAt: 1000,
      lastSeenAt: 3000,
      lastLiveAt: 3000,
      roomPeerId: "party-p2p-relay-a",
      source: "invite"
    }
  ]);

  relayBook.markRelayStatus(partyId, "peerjs:party-p2p-relay-a-relay", {
    roomPeerId: "party-p2p-relay-a",
    load: { clients: 2 }
  }, 5000);
  assert.equal(relayBook.loadKnownRelays(partyId).find((relay) => relay.address === "peerjs:party-p2p-relay-a-relay")?.lastLoad, 2);
});

test("client can query live PeerJS relays and dedupe events", async () => {
  const event = relayEvent("event_a");
  const peer = {
    connect(peerId) {
      assert.equal(peerId, "party-p2p-relay-a-relay");
      return new FakeConnection((conn, message) => {
        if (message[0] !== "REQ") return;
        conn.emit("data", ["EVENT", message[1], event]);
        conn.emit("data", ["EVENT", message[1], event]);
        conn.emit("data", ["EOSE", message[1]]);
      });
    }
  };

  const client = new nostrClient.PeerRelayNostrClient(peer);
  const result = await client.queryRelays(["peerjs:party-p2p-relay-a"], { "#d": ["relay-test-room"], limit: 10 });

  assert.equal(result.liveRelays.length, 1);
  assert.equal(result.offlineRelays.length, 0);
  assert.deepEqual(result.events, [event]);
});

test("client can read relay status for low-load room selection", async () => {
  const peer = {
    connect(peerId) {
      assert.equal(peerId, "party-p2p-relay-a-relay");
      return new FakeConnection((conn, message) => {
        if (message.type !== "relay.status") return;
        conn.emit("data", {
          type: "relay.status.ok",
          requestId: message.requestId,
          relayAddress: "peerjs:party-p2p-relay-a-relay",
          roomPeerId: "party-p2p-relay-a",
          relayMeshPeerId: "party-p2p-relay-a-relay",
          relayHints: ["peerjs:party-p2p-relay-b-relay"],
          load: { clients: 1, roomHosts: 0 }
        });
      });
    }
  };

  const client = new nostrClient.PeerRelayNostrClient(peer);
  const status = await client.queryRelayStatus("peerjs:party-p2p-relay-a");

  assert.equal(status.live, true);
  assert.equal(status.roomPeerId, "party-p2p-relay-a");
  assert.equal(status.load.clients, 1);
  assert.deepEqual(status.relayHints, ["peerjs:party-p2p-relay-b-relay"]);
});

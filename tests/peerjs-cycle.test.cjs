const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const { applyMutation } = require("../host/host.cjs");
const { createNodePeer } = require("../host/nodePeer.cjs");
const { createPartyRelay } = require("../host/relay.cjs");
const { applyPeerServerEnv, startLocalPeerServer } = require("./localPeerServer.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(message) {
  console.log(`[peerjs-cycle] ${message}`);
}

async function waitFor(predicate) {
  while (true) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
}

function runLoggedCommand(label, command, args, options = {}) {
  logStep(`${label}: ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      for (const line of text.trimEnd().split(/\r?\n/).filter(Boolean)) logStep(`${label} stdout: ${line}`);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      for (const line of text.trimEnd().split(/\r?\n/).filter(Boolean)) logStep(`${label} stderr: ${line}`);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${label} exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function connectJson(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];
    const waiters = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    });
    socket.once("open", () => {
      resolve({
        socket,
        send(message) {
          socket.send(JSON.stringify(message));
        },
        async next() {
          if (messages.length > 0) return Promise.resolve(messages.shift());
          return new Promise((nextResolve, nextReject) => waiters.push({ resolve: nextResolve, reject: nextReject }));
        }
      });
    });
    socket.once("error", reject);
  });
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.json();
}

function secretProof(secret, roomName, clientId) {
  return crypto.createHash("sha256").update(`${secret}:${roomName}:${clientId}`).digest("hex");
}

function makeStore(roomName, dataDir) {
  return {
    dataDir,
    roomName,
    roomSecret: "cycle-secret",
    admins: {},
    seenMutations: [],
    state: {
      version: 0,
      updatedAt: 0,
      details: {
        id: `event_${roomName}`,
        roomName,
        title: "PeerJS Cycle",
        date: "2026-06-20",
        time: "8:00 PM",
        location: "Test Venue",
        description: "",
        coverEmoji: "*",
        dressCode: "",
        hostNote: "",
        theme: "sunset"
      },
      guests: {},
      posts: [],
      comments: [],
      adminIds: ["admin_1"]
    }
  };
}

function createNodeClient(profile, config) {
  let peer;
  let conn;
  let activeRoomPeerId;
  let destroyed = false;
  const messages = [];
  const waiters = [];

  function push(message) {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  }

  return {
    async connect(roomPeerId) {
      activeRoomPeerId = roomPeerId;
      logStep(`${profile.id}: creating node PeerJS client`);
      peer = await createNodePeer(undefined, [{ urls: "stun:stun.l.google.com:19302" }]);
      peer.on("error", (error) => console.warn(`[peerjs-cycle] ${profile.id}: peer error`, error?.type || "", error?.message || error));
      await new Promise((resolve) => peer.once("open", resolve));
      logStep(`${profile.id}: peer open as ${peer.id}`);
      await this.connectRoom(roomPeerId);
    },
    async connectRoom(roomPeerId) {
      activeRoomPeerId = roomPeerId;
      conn = peer.connect(roomPeerId, {
        reliable: true,
        serialization: "json",
        metadata: {
          roomName: config.roomName,
          clientId: profile.id,
          relayHints: [config.relayAddress]
        }
      });
      conn.on("error", (error) => console.warn(`[peerjs-cycle] ${profile.id}: connection error`, error?.type || "", error?.message || error));
      conn.on("close", () => {
        logStep(`${profile.id}: connection closed`);
        if (destroyed || !config.autoReconnect) return;
        const nextRoomPeerId = config.relayRoomPeerIds.find((peerId) => peerId !== activeRoomPeerId);
        if (nextRoomPeerId) {
          setTimeout(() => {
            if (!destroyed) void this.connectRoom(nextRoomPeerId);
          }, 100);
        }
      });
      conn.on("data", push);
      await new Promise((resolve) => conn.once("open", resolve));
      logStep(`${profile.id}: connected to room relay ${roomPeerId}`);
      this.sendHello();
    },
    sendHello() {
      conn.send({
        type: "client/hello",
        protocol: 1,
        roomName: config.roomName,
        clientId: profile.id,
        profile,
        secretProof: secretProof(config.roomSecret, config.roomName, profile.id),
        relayHints: [config.relayAddress]
      });
      logStep(`${profile.id}: sent client/hello`);
    },
    sendMutation(mutation) {
      conn.send({
        type: "client/mutation",
        protocol: 1,
        roomName: config.roomName,
        mutation
      });
      logStep(`${profile.id}: sent mutation ${mutation.id}`);
    },
    async next() {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      destroyed = true;
      conn?.close();
      peer?.destroy();
    }
  };
}

test("real PeerJS relay cycle routes two node clients through two relays", { skip: process.env.PARTY_P2P_RUN_PEERJS_E2E !== "1" }, async (t) => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const roomName = `peerjs-cycle-${suffix}`;
  const relayAId = `party-p2p-cycle-a-${suffix}`;
  const relayBId = `party-p2p-cycle-b-${suffix}`;
  const dataDirA = tmpDir("party-p2p-cycle-config-a-");
  const dataDirB = tmpDir("party-p2p-cycle-config-b-");
  const storagePathA = tmpDir("party-p2p-cycle-storage-a-");
  const storagePathB = tmpDir("party-p2p-cycle-storage-b-");
  const hostDataDir = tmpDir("party-p2p-cycle-host-");
  const store = makeStore(roomName, hostDataDir);
  const peerServer = await startLocalPeerServer();
  applyPeerServerEnv(peerServer);
  logStep(`local PeerJS server ws://${peerServer.host}:${peerServer.port}${peerServer.path}`);
  const relayA = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir: dataDirA,
    storagePath: storagePathA,
    relayPeerId: relayAId
  });
  const relayB = createPartyRelay({
    host: "127.0.0.1",
    port: 0,
    dataDir: dataDirB,
    storagePath: storagePathB,
    relayPeerId: relayBId
  });
  const clients = [];

  t.after(async () => {
    logStep("cleaning up");
    for (const client of clients) client.close();
    await relayA.close();
    await relayB.close();
    await peerServer.close();
    fs.rmSync(dataDirA, { recursive: true, force: true });
    fs.rmSync(dataDirB, { recursive: true, force: true });
    fs.rmSync(hostDataDir, { recursive: true, force: true });
    fs.rmSync(storagePathA, { recursive: true, force: true });
    fs.rmSync(storagePathB, { recursive: true, force: true });
  });

  logStep(`starting relay A as ${relayAId}`);
  const addressA = await relayA.listen();
  logStep(`starting relay B as ${relayBId}`);
  const addressB = await relayB.listen();
  logStep(`relay A IPC ws://127.0.0.1:${addressA.port}`);
  logStep(`relay B IPC ws://127.0.0.1:${addressB.port}`);
  await waitFor(() => relayA.config.relayPeerId && relayB.config.relayPeerId);

  logStep("telling relay A that relay B exists through the CLI");
  const addResult = await runLoggedCommand("relay add", process.execPath, [
    path.join(__dirname, "..", "bin", "party-p2p.cjs"),
    "relay",
    "add",
    relayB.config.relayAddress,
    "--ipc-port",
    String(addressA.port)
  ], {
    cwd: path.join(__dirname, ".."),
    env: process.env
  });
  assert.match(addResult.stdout, /Added relay/);
  logStep("waiting for relay mesh connection after add");
  await waitFor(async () => {
    const [healthA, healthB] = await Promise.all([
      getJson(`http://127.0.0.1:${addressA.port}/health`),
      getJson(`http://127.0.0.1:${addressB.port}/health`)
    ]);
    logStep(`relay health: A connections=${healthA.relayLoad.relayConnections}, B connections=${healthB.relayLoad.relayConnections}`);
    return healthA.relayLoad.relayConnections > 0 && healthB.relayLoad.relayConnections > 0;
  });

  const clientTwo = createNodeClient({ id: "admin_2", name: "Second Admin", avatar: "*" }, {
    roomName,
    roomSecret: store.roomSecret,
    relayAddress: relayB.config.relayAddress,
    relayRoomPeerIds: [relayB.config.relayPeerId, relayA.config.relayPeerId],
    autoReconnect: true
  });
  clients.push(clientTwo);

  logStep("prematurely connecting client two to relay B before the host exists");
  await clientTwo.connect(relayB.config.relayPeerId);
  await waitFor(async () => {
    const message = await clientTwo.next();
    logStep(`admin_2 premature path saw ${message.type}${message.code ? ` ${message.code}` : ""}`);
    return message.type === "relay.hints" || (message.type === "host/error" && message.code === "host-unavailable");
  });

  logStep("connecting fake host to relay A IPC");
  const host = await connectJson(`ws://127.0.0.1:${addressA.port}`);
  t.after(() => host.socket.close());
  logStep("registering fake host");
  host.send({ type: "host.register", roomName, relayHints: [relayA.config.relayAddress, relayB.config.relayAddress] });
  assert.equal((await host.next("host.register.ok")).type, "host.register.ok");
  logStep("fake host registered");

  const clientOne = createNodeClient({ id: "admin_1", name: "Admin", avatar: "*" }, {
    roomName,
    roomSecret: store.roomSecret,
    relayAddress: relayA.config.relayAddress,
    relayRoomPeerIds: [relayA.config.relayPeerId]
  });
  clients.push(clientOne);

  logStep("connecting client one to relay A room peer as admin");
  await clientOne.connect(relayA.config.relayPeerId);
  logStep("client two retries hello to enter the event through relay B");
  clientTwo.sendHello();

  const helloOne = await waitFor(async () => {
    const message = await host.next("admin_1 hello routed to host");
    logStep(`host saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.clientId ? ` from ${message.message.clientId}` : ""}`);
    return message.type === "relay/client-message" && message.message.clientId === "admin_1" ? message : undefined;
  });
  const helloTwo = await waitFor(async () => {
    const message = await host.next("admin_2 hello routed to host");
    logStep(`host saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.clientId ? ` from ${message.message.clientId}` : ""}`);
    return message.type === "relay/client-message" && message.message.clientId === "admin_2" ? message : undefined;
  });
  logStep("host received both client hellos");

  for (const hello of [helloOne, helloTwo]) {
    store.state.guests[hello.message.clientId] = {
      id: hello.message.clientId,
      name: hello.message.profile.name,
      avatar: hello.message.profile.avatar,
      rsvp: "unset",
      role: "admin",
      joinedAt: Date.now(),
      lastSeenAt: Date.now()
    };
    host.send({
      type: "host.send",
      peerId: hello.peerId,
      message: {
        type: "host/welcome",
        protocol: 1,
        state: store.state,
        role: "admin",
        clientId: hello.message.clientId
      }
    });
    logStep(`host sent welcome to ${hello.message.clientId}`);
  }

  await waitFor(async () => {
    const message = await clientOne.next("admin_1 welcome");
    logStep(`admin_1 saw ${message.type}`);
    return message.type === "host/welcome";
  });
  await waitFor(async () => {
    const message = await clientTwo.next("admin_2 welcome");
    logStep(`admin_2 saw ${message.type}`);
    return message.type === "host/welcome";
  });

  const mutation = {
    id: `mut_client_2_${suffix}`,
    clientId: "admin_2",
    seq: 1,
    ts: Date.now(),
    op: "post.add",
    payload: {
      body: "client two comment through relay B"
    }
  };
  clientTwo.sendMutation(mutation);

  const routedMutation = await waitFor(async () => {
    const message = await host.next("client two comment routed to host");
    logStep(`host saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.mutation?.id ? ` ${message.message.mutation.id}` : ""}`);
    return message.type === "relay/client-message" && message.message.mutation?.id === mutation.id ? message : undefined;
  });
  const result = applyMutation(store, routedMutation.message.mutation, "admin");
  assert.equal(result.changed, true);
  assert.equal(store.state.posts.at(-1).body, "client two comment through relay B");

  host.send({
    type: "host.broadcast",
    roomName,
    message: {
      type: "host/state",
      protocol: 1,
      state: store.state,
      acceptedMutationId: mutation.id
    }
  });
  logStep("host broadcast accepted location state");

  const clientOneState = await waitFor(async () => {
    const message = await clientOne.next("admin_1 accepted state");
    logStep(`admin_1 saw ${message.type}${message.acceptedMutationId ? ` ${message.acceptedMutationId}` : ""}`);
    return message.type === "host/state" && message.acceptedMutationId === mutation.id ? message : undefined;
  });
  const clientTwoState = await waitFor(async () => {
    const message = await clientTwo.next("admin_2 accepted state");
    logStep(`admin_2 saw ${message.type}${message.acceptedMutationId ? ` ${message.acceptedMutationId}` : ""}`);
    return message.type === "host/state" && message.acceptedMutationId === mutation.id ? message : undefined;
  });
  assert.equal(clientOneState.state.posts.at(-1).body, "client two comment through relay B");
  assert.equal(clientTwoState.state.posts.at(-1).body, "client two comment through relay B");

  const clientOneMutation = {
    id: `mut_client_1_${suffix}`,
    clientId: "admin_1",
    seq: 1,
    ts: Date.now(),
    op: "post.add",
    payload: {
      body: "client one reply through relay A"
    }
  };
  clientOne.sendMutation(clientOneMutation);
  const routedClientOneMutation = await waitFor(async () => {
    const message = await host.next("client one reply routed to host");
    logStep(`host saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.mutation?.id ? ` ${message.message.mutation.id}` : ""}`);
    return message.type === "relay/client-message" && message.message.mutation?.id === clientOneMutation.id ? message : undefined;
  });
  assert.equal(applyMutation(store, routedClientOneMutation.message.mutation, "admin").changed, true);
  host.send({
    type: "host.broadcast",
    roomName,
    message: {
      type: "host/state",
      protocol: 1,
      state: store.state,
      acceptedMutationId: clientOneMutation.id
    }
  });
  const clientTwoReplyState = await waitFor(async () => {
    const message = await clientTwo.next("client two receives client one reply");
    logStep(`admin_2 saw ${message.type}${message.acceptedMutationId ? ` ${message.acceptedMutationId}` : ""}`);
    return message.type === "host/state" && message.acceptedMutationId === clientOneMutation.id ? message : undefined;
  });
  assert.equal(clientTwoReplyState.state.posts.at(-1).body, "client one reply through relay A");

  logStep("taking relay B down");
  await relayB.close();
  const immediateMutation = {
    id: `mut_after_b_down_${suffix}`,
    clientId: "admin_1",
    seq: 2,
    ts: Date.now(),
    op: "post.add",
    payload: {
      body: "client one immediate message after relay B down"
    }
  };
  clientOne.sendMutation(immediateMutation);
  const routedImmediateMutation = await waitFor(async () => {
    const message = await host.next("client one immediate mutation after relay B down");
    logStep(`host saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.mutation?.id ? ` ${message.message.mutation.id}` : ""}`);
    return message.type === "relay/client-message" && message.message.mutation?.id === immediateMutation.id ? message : undefined;
  });
  assert.equal(applyMutation(store, routedImmediateMutation.message.mutation, "admin").changed, true);
  host.send({
    type: "host.broadcast",
    roomName,
    message: {
      type: "host/state",
      protocol: 1,
      state: store.state,
      acceptedMutationId: immediateMutation.id
    }
  });

  const healedHello = await waitFor(async () => {
    const message = await host.next("client two reconnect hello on relay A");
    logStep(`host saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.clientId ? ` from ${message.message.clientId}` : ""}`);
    return message.type === "relay/client-message" && message.message.type === "client/hello" && message.message.clientId === "admin_2" ? message : undefined;
  });
  host.send({
    type: "host.send",
    peerId: healedHello.peerId,
    message: {
      type: "host/welcome",
      protocol: 1,
      state: store.state,
      role: "admin",
      clientId: "admin_2"
    }
  });
  const healedState = await waitFor(async () => {
    const message = await clientTwo.next("client two healed welcome with immediate message");
    logStep(`admin_2 healed path saw ${message.type}`);
    return message.type === "host/welcome" ? message : undefined;
  });
  assert.equal(healedState.state.posts.at(-1).body, "client one immediate message after relay B down");
});

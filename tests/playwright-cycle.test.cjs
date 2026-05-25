const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const WebSocket = require("ws");

const { applyMutation } = require("../host/host.cjs");
const { createPartyRelay } = require("../host/relay.cjs");
const { applyPeerServerEnv, startLocalPeerServer } = require("./localPeerServer.cjs");

const APP_PORT = Number(process.env.PARTY_P2P_PLAYWRIGHT_APP_PORT || 43829 + Math.floor(Math.random() * 1000));

function isPeerJsCandidateRace(error) {
  return error?.stack?.includes("peerjs")
    && (
      (error?.message?.includes("emitError") && error?.stack?.includes("handleCandidate"))
      || error?.message?.includes("_initializeDataChannel")
    );
}

function installPeerJsRaceFilter() {
  const onError = (error) => {
    if (isPeerJsCandidateRace(error)) {
      logStep(`ignored transient PeerJS candidate race: ${error.message}`);
      return;
    }
    throw error;
  };
  process.prependListener("uncaughtException", onError);
  process.prependListener("unhandledRejection", onError);
  return () => {
    process.removeListener("uncaughtException", onError);
    process.removeListener("unhandledRejection", onError);
  };
}

function logStep(message) {
  console.log(`[playwright-cycle] ${message}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate) {
  while (true) {
    const value = await predicate();
    if (value) return value;
    await delay(50);
  }
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function connectJson(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];
    const waiters = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      while (waiters[0]?.signal?.aborted) waiters.shift();
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
        async next(options = {}) {
          if (messages.length > 0) return messages.shift();
          return new Promise((nextResolve, nextReject) => {
            const waiter = { resolve: nextResolve, reject: nextReject, signal: options.signal };
            waiters.push(waiter);
            options.signal?.addEventListener("abort", () => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
            }, { once: true });
          });
        }
      });
    });
    socket.once("error", reject);
  });
}

function makeStore(roomName, dataDir) {
  return {
    dataDir,
    roomName,
    roomSecret: "browser-secret",
    admins: {},
    seenMutations: [],
    state: {
      version: 0,
      updatedAt: Date.now(),
      details: {
        id: `event_${roomName}`,
        roomName,
        title: "Browser Cycle",
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
      adminIds: []
    }
  };
}

function runProcess(label, command, args, options = {}) {
  logStep(`${label}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd || path.join(__dirname, ".."),
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    windowsHide: false
  });
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").trimEnd().split(/\r?\n/).filter(Boolean)) logStep(`${label} stdout: ${line}`);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").trimEnd().split(/\r?\n/).filter(Boolean)) logStep(`${label} stderr: ${line}`);
  });
  return child;
}

async function importPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run `npm install -D playwright` and `npx playwright install chromium`.");
  }
}

function inviteUrl(roomName, roomPeerId, relayAddress) {
  const params = new URLSearchParams({
    roomPeerId,
    relayAddress,
    secret: "browser-secret"
  });
  return `http://127.0.0.1:${APP_PORT}/#/room/${roomName}?${params.toString()}`;
}

async function joinAs(page, name) {
  await page.bringToFront();
  logStep(`${name}: filling nickname`);
  await page.getByLabel("Party nickname").fill(name);
  logStep(`${name}: clicking join`);
  await page.getByRole("button", { name: "Join", exact: true }).click();
}

async function sendComment(page, body) {
  await page.bringToFront();
  logStep(`sending comment: ${body}`);
  logStep(`comment input enabled: ${await page.getByTestId("comment-input").isEnabled()}`);
  await page.getByTestId("comment-input").fill(body);
  logStep(`filled comment: ${body}`);
  await page.getByTestId("comment-send").click();
  logStep(`submitted comment: ${body}`);
}

async function waitForText(page, text, label) {
  logStep(`waiting for ${label}: ${text}`);
  try {
    await page.waitForFunction((expectedText) => document.body.innerText.includes(expectedText), text);
    logStep(`saw ${label}: ${text}`);
  } catch (error) {
    const bodyText = await page.locator("body").innerText().catch(() => "<body unavailable>");
    logStep(`${label} missing; page text:\n${bodyText}`);
    throw error;
  }
}

async function waitForEventUi(page, label) {
  logStep(`waiting for ${label} event UI`);
  try {
    await page.getByTestId("comment-send").waitFor();
    await waitFor(async () => {
      return await page.getByTestId("comment-input").isEnabled()
        && await page.getByTestId("comment-send").isEnabled();
    });
    logStep(`${label} event UI ready`);
  } catch (error) {
    const bodyText = await page.locator("body").innerText().catch(() => "<body unavailable>");
    logStep(`${label} event UI missing; page text:\n${bodyText}`);
    throw error;
  }
}

async function routeHostMessages(host, store, expectedIds) {
  const routed = new Map();
  const welcomed = new Set();
  while (routed.size < expectedIds.length) {
    const message = await host.next(`host message ${expectedIds.join(",")}`);
    logStep(`host saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.clientId ? ` ${message.message.clientId}` : ""}${message.message?.mutation?.id ? ` ${message.message.mutation.id}` : ""}`);
    if (message.type !== "relay/client-message") continue;
    if (message.message.type === "client/hello") {
      if (!welcomed.has(message.message.clientId)) {
        sendWelcomeForHello(host, store, message);
        welcomed.add(message.message.clientId);
      }
      routed.set(message.message.clientId, message);
      continue;
    }
    if (message.message.type === "client/mutation") {
      const role = store.state.adminIds.includes(message.message.mutation.clientId) ? "admin" : "guest";
      const result = applyMutation(store, message.message.mutation, role);
      assert.equal(result.changed, true);
      host.send({
        type: "host.broadcast",
        roomName: store.roomName,
        message: {
          type: "host/state",
          protocol: 1,
          state: store.state,
          acceptedMutationId: message.message.mutation.id
        }
      });
      routed.set(message.message.mutation.id, message);
    }
  }
  return routed;
}

function sendWelcomeForHello(host, store, message) {
  const role = message.message.profile.name === "Browser One" ? "admin" : "guest";
  store.state.guests[message.message.clientId] = {
    id: message.message.clientId,
    name: message.message.profile.name,
    avatar: message.message.profile.avatar,
    rsvp: "unset",
    role,
    joinedAt: Date.now(),
    lastSeenAt: Date.now()
  };
  if (role === "admin" && !store.state.adminIds.includes(message.message.clientId)) store.state.adminIds.push(message.message.clientId);
  host.send({
    type: "host.send",
    peerId: message.peerId,
    message: {
      type: "host/welcome",
      protocol: 1,
      state: store.state,
      role,
      clientId: message.message.clientId
    }
  });
  logStep(`host sent welcome to ${message.message.profile.name} as ${role} via ${message.peerId}`);
}

async function routeMutation(host, store, predicate, label) {
  while (true) {
    const message = await host.next(label);
    logStep(`host saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.mutation?.op ? ` ${message.message.mutation.op}` : ""}${message.message?.mutation?.id ? ` ${message.message.mutation.id}` : ""}`);
    if (message.type !== "relay/client-message") continue;
    if (message.message.type === "client/hello") {
      sendWelcomeForHello(host, store, message);
      continue;
    }
    if (message.message.type !== "client/mutation") continue;
    const mutation = message.message.mutation;
    const role = store.state.adminIds.includes(mutation.clientId) ? "admin" : "guest";
    const result = applyMutation(store, mutation, role);
    if (!result.changed) continue;
    host.send({
      type: "host.broadcast",
      roomName: store.roomName,
      message: {
        type: "host/state",
        protocol: 1,
        state: store.state,
        acceptedMutationId: mutation.id
      }
    });
    logStep(`host broadcast accepted mutation ${mutation.id}`);
    if (predicate(mutation)) return mutation;
  }
}

function keepWelcomingClients(host, store) {
  const controller = new AbortController();
  const welcomed = new Set();
  async function pump() {
    while (!controller.signal.aborted) {
      const message = await host.next({ signal: controller.signal });
      logStep(`host pump saw ${message.type}${message.message?.type ? `/${message.message.type}` : ""}${message.message?.clientId ? ` ${message.message.clientId}` : ""}`);
      if (message.type === "relay/client-message" && message.message.type === "client/hello") {
        if (!welcomed.has(message.message.clientId)) {
          sendWelcomeForHello(host, store, message);
          welcomed.add(message.message.clientId);
        }
      }
    }
  }
  void pump();
  return () => {
    controller.abort();
  };
}

async function runPlaywrightCycle(t) {
  const removePeerJsRaceFilter = installPeerJsRaceFilter();
  const previousRelayDebug = process.env.PARTY_P2P_RELAY_DEBUG;
  const verboseDebug = process.env.PARTY_P2P_PLAYWRIGHT_DEBUG === "1";
  if (verboseDebug) process.env.PARTY_P2P_RELAY_DEBUG = "1";
  const { chromium } = await importPlaywright();
  const suffix = crypto.randomBytes(4).toString("hex");
  const roomName = `browser-cycle-${suffix}`;
  const relayAId = `party-p2p-browser-a-${suffix}`;
  const relayBId = `party-p2p-browser-b-${suffix}`;
  const dataDirA = tmpDir("party-p2p-browser-config-a-");
  const dataDirB = tmpDir("party-p2p-browser-config-b-");
  const storagePathA = tmpDir("party-p2p-browser-storage-a-");
  const storagePathB = tmpDir("party-p2p-browser-storage-b-");
  const hostDataDir = tmpDir("party-p2p-browser-host-");
  const store = makeStore(roomName, hostDataDir);
  const peerServer = await startLocalPeerServer();
  applyPeerServerEnv(peerServer);
  logStep(`local PeerJS server ws://${peerServer.host}:${peerServer.port}${peerServer.path}`);
  const relayA = createPartyRelay({ host: "127.0.0.1", port: 0, dataDir: dataDirA, storagePath: storagePathA, relayPeerId: relayAId });
  const relayB = createPartyRelay({ host: "127.0.0.1", port: 0, dataDir: dataDirB, storagePath: storagePathB, relayPeerId: relayBId });
  let browser;
  let vite;

  t.after(async () => {
    logStep("cleaning up");
    removePeerJsRaceFilter();
    if (verboseDebug) {
      if (previousRelayDebug === undefined) delete process.env.PARTY_P2P_RELAY_DEBUG;
      else process.env.PARTY_P2P_RELAY_DEBUG = previousRelayDebug;
    }
    logStep("closing browser");
    await browser?.close().catch(() => undefined);
    logStep("browser closed");
    logStep("stopping vite");
    vite?.kill();
    logStep("closing relay A");
    void relayA.close();
    logStep("closing relay B");
    void relayB.close();
    logStep("closing local PeerJS server");
    void peerServer.close();
    await delay(100);
    logStep("removing temp data");
    fs.rmSync(dataDirA, { recursive: true, force: true });
    fs.rmSync(dataDirB, { recursive: true, force: true });
    fs.rmSync(storagePathA, { recursive: true, force: true });
    fs.rmSync(storagePathB, { recursive: true, force: true });
    fs.rmSync(hostDataDir, { recursive: true, force: true });
    logStep("cleanup complete");
  });

  vite = runProcess("vite", process.execPath, [
    path.join(__dirname, "..", "node_modules", "vite", "bin", "vite.js"),
    "--config",
    "client/vite.config.ts",
    "--host",
    "0.0.0.0",
    "--port",
    String(APP_PORT),
    "--strictPort"
  ]);
  await waitFor(() => fetch(`http://127.0.0.1:${APP_PORT}/`).then((response) => response.ok).catch(() => false));

  const addressA = await relayA.listen();
  const addressB = await relayB.listen();
  logStep(`relay A IPC ws://127.0.0.1:${addressA.port}`);
  logStep(`relay B IPC ws://127.0.0.1:${addressB.port}`);

  const add = runProcess("relay add", process.execPath, [
    path.join(__dirname, "..", "bin", "party-p2p.cjs"),
    "relay",
    "add",
    relayB.config.relayAddress,
    "--ipc-port",
    String(addressA.port)
  ]);
  await new Promise((resolve, reject) => {
    add.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`relay add exited ${code}`))));
  });
  await waitFor(async () => {
    const [healthA, healthB] = await Promise.all([
      getJson(`http://127.0.0.1:${addressA.port}/health`),
      getJson(`http://127.0.0.1:${addressB.port}/health`)
    ]);
    logStep(`relay health: A connections=${healthA.relayLoad.relayConnections}, B connections=${healthB.relayLoad.relayConnections}`);
    return healthA.relayLoad.relayConnections > 0 && healthB.relayLoad.relayConnections > 0;
  });

  browser = await chromium.launch({ headless: false, slowMo: 50 });
  const contextOne = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const contextTwo = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const browserPeerConfig = { host: peerServer.host, port: peerServer.port, path: peerServer.path, secure: peerServer.secure, verboseDebug };
  await contextOne.addInitScript((config) => {
    if (config.verboseDebug) window.PARTY_P2P_DEBUG = "1";
    window.PARTY_P2P_PEERJS_HOST = config.host;
    window.PARTY_P2P_PEERJS_PORT = String(config.port);
    window.PARTY_P2P_PEERJS_PATH = config.path;
    window.PARTY_P2P_PEERJS_SECURE = String(config.secure);
  }, browserPeerConfig);
  await contextTwo.addInitScript((config) => {
    if (config.verboseDebug) window.PARTY_P2P_DEBUG = "1";
    window.PARTY_P2P_PEERJS_HOST = config.host;
    window.PARTY_P2P_PEERJS_PORT = String(config.port);
    window.PARTY_P2P_PEERJS_PATH = config.path;
    window.PARTY_P2P_PEERJS_SECURE = String(config.secure);
  }, browserPeerConfig);
  const clientOne = await contextOne.newPage();
  let clientTwo = await contextTwo.newPage();
  clientOne.on("console", (message) => logStep(`client one console ${message.type()}: ${message.text()}`));
  clientTwo.on("console", (message) => logStep(`client two console ${message.type()}: ${message.text()}`));

  logStep("opening client two before host exists");
  await clientTwo.goto(inviteUrl(roomName, relayA.config.relayPeerId, relayB.config.relayAddress), { waitUntil: "domcontentloaded" });
  logStep("client two invite page loaded");
  await joinAs(clientTwo, "Browser Two");
  logStep("client two premature join submitted");

  logStep("registering fake host on relay A");
  const host = await connectJson(`ws://127.0.0.1:${addressA.port}`);
  t.after(() => host.socket.close());
  host.send({ type: "host.register", roomName, relayHints: [relayA.config.relayAddress, relayB.config.relayAddress] });
  assert.equal((await host.next("host.register.ok")).type, "host.register.ok");

  logStep("opening client one through relay A");
  await clientOne.goto(inviteUrl(roomName, relayA.config.relayPeerId, relayA.config.relayAddress), { waitUntil: "domcontentloaded" });
  logStep("client one invite page loaded");
  await joinAs(clientOne, "Browser One");
  logStep("client two remains open and should retry through relay B when host appears");

  await routeHostMessages(host, store, ["browser_1", "browser_2"]);
  logStep("waiting for both browsers to enter event UI");
  const stopWelcomePump = keepWelcomingClients(host, store);
  await waitForEventUi(clientOne, "client one");
  await waitForEventUi(clientTwo, "client two");
  stopWelcomePump();

  await sendComment(clientTwo, "browser two comment through relay B");
  await routeMutation(host, store, (mutation) => mutation.op === "comment.add" && mutation.payload.body === "browser two comment through relay B", "browser two comment");
  await waitForText(clientOne, "browser two comment through relay B", "client one receiving client two comment");

  await sendComment(clientOne, "browser one reply through relay A");
  await routeMutation(host, store, (mutation) => mutation.op === "comment.add" && mutation.payload.body === "browser one reply through relay A", "browser one reply");
  await waitForText(clientTwo, "browser one reply through relay A", "client two receiving client one reply");

  logStep("taking relay B down");
  relayB.crash();
  await delay(250);
  logStep("relay B close initiated");
  await sendComment(clientOne, "browser one immediate after relay B down");
  await routeMutation(host, store, (mutation) => mutation.op === "comment.add" && mutation.payload.body === "browser one immediate after relay B down", "browser one immediate after relay B down");
  await waitForText(clientTwo, "browser one immediate after relay B down", "client two receiving post-failover message");
}

if (process.env.PARTY_P2P_STANDALONE_PLAYWRIGHT_E2E === "1") {
  const cleanup = [];
  runPlaywrightCycle({
    after(callback) {
      cleanup.push(callback);
    }
  }).then(async () => {
    for (const callback of cleanup.reverse()) await callback();
    process.exit(0);
  }).catch(async (error) => {
    console.error(error);
    for (const callback of cleanup.reverse()) {
      Promise.resolve(callback()).catch(() => undefined);
    }
    process.exit(1);
  });
} else {
  test("headed browser clients route and heal through real PeerJS relays", { skip: process.env.PARTY_P2P_RUN_PLAYWRIGHT_E2E !== "1" }, runPlaywrightCycle);
}

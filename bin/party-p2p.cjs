#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");
const { applyPartyRcDefaults, readPartyRc, userDataDir, userPartyRcFile, writePartyRc } = require("../host/partyRc.cjs");
const { DEFAULT_RELAY_IPC_HOST, DEFAULT_RELAY_IPC_PORT } = require("../host/relayConfig.cjs");

function dataDir() {
  return process.env.PARTY_P2P_DATA_DIR || userDataDir();
}

function hasAppUrl(args) {
  return args.includes("--app-url") || args.includes("--host-url");
}

function defaultAppUrl() {
  return process.env.APP_URL || process.env.HOST_URL || "https://robertinglin.github.io/party-p2p/";
}

function usage() {
  console.log("Usage: npx party-p2p SESSION-ID [host options]");
  console.log("       npx party-p2p relay [relay options]");
  console.log("       npx party-p2p relay add peerjs:relay-id-relay [--ipc-port 42777]");
  console.log("       npx party-p2p configure set host https://example.com");
  console.log("Example: npx party-p2p rooftop-disco --app-url https://robertinglin.github.io/party-p2p/");
  console.log("Example: npx party-p2p relay --port 42777 --relay-peer peerjs:party-p2p-relay-other-relay");
  console.log(`Config: ${userPartyRcFile()}`);
  console.log(`Data: ${dataDir()}\\SESSION-ID.json`);
}

function parseRelayAddArgs(args) {
  const parsed = {
    ipcHost: process.env.PARTY_P2P_RELAY_IPC_HOST || DEFAULT_RELAY_IPC_HOST,
    ipcPort: Number(process.env.PARTY_P2P_RELAY_IPC_PORT || DEFAULT_RELAY_IPC_PORT),
    relayAddress: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--host" || token === "--ipc-host") {
      parsed.ipcHost = args[index + 1];
      index += 1;
      continue;
    }
    if (token === "--port" || token === "--ipc-port") {
      parsed.ipcPort = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (!token.startsWith("--") && !parsed.relayAddress) parsed.relayAddress = token;
  }

  return parsed;
}

function addRelay(args) {
  const parsed = parseRelayAddArgs(args);
  if (!parsed.relayAddress) {
    usage();
    process.exit(1);
  }

  console.log(`Connecting to relay IPC ws://${parsed.ipcHost}:${parsed.ipcPort}`);
  const socket = new WebSocket(`ws://${parsed.ipcHost}:${parsed.ipcPort}`);
  const requestId = `relay_add_${Date.now()}`;
  const timer = setTimeout(() => {
    console.error(`Timed out adding relay ${parsed.relayAddress}`);
    socket.close();
    process.exit(1);
  }, 10000);
  socket.on("open", () => {
    console.log(`Adding relay ${parsed.relayAddress}`);
    socket.send(JSON.stringify({
      type: "relay.add",
      requestId,
      relayAddress: parsed.relayAddress
    }));
  });
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    if (message.requestId !== requestId) return;
    if (message.type === "relay.add.ok") {
      clearTimeout(timer);
      console.log(`Added relay ${message.relayAddress}`);
      socket.close();
      return;
    }
    clearTimeout(timer);
    console.error(message.message || "Failed to add relay");
    socket.close();
    process.exitCode = 1;
  });
  socket.on("error", (error) => {
    clearTimeout(timer);
    console.error(`Failed to connect to relay IPC ws://${parsed.ipcHost}:${parsed.ipcPort}: ${error.message}`);
    process.exit(1);
  });
}

function configure(args) {
  const [command, key, value] = args;
  const file = userPartyRcFile();
  const current = readPartyRc(file);

  if (command === "set" && key === "host" && value) {
    writePartyRc({ ...current, host: value }, file);
    console.log(`Saved host ${value} to ${file}`);
    return;
  }

  if (command === "get" && key === "host") {
    console.log(current.host || "");
    return;
  }

  if (command === "list") {
    console.log(JSON.stringify(current, null, 2));
    return;
  }

  usage();
  process.exit(1);
}

function main() {
  applyPartyRcDefaults();
  const args = process.argv.slice(2);
  if (args[0] === "configure") {
    configure(args.slice(1));
    return;
  }
  if (args[0] === "relay") {
    if (args[1] === "add") {
      addRelay(args.slice(2));
      return;
    }
    const relayPath = path.join(__dirname, "..", "host", "relay.cjs");
    const child = spawn(process.execPath, [relayPath, ...args.slice(1)], {
      stdio: "inherit"
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    return;
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const sessionId = args.find((arg) => !arg.startsWith("--"));
  if (!sessionId) {
    usage();
    process.exit(1);
  }

  const sessionIndex = args.indexOf(sessionId);
  const hostArgs = args.slice(0, sessionIndex).concat(args.slice(sessionIndex + 1));
  if (!hasAppUrl(hostArgs)) hostArgs.push("--app-url", defaultAppUrl());
  const hostPath = path.join(__dirname, "..", "host", "host.cjs");
  const child = spawn(process.execPath, [hostPath, "--room", sessionId, "--data-dir", dataDir(), ...hostArgs], {
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();

#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");
const { applyPartyRcDefaults, readPartyRc, userDataDir, userPartyRcFile, writePartyRc } = require("../host/partyRc.cjs");

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
  console.log("       npx party-p2p configure set host https://example.com");
  console.log("Example: npx party-p2p rooftop-disco --app-url https://robertinglin.github.io/party-p2p/");
  console.log(`Config: ${userPartyRcFile()}`);
  console.log(`Data: ${dataDir()}\\SESSION-ID.json`);
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

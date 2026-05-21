#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");

function usage() {
  console.log("Usage: npm run start -- SESSION-ID [host options]");
  console.log("Example: npm run start -- rooftop-disco --app-url https://robertinglin.github.io/party-p2p/");
}

function main() {
  const args = process.argv.slice(2);
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
  const hostPath = path.join(__dirname, "..", "host", "host.cjs");
  const child = spawn(process.execPath, [hostPath, "--room", sessionId, ...hostArgs], {
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

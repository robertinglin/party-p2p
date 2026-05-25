#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");

const LOCAL_APP_URL = "http://localhost:42729/";

function usage() {
  console.log("Usage: npm run local -- SESSION-ID [host options]");
  console.log("Example: npm run local -- rooftop-disco");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function spawnInherited(command, args) {
  return spawn(command, args, {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    windowsHide: true
  });
}

function stop(child) {
  if (!child || child.killed) return;
  child.kill();
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
  if (!hostArgs.includes("--app-url") && !hostArgs.includes("--host-url")) {
    hostArgs.push("--app-url", LOCAL_APP_URL);
  }

  const vite = spawnInherited(npmCommand(), ["run", "dev"]);
  const host = spawnInherited(process.execPath, [
    path.join(__dirname, "..", "host", "host.cjs"),
    "--room",
    sessionId,
    ...hostArgs
  ]);

  function shutdown(code = 0) {
    stop(host);
    stop(vite);
    process.exit(code);
  }

  vite.on("exit", (code) => shutdown(code ?? 0));
  host.on("exit", (code) => shutdown(code ?? 0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

main();

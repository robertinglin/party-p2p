#!/usr/bin/env node

const { spawn } = require("node:child_process");

const IDLE_TIMEOUT_MS = Number(process.env.PARTY_P2P_PLAYWRIGHT_E2E_TIMEOUT_MS || 20000);

const child = spawn(process.execPath, ["tests/playwright-cycle.test.cjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PARTY_P2P_RUN_PLAYWRIGHT_E2E: "1",
    PARTY_P2P_STANDALONE_PLAYWRIGHT_E2E: "1"
  },
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: false
});

let idleTimer;

function isProgressLine(line) {
  if (!line.includes("[playwright-cycle]")) return false;
  if (line.includes("ignored transient PeerJS candidate race")) return false;
  return true;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error(`[playwright-cycle] no meaningful progress for ${IDLE_TIMEOUT_MS}ms; killing e2e process`);
    child.kill("SIGKILL");
    setTimeout(() => process.exit(124), 1000).unref();
  }, IDLE_TIMEOUT_MS);
}

function forwardOutput(stream, chunk) {
  const text = chunk.toString("utf8");
  stream.write(text);
  for (const line of text.split(/\r?\n/)) {
    if (isProgressLine(line)) resetIdleTimer();
  }
}

child.stdout.on("data", (chunk) => {
  forwardOutput(process.stdout, chunk);
});
child.stderr.on("data", (chunk) => {
  forwardOutput(process.stderr, chunk);
});
resetIdleTimer();

child.on("exit", (code, signal) => {
  if (idleTimer) clearTimeout(idleTimer);
  if (signal) {
    console.error(`[playwright-cycle] e2e process exited from signal ${signal}`);
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  if (idleTimer) clearTimeout(idleTimer);
  console.error(error);
  process.exit(1);
});

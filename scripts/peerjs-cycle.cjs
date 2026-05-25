#!/usr/bin/env node

const { spawn } = require("node:child_process");

const child = spawn(process.execPath, ["--test", "--test-force-exit", "tests/peerjs-cycle.test.cjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PARTY_P2P_RUN_PEERJS_E2E: "1"
  },
  stdio: "inherit",
  windowsHide: true
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[peerjs-cycle] e2e process exited from signal ${signal}`);
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

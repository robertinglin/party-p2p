const { spawn } = require("node:child_process");
const path = require("node:path");
const { ensureRelayConfig } = require("./relayConfig.cjs");

const DEFAULT_RELAY_START_TIMEOUT_MS = 6000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relayIpcUrl(config) {
  return `ws://${config.ipcHost}:${config.ipcPort}`;
}

function relayHealthUrl(config) {
  return `http://${config.ipcHost}:${config.ipcPort}/health`;
}

async function fetchRelayInfo(config) {
  const response = await fetch(relayHealthUrl(config));
  if (!response.ok) throw new Error(`Relay health returned ${response.status}`);
  const info = await response.json();
  if (info.protocol !== "party-p2p-peer-relay") throw new Error("Local process is not a party-p2p relay");
  return info;
}

async function waitForRelay(config, timeoutMs = DEFAULT_RELAY_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await fetchRelayInfo(config);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw lastError || new Error("Timed out waiting for local relay");
}

function spawnRelayProcess(config, options = {}) {
  const relayPath = path.join(__dirname, "relay.cjs");
  const args = [
    relayPath,
    "--ipc-host",
    config.ipcHost,
    "--ipc-port",
    String(config.ipcPort),
    "--relay-peer-id",
    config.relayPeerId
  ];

  for (const relayPeer of options.relayPeers || []) {
    args.push("--relay-peer", relayPeer);
  }
  if (options.iceServers) {
    args.push("--ice", options.iceServers);
  }

  const env = { ...process.env };
  if (options.dataDir) env.PARTY_P2P_HOME = options.dataDir;

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env
  });
  child.unref();
  return child;
}

async function ensureLocalRelay(options = {}) {
  const config = ensureRelayConfig({
    ...options,
    ipcHost: options.ipcHost || process.env.PARTY_P2P_RELAY_IPC_HOST,
    ipcPort: options.ipcPort ?? (process.env.PARTY_P2P_RELAY_IPC_PORT ? Number(process.env.PARTY_P2P_RELAY_IPC_PORT) : undefined)
  });
  try {
    const info = await fetchRelayInfo(config);
    return { config, info, spawned: false };
  } catch {
    spawnRelayProcess(config, options);
    const info = await waitForRelay(config, options.timeoutMs);
    return { config, info, spawned: true };
  }
}

module.exports = {
  ensureLocalRelay,
  fetchRelayInfo,
  relayHealthUrl,
  relayIpcUrl,
  spawnRelayProcess,
  waitForRelay
};

const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("./partyRc.cjs");
const { randomRelayPeerId, relayMeshAddressFromAddress, relayMeshAddressForPeerId, relayMeshPeerIdForRoomPeerId } = require("./p2pNostrRelay.cjs");

const DEFAULT_RELAY_IPC_HOST = "127.0.0.1";
const DEFAULT_RELAY_IPC_PORT = 42777;

function relayConfigFile(dataDir = userDataDir()) {
  return path.join(dataDir, "relay.json");
}

function readRelayConfig(file = relayConfigFile()) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeRelayConfig(config, file = relayConfigFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function ensureRelayConfig(options = {}) {
  const file = options.file || relayConfigFile(options.dataDir);
  const current = readRelayConfig(file);
  const relayPeerId = options.relayPeerId || current.relayPeerId || randomRelayPeerId("relay");
  const relayMeshPeerId = relayMeshPeerIdForRoomPeerId(relayPeerId);
  const currentRelayAddress = relayMeshAddressFromAddress(current.relayAddress);
  const config = {
    relayPeerId,
    relayMeshPeerId,
    relayAddress: options.relayPeerId ? relayMeshAddressForPeerId(relayPeerId) : currentRelayAddress || relayMeshAddressForPeerId(relayPeerId),
    ipcHost: options.ipcHost || current.ipcHost || DEFAULT_RELAY_IPC_HOST,
    ipcPort: Number(options.ipcPort ?? current.ipcPort ?? DEFAULT_RELAY_IPC_PORT),
    createdAt: current.createdAt || Date.now()
  };
  writeRelayConfig(config, file);
  return config;
}

module.exports = {
  DEFAULT_RELAY_IPC_HOST,
  DEFAULT_RELAY_IPC_PORT,
  ensureRelayConfig,
  readRelayConfig,
  relayConfigFile,
  writeRelayConfig
};

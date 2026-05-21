const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function userDataDir() {
  return process.env.PARTY_P2P_HOME || path.join(os.homedir(), ".party-p2p");
}

function userPartyRcFile() {
  return path.join(userDataDir(), ".partyrc");
}

function parseKeyValueText(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

function normalizePartyRc(values) {
  const host = values.host || values.HOST_URL || values.appUrl || values.app_url;
  return host ? { host: String(host).trim() } : {};
}

function parsePartyRc(text) {
  try {
    return normalizePartyRc(JSON.parse(text));
  } catch {
    return normalizePartyRc(parseKeyValueText(text));
  }
}

function readPartyRc(file = userPartyRcFile()) {
  if (!fs.existsSync(file)) return {};
  return parsePartyRc(fs.readFileSync(file, "utf8"));
}

function writePartyRc(values, file = userPartyRcFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`);
}

function applyPartyRcDefaults(target = process.env, file = userPartyRcFile()) {
  const values = readPartyRc(file);
  if (values.host && target.APP_URL === undefined && target.HOST_URL === undefined) {
    target.HOST_URL = values.host;
  }
}

module.exports = {
  applyPartyRcDefaults,
  readPartyRc,
  userDataDir,
  userPartyRcFile,
  writePartyRc
};

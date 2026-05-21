const fs = require("node:fs");

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = parseEnvValue(match[2]);
  }
  return values;
}

function applyEnvDefaults(values, target = process.env) {
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined) target[key] = value;
  }
}

function loadEnvDefaults(file, target = process.env) {
  if (!fs.existsSync(file)) return;
  applyEnvDefaults(parseEnvText(fs.readFileSync(file, "utf8")), target);
}

module.exports = { loadEnvDefaults, parseEnvText };

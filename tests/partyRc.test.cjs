const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  applyPartyRcDefaults,
  readPartyRc,
  writePartyRc
} = require("../host/partyRc.cjs");

const tmpRoot = path.join(__dirname, `.tmp-partyrc-${process.pid}`);

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function tmpFile(name) {
  fs.mkdirSync(tmpRoot, { recursive: true });
  return path.join(tmpRoot, name);
}

test("reads json host config", () => {
  const file = tmpFile("json.partyrc");
  fs.writeFileSync(file, JSON.stringify({ host: "https://example.com" }));

  assert.deepEqual(readPartyRc(file), { host: "https://example.com" });
});

test("reads key-value host aliases", () => {
  const file = tmpFile("key-value.partyrc");
  fs.writeFileSync(file, "HOST_URL=https://example.net\n");

  assert.deepEqual(readPartyRc(file), { host: "https://example.net" });
});

test("writes partyrc json and creates parent directory", () => {
  const file = path.join(tmpRoot, "nested", ".partyrc");

  writePartyRc({ host: "https://pages.example.org" }, file);

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    host: "https://pages.example.org"
  });
});

test("applies host default without overriding explicit env", () => {
  const file = tmpFile("defaults.partyrc");
  fs.writeFileSync(file, JSON.stringify({ host: "https://configured.example" }));

  const emptyEnv = {};
  applyPartyRcDefaults(emptyEnv, file);
  assert.equal(emptyEnv.HOST_URL, "https://configured.example");

  const explicitEnv = { APP_URL: "https://explicit.example" };
  applyPartyRcDefaults(explicitEnv, file);
  assert.deepEqual(explicitEnv, { APP_URL: "https://explicit.example" });
});

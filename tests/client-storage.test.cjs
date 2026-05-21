const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadModule(file) {
  require.extensions[".ts"] ||= (mod, filename) => {
    const tsSource = fs.readFileSync(filename, "utf8");
    mod._compile(ts.transpileModule(tsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  };

  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText;
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request.startsWith("./")) return require(path.join(path.dirname(file), request));
    return require(request);
  };
  const fn = new Function("exports", "module", "require", output);
  fn(module.exports, module, localRequire);
  return module.exports;
}

const { saveAcceptedInvite, saveOpenedInvite } = loadModule(path.join(__dirname, "..", "client", "src", "lib", "storage.ts"));

test("saves opened invites before join without marking them accepted", (t) => {
  const originalNow = Date.now;
  t.after(() => {
    Date.now = originalNow;
  });

  const config = {
    roomName: "opened-before-join",
    roomPeerId: "party-p2p-opened-before-join",
    roomSecret: "secret-before-join"
  };

  Date.now = () => 1000;
  let invites = saveOpenedInvite(config);
  let invite = invites.find((item) => item.config.roomName === config.roomName);
  assert.equal(invite?.openedAt, 1000);
  assert.equal(invite?.lastOpenedAt, 1000);
  assert.equal(invite?.acceptedAt, undefined);
  assert.equal(invite?.lastJoinedAt, undefined);

  Date.now = () => 2000;
  invites = saveAcceptedInvite(config, { id: "guest_1", name: "Guest One", avatar: "✨" });
  invite = invites.find((item) => item.config.roomName === config.roomName);
  assert.equal(invite?.openedAt, 1000);
  assert.equal(invite?.lastOpenedAt, 2000);
  assert.equal(invite?.acceptedAt, 2000);
  assert.equal(invite?.lastJoinedAt, 2000);

  Date.now = () => 3000;
  invites = saveOpenedInvite(config);
  invite = invites.find((item) => item.config.roomName === config.roomName);
  assert.equal(invite?.openedAt, 1000);
  assert.equal(invite?.lastOpenedAt, 3000);
  assert.equal(invite?.acceptedAt, 2000);
  assert.equal(invite?.lastJoinedAt, 2000);
  assert.deepEqual(invite?.profile, { id: "guest_1", name: "Guest One", avatar: "✨" });
});

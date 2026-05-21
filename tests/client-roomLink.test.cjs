const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadModule(file) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText;
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request === "./id") return require("../client/src/lib/id.ts");
    return require(request);
  };
  require.extensions[".ts"] ||= (mod, filename) => {
    const tsSource = fs.readFileSync(filename, "utf8");
    mod._compile(ts.transpileModule(tsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
  };
  const fn = new Function("exports", "module", "require", output);
  fn(module.exports, module, localRequire);
  return module.exports;
}

const { parseRoomConfigFromHash, parseRoomConfigFromUrl } = loadModule(path.join(__dirname, "..", "client", "src", "lib", "roomLink.ts"));

test("parses room config from hash", () => {
  assert.deepEqual(
    parseRoomConfigFromHash("#/room/rooftop-disco?roomPeerId=party-p2p-rooftop-disco&secret=abc123"),
    {
      roomName: "rooftop-disco",
      roomPeerId: "party-p2p-rooftop-disco",
      roomSecret: "abc123"
    }
  );
});

test("parses room config from absolute invite URL", () => {
  assert.deepEqual(
    parseRoomConfigFromUrl("https://example.com/#/room/backyard?roomPeerId=party-p2p-backyard&secret=secret-value"),
    {
      roomName: "backyard",
      roomPeerId: "party-p2p-backyard",
      roomSecret: "secret-value"
    }
  );
});

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
  const fn = new Function("exports", "module", output);
  fn(module.exports, module);
  return module.exports;
}

const { partyTimingLabel } = loadModule(path.join(__dirname, "..", "client", "src", "lib", "eventTime.ts"));

test("labels parties that started minutes ago", () => {
  assert.equal(
    partyTimingLabel({ date: "2026-05-21", time: "8:00 PM" }, new Date("2026-05-21T20:35:00")),
    "Started 35 minutes ago"
  );
});

test("labels yesterday clearly", () => {
  assert.equal(
    partyTimingLabel({ date: "2026-05-20", time: "8:00 PM" }, new Date("2026-05-21T10:00:00")),
    "Happened yesterday"
  );
});

test("labels upcoming same-day parties", () => {
  assert.equal(
    partyTimingLabel({ date: "2026-05-21", time: "8:00 PM" }, new Date("2026-05-21T18:00:00")),
    "Starts in 2 hours"
  );
});

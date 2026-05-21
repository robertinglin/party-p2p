const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "client", "public", "manifest.webmanifest"), "utf8"));

test("keeps PWA URLs portable and in scope", () => {
  assert.equal(manifest.id, ".");
  assert.equal(manifest.start_url, ".");
  assert.equal(manifest.scope, ".");
  assert.equal(manifest.display, "standalone");
});

test("asks Chromium to navigate existing PWA window for invite links", () => {
  assert.deepEqual(manifest.launch_handler, {
    client_mode: ["navigate-existing", "auto"]
  });
});

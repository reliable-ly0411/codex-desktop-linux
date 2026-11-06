"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Execute the exact signed-bundle gate rather than a parallel implementation.
const workflow = fs.readFileSync(
  path.join(__dirname, "../../.github/workflows/upstream-build-app.yml"), "utf8",
);
const marker = '          node - "$extracted_asar/webview/assets" <<\'NODE\'\n';
const start = workflow.indexOf(marker);
assert.notEqual(start, -1, "signed renderer gate is missing");
const end = workflow.indexOf("          NODE\n", start + marker.length);
assert.notEqual(end, -1, "signed renderer gate terminator is missing");
const gate = workflow.slice(start + marker.length, end).replace(/^ {10}/gm, "");

function runGate(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-dependencies-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const result = spawnSync(process.execPath, ["-", root], {
      input: gate, encoding: "utf8", timeout: 5_000,
    });
    assert.ifError(result.error);
    return result;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("signed renderer gate accepts acyclic rspack entries and async chunks", () => {
  const result = runGate({
    "100.entry.js": 'import { x } from "./async/200.hash.js"; export { x };',
    "async/200.hash.js": 'export { x } from "../300.hash.js";',
    "300.hash.js": "export const x = 1;",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /acyclic: 3 chunks, 2 imports/);
});

for (const [name, files, message] of [
  ["reverse dependency", {
    "100.entry.js": 'import "./async/200.hash.js";',
    "async/200.hash.js": 'import "../100.entry.js";',
  }, /static import cycle/],
  ["multi-chunk cycle", {
    "100.entry.js": 'import "./async/200.hash.js";',
    "async/200.hash.js": 'export { x } from "./300.hash.js";',
    "async/300.hash.js": 'export { x } from "../100.entry.js";',
  }, /static import cycle/],
  ["missing imported chunk", {
    "100.entry.js": 'import "./async/missing.js";',
    "async/200.hash.js": "export const x = 1;",
  }, /statically imports missing/],
  ["retired layout", {
    "authed-route-old.js": 'import "./app-primary-old.js";',
    "app-primary-old.js": "export const x = 1;",
  }, /expected rspack async webview chunks/],
  ["stale import scan", {
    "100.entry.js": "export const x = 1;",
    "async/200.hash.js": "export const y = 2;",
  }, /the import scan is stale/],
]) {
  test(`signed renderer gate rejects ${name}`, () => {
    const result = runGate(files);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, message);
  });
}

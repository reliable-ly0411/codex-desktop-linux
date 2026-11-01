"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { identity, requireSamePackage } = require("./community-build.js");
const source = "a".repeat(40);
const metadata = { package: "chatgpt", architecture: "amd64", version: "26.930.1",
  repository: "https://persistent.oaistatic.com/codex-app-prod/linux/deb",
  repositoryPath: "pool/chatgpt.deb", sha256: "b".repeat(64), size: 100 };
test("build identity changes with source, official package, architecture or feature configuration", () => {
  const key = identity(source, metadata, "{}");
  assert.equal(identity(source, { ...metadata, path: "/another/runner/path" }, "{}"), key);
  for (const candidate of [
    identity("c".repeat(40), metadata, "{}"),
    identity(source, { ...metadata, sha256: "c".repeat(64) }, "{}"),
    identity(source, { ...metadata, architecture: "arm64" }, "{}"),
    identity(source, metadata, '{"enabled":["appshots"]}'),
  ]) assert.notEqual(candidate, key);
  assert.throws(() => identity("main", metadata, "{}"));
  assert.throws(() => identity(source, { ...metadata, repository: "https://example.invalid" }, "{}"));
});
test("signed package changes between planning and download stop the build", () => {
  requireSamePackage(metadata, { ...metadata, path: "/download" });
  for (const key of ["repository", "package", "architecture", "version", "repositoryPath", "sha256", "size"]) {
    assert.throws(() => requireSamePackage(metadata, { ...metadata, [key]: "changed" }), /changed during build/);
  }
});

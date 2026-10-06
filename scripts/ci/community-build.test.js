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

for (const mode of ["unchanged", "changed", "conflict", "skip"]) {
  test(`sync orchestration: ${mode}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "community-sync-test-"));
    try {
      fs.writeFileSync(path.join(root, "gh"), `#!/bin/bash
set -eu
case "$*" in
  *merge-upstream*)
    [[ "$TEST_MODE" != skip ]]
    [[ "$TEST_MODE" != conflict ]] || { echo 'HTTP 409 conflict' >&2; exit 1; }
    touch "$TEST_ROOT/merged" ;;
  *git/ref/heads/main*)
    if [[ "$TEST_MODE" == changed && -f "$TEST_ROOT/merged" ]]; then echo ${"b".repeat(40)}; else echo ${source}; fi ;;
  *) echo ilysenko/codex-desktop-linux ;;
esac
`, { mode: 0o755 });
      const output = path.join(root, "output");
      const result = spawnSync("bash", [path.join(__dirname, "sync-community-fork.sh")], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_MODE: mode, TEST_ROOT: root,
          GH_REPO: "reliable-ly0411/codex-desktop-linux", SYNC_UPSTREAM: mode === "skip" ? "false" : "true",
          GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(root, "summary") }, encoding: "utf8",
      });
      if (mode === "conflict") {
        assert.notEqual(result.status, 0);
        assert.equal(fs.existsSync(output), false, "must not release a build SHA after conflict");
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.readFileSync(output, "utf8"), `source_sha=${mode === "changed" ? "b".repeat(40) : source}\n`);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

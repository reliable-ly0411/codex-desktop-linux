"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { chooseRelease, publish } = require("./community-build-release.js");
const key = "a".repeat(64);
const source = "b".repeat(40);
const marker = `<!-- community-build-key:${key} -->`;
const deb = "codex-desktop_2026.10.06.123456_amd64.deb";
const files = [deb, "SHA256SUMS", "build-info.json", "README.txt"];
const release = { draft: false, prerelease: false, body: marker, assets: files.map((name) =>
  ({ name, state: "uploaded", size: 1, digest: `sha256:${key}` })) };

test("published releases suppress unchanged builds even after Actions artifacts expire", () => {
  assert.equal(chooseRelease([release], key, "amd64", false), release);
  assert.equal(chooseRelease([release], key, "amd64", true), null);
  assert.equal(chooseRelease([release], "c".repeat(64), "amd64", false), null);
  assert.equal(chooseRelease([release], key, "arm64", false), null);
});
test("draft, incomplete and invalid releases never suppress a build", () => {
  for (const r of [{ ...release, draft: true }, { ...release, prerelease: true },
    { ...release, assets: release.assets.slice(1) }, { ...release, body: "unrelated" },
    ...["state", "size", "digest"].map((field) => ({ ...release,
      assets: release.assets.map((a, i) => i ? a : { ...a, [field]: field === "size" ? 0 : "wrong" }) }))]) {
    assert.equal(chooseRelease([r], key, "amd64", false), null);
  }
});

function fixture(mode, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "community-release-test-"));
  try {
    const plan = { key, source, metadata: { architecture: "amd64", version: "26.930.1", sha256: "d".repeat(64) } };
    const dir = path.join(root, "assets"); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, deb), "test package");
    fs.writeFileSync(path.join(dir, "README.txt"), "instructions");
    fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ key, source, deb, workflowRun: "123" }));
    const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    fs.writeFileSync(path.join(dir, "SHA256SUMS"), [deb, "README.txt", "build-info.json"].map((n) =>
      `${hash(path.join(dir, n))}  ${n}\n`).join(""));
    const assets = files.map((name) => ({ name, state: "uploaded", size: fs.statSync(path.join(dir, name)).size,
      digest: `sha256:${hash(path.join(dir, name))}` }));
    let state = null;
    const calls = [];
    const tag = "v2026.10.06.123456-amd64";
    if (mode === "resume") state = { id: 42, tag_name: tag, body: marker, target_commitish: source, draft: true, assets: [] };
    const io = {
      gh(args) {
        calls.push(args);
        if (args[0] === "api") return JSON.stringify([state ? [state] : []]);
        if (args[1] === "create") {
          assert.ok(args.includes("--draft"));
          assert.equal(args[args.indexOf("--target") + 1], source);
          state = { id: 42, tag_name: tag, body: fs.readFileSync(args[args.indexOf("--notes-file") + 1], "utf8"),
            target_commitish: source, draft: true, prerelease: false, assets: [], html_url: "https://github.com/release" };
        } else if (args[1] === "upload") {
          assert.equal(state.draft, true, "upload must happen before publication");
          if (mode === "upload-error") throw Error("network interrupted");
          state.assets = structuredClone(assets);
          if (mode === "bad-digest") state.assets[0].digest = `sha256:${"0".repeat(64)}`;
        } else if (args[1] === "edit") {
          assert.equal(state.assets.length, 4);
          assert.ok(args.includes("--draft=false"));
          state.draft = false;
        } else throw Error(`Unexpected command ${args}`);
        return "";
      },
      api() { calls.push(["read-assets"]); return structuredClone(state); },
    };
    run({ plan, env: { GITHUB_REPOSITORY: "reliable-ly0411/codex-desktop-linux", GITHUB_RUN_ID: "123",
      BUILD_STATE_DIR: root, COMMUNITY_ARTIFACT_DIR: dir }, io, calls, getState: () => state });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
for (const mode of ["new", "resume"]) test(`publish ${mode}: draft, upload, verify, then make public`, () => {
  fixture(mode, ({ plan, env, io, calls, getState }) => {
    publish(plan, env, io);
    assert.equal(getState().draft, false);
    const upload = calls.findIndex((c) => c[1] === "upload");
    const check = calls.findIndex((c) => c[0] === "read-assets");
    const edit = calls.findIndex((c) => c[1] === "edit");
    assert.ok(upload < check && check < edit);
    const before = calls.length;
    publish(plan, env, io);
    assert.equal(calls.length, before + 1, "retry of published release does not overwrite assets");
  });
});
for (const mode of ["upload-error", "bad-digest"]) test(`publish ${mode}: leaves only a draft`, () => {
  fixture(mode, ({ plan, env, io, calls, getState }) => {
    assert.throws(() => publish(plan, env, io));
    assert.equal(getState().draft, true);
    assert.equal(calls.some((c) => c[1] === "edit"), false);
  });
});
test("wrong repository and mismatched provenance cannot publish", () => {
  fixture("new", ({ plan, env, io, calls }) => {
    assert.throws(() => publish(plan, { ...env, GITHUB_REPOSITORY: "other/repo" }, io));
    assert.throws(() => publish({ ...plan, source: "c".repeat(40) }, env, io));
    assert.equal(calls.length, 0);
  });
});

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

// Exercise the real plan CLI with fixture-only metadata and GitHub reads. A
// payload download or any unrecognized command is an error, not a network call.
function planFixture(change, check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "community-plan-test-"));
  try {
    const fixture = {
      source,
      metadata: { ...metadata, signatureFingerprint: "A".repeat(40),
        inReleaseSha256: "c".repeat(64), packagesSha256: "d".repeat(64) },
      policy: { redistributionApprovals: [], baselinePackages: [] },
      releases: [],
    };
    fixture.policy.baselinePackages.push({ ...fixture.metadata, version: "26.929.1" });
    change(fixture);
    const state = path.join(root, "state");
    fs.mkdirSync(state);
    // A pause must also invalidate a stale local plan, never leave it usable.
    fs.writeFileSync(path.join(state, "plan.json"), '{"stale":true}');
    fs.mkdirSync(path.join(root, "scripts/ci"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts/ci/community-release-policy.json"),
      fixture.policyText ?? JSON.stringify(fixture.policy));
    fs.writeFileSync(path.join(root, "features.json"), "{}");
    fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(fixture));
    const output = path.join(root, "output"), summary = path.join(root, "summary");
    fs.writeFileSync(output, ""); fs.writeFileSync(summary, "");
    const calls = path.join(root, "calls");
    const preload = path.join(root, "preload.cjs");
    fs.writeFileSync(preload, `
      const fs = require("node:fs"), assert = require("node:assert/strict");
      const fixture = require(${JSON.stringify(path.join(root, "fixture.json"))});
      const log = call => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(call) + "\\n");
      require(${JSON.stringify(require.resolve("../lib/upstream-linux-package.js"))}).resolveOfficialPackage = async options => {
        log({ command: "metadata", metadataOnly: options.metadataOnly });
        assert.equal(options.metadataOnly, true, "fixture forbids payload download");
        if (fixture.metadataError) throw Error(fixture.metadataError);
        return fixture.metadata;
      };
      require("node:child_process").execFileSync = (command, args) => {
        log({ command, args });
        if (command === "git" && JSON.stringify(args) === '["rev-parse","HEAD"]') return fixture.source;
        if (command === "gh" && args[0] === "api" && args.includes("--paginate")) {
          if (fixture.apiError) throw Error(fixture.apiError);
          return JSON.stringify([fixture.releases]);
        }
        throw Error("Fixture forbids command: " + command + " " + args.join(" "));
      };
    `);
    const result = spawnSync(process.execPath,
      ["--require", preload, path.join(__dirname, "community-build.js"), "plan"], {
        cwd: root, encoding: "utf8", env: { ...process.env, SOURCE_SHA: source,
          BUILD_ARCH: "amd64", BUILD_STATE_DIR: state, GITHUB_REPOSITORY: "reliable-ly0411/codex-desktop-linux",
          CODEX_LINUX_FEATURES_CONFIG: path.join(root, "features.json"),
          GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      });
    assert.ifError(result.error);
    check({ result, fixture, state, output: fs.readFileSync(output, "utf8"),
      summary: fs.readFileSync(summary, "utf8"),
      calls: fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("missing exact-payload permission pauses successfully without a build plan or payload download", () => {
  planFixture(() => {}, ({ result, fixture, state, output, summary, calls }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(output, "build=false\nrelease_status=paused_license\n");
    assert.match(summary, /同步成功、发布因许可证据不足而暂停/);
    for (const value of [source, fixture.metadata.version, fixture.metadata.sha256, "amd64"]) {
      assert.ok(summary.includes(value));
    }
    assert.match(summary, /No package payload was downloaded, built, uploaded or published/);
    assert.equal(fs.existsSync(path.join(state, "plan.json")), false);
    assert.deepEqual(calls.map(call => call.command), ["git", "metadata", "gh"]);
    assert.equal(calls[1].metadataOnly, true);
  });
});

test("matching permission still permits a plan, without downloading or publishing in planning", () => {
  planFixture(f => f.policy.redistributionApprovals.push({ version: f.metadata.version,
    architecture: f.metadata.architecture, packageSha256: f.metadata.sha256,
    permission: "redistribute-repackaged-payload", reviewedBy: "fixture-only",
    evidenceUrl: "https://example.invalid/fixture-only" }), ({ result, state, output, summary, calls }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(output, /^build=true\nartifact_name=community-deb-amd64-/);
    assert.doesNotMatch(output + summary, /paused_license|发布因许可证据不足/);
    const plan = JSON.parse(fs.readFileSync(path.join(state, "plan.json"), "utf8"));
    assert.equal(plan.licenseEvidence.reviewedBy, "fixture-only");
    assert.equal(calls[1].metadataOnly, true);
  });
});

for (const [name, change, expected] of [
  ["signature failure", f => { f.metadataError = "Invalid signature fixture"; }, /Invalid signature fixture/],
  ["invalid signed identity", f => { f.metadata.sha256 = "invalid"; }, /Invalid signed official package identity/],
  ["GitHub API failure", f => { f.apiError = "GitHub unavailable fixture"; }, /GitHub unavailable fixture/],
  ["malformed policy JSON", f => { f.policyText = "{"; }, /SyntaxError/],
  ["missing approvals list", f => { delete f.policy.redistributionApprovals; }, /Invalid redistribution approvals policy/],
  ["malformed approvals list", f => { f.policy.redistributionApprovals = {}; }, /Invalid redistribution approvals policy/],
  ...[null, 42, "unexpected", []].map(entry => [`malformed approval entry ${JSON.stringify(entry)}`,
    f => { f.policy.redistributionApprovals = [entry]; }, /Invalid redistribution approvals policy/]),
  ["invalid baseline", f => { f.policy.baselinePackages = []; }, /baseline missing/],
  ["downgrade", f => { f.policy.baselinePackages[0].version = "99.0"; }, /downgrade rejected/],
  ["same-version changed bytes", f => { f.policy.baselinePackages[0].version = f.metadata.version; f.policy.baselinePackages[0].sha256 = "e".repeat(64); }, /SHA drift rejected/],
  ["malformed release history", f => { f.releases = [{ tag_name: "official-broken" }]; }, /Published provenance asset missing/],
  ["pending draft", f => { const { officialIdentity, historyMarker } = require("./community-official-trigger.js"); f.releases = [{ tag_name: `official-${officialIdentity(f.metadata)}`, draft: true, body: historyMarker(f.metadata) }]; }, /recover original candidate artifacts/],
]) test(`plan still fails on ${name}, rather than misreporting a license pause`, () => {
  planFixture(change, ({ result, output, summary }) => {
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(output + summary, /paused_license|同步成功、发布因许可证据不足而暂停|build=true/);
  });
});

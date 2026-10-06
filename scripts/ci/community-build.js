#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { resolveOfficialPackage, verifyIndexedFile } = require("../lib/upstream-linux-package.js");
const REPOSITORY = "https://persistent.oaistatic.com/codex-app-prod/linux/deb";
const digest = (input) => crypto.createHash("sha256").update(input).digest("hex");

function identity(source, metadata, features) {
  if (!/^[0-9a-f]{40}$/.test(source)) throw new Error("Invalid source commit");
  if (!["amd64", "arm64"].includes(metadata.architecture)
      || !/^[0-9a-f]{64}$/.test(metadata.sha256)
      || metadata.package !== "chatgpt" || metadata.repository !== REPOSITORY) {
    throw new Error("Invalid official package identity");
  }
  return digest(JSON.stringify({ schema: 1, source, architecture: metadata.architecture,
    upstreamSha256: metadata.sha256, version: metadata.version,
    featuresSha256: digest(features), withUpdater: true }));
}

function reusableArtifact(artifacts, name, now = Date.now()) {
  return artifacts.filter((a) => a.name === name && !a.expired && a.size_in_bytes > 0
    && Date.parse(a.expires_at) > now && Number.isSafeInteger(a.workflow_run?.id))
    .sort((a, b) => b.id - a.id);
}

function chooseArtifact(artifacts, name, force, getRun, now = Date.now()) {
  if (force) return null;
  for (const candidate of reusableArtifact(artifacts, name, now)) {
    const run = getRun(candidate.workflow_run.id);
    if (run.status === "completed" && run.conclusion === "success"
        && run.path === ".github/workflows/sync-upstream.yml") return candidate;
  }
  return null;
}

function requireSamePackage(expected, actual) {
  for (const key of ["repository", "package", "architecture", "version", "repositoryPath", "sha256", "size"]) {
    if (expected[key] !== actual[key]) throw new Error(`Signed package changed during build: ${key}`);
  }
}

const api = (endpoint, paginate = false) => JSON.parse(execFileSync("gh",
  ["api", ...(paginate ? ["--paginate", "--slurp"] : []), endpoint],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const summary = (text) => fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);

async function main() {
  const command = process.argv[2];
  const dir = path.resolve(process.env.BUILD_STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const planFile = path.join(dir, "plan.json");
  if (command === "plan") {
    const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (source !== process.env.SOURCE_SHA) throw new Error("Checkout differs from synchronized source");
    const arch = process.env.BUILD_ARCH;
    if (!["amd64", "arm64"].includes(arch)) throw new Error("Unsupported architecture");
    const metadata = await resolveOfficialPackage({ architecture: arch, repository: REPOSITORY,
      outputDir: path.join(dir, "metadata"), metadataPath: path.join(dir, "metadata.json"),
      keyBase64Path: "assets/openai-codex-linux-repository-key.gpg.base64", metadataOnly: true });
    const features = fs.readFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG);
    const key = identity(source, metadata, features);
    const artifactName = `community-deb-${arch}-${key}`;
    const repo = process.env.GITHUB_REPOSITORY;
    const force = process.env.FORCE_REBUILD === "true";
    const pages = force ? [] : api(`repos/${repo}/actions/artifacts?per_page=100&name=${artifactName}`, true);
    const previous = chooseArtifact(pages.flatMap((p) => p.artifacts), artifactName, force,
      (id) => api(`repos/${repo}/actions/runs/${id}`));
    writeJson(planFile, { source, metadata, key, artifactName, featuresSha256: digest(features) });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `build=${!previous}\nartifact_name=${artifactName}\n`);
    summary(`### ${arch}: ${previous ? "Unchanged; reuse package / 无变化，复用安装包" : "Build / 构建"}\n\nOfficial version: \`${metadata.version}\`\n\nSource: \`${source}\`\n\nOfficial SHA-256: \`${metadata.sha256}\``);
    if (previous) summary(`\n[Existing download / 已有下载](https://github.com/${repo}/actions/runs/${previous.workflow_run.id}/artifacts/${previous.id})`);
    return;
  }
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  if (command === "download") {
    const metadata = await resolveOfficialPackage({ architecture: plan.metadata.architecture,
      repository: REPOSITORY, outputDir: path.join(dir, "download"),
      metadataPath: path.join(dir, "download.json"),
      keyBase64Path: "assets/openai-codex-linux-repository-key.gpg.base64" });
    requireSamePackage(plan.metadata, metadata);
    verifyIndexedFile(metadata.path, plan.metadata, "Official package");
    process.stdout.write(`${metadata.path}\n`);
    return;
  }
  if (command === "record") {
    const output = path.resolve("community-artifacts");
    const debs = fs.readdirSync(output).filter((f) => f.endsWith(".deb"));
    if (debs.length !== 1) throw new Error("Expected one verified deb");
    const provenance = { ...plan, workflowRun: process.env.GITHUB_RUN_ID,
      upstream: plan.metadata, withUpdater: true, cleanupCommand: "codex-update-manager clean-cache --dry-run",
      createdAt: new Date().toISOString(), deb: debs[0] };
    writeJson(path.join(output, "build-info.json"), provenance);
    fs.writeFileSync(path.join(output, "README.txt"),
      "ChatGPT Community for Linux\n\nContains the automatic cache-cleanup updater and one recorded rollback backup policy.\nOptional Linux features are disabled in this baseline build.\n\nVerify: sha256sum -c SHA256SUMS\nInstall manually on a compatible Debian/Ubuntu system: sudo apt install ./codex-desktop_*.deb\nThis workflow does not install or restart your local app.\nSource and signed official package hashes: build-info.json\n");
    const names = fs.readdirSync(output).filter((f) => f !== "SHA256SUMS").sort();
    fs.writeFileSync(path.join(output, "SHA256SUMS"), names.map((f) =>
      `${digest(fs.readFileSync(path.join(output, f)))}  ${f}\n`).join(""));
    summary(`\nVerified deb: \`${debs[0]}\`\n\nIncludes updater, service and clean-cache command. Optional features are disabled. Artifacts expire after 14 days.`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { identity, reusableArtifact, chooseArtifact, requireSamePackage };

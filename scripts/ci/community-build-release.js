"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const REPO = "reliable-ly0411/codex-desktop-linux";
const marker = (key) => `<!-- community-build-key:${key} -->`;
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function completeRelease(release, key, arch) {
  const assets = release.assets || [];
  return !release.draft && !release.prerelease && release.body?.includes(marker(key))
    && assets.length === 4 && assets.every((a) => a.state === "uploaded" && a.size > 0
      && /^sha256:[a-f0-9]{64}$/.test(a.digest))
    && ["SHA256SUMS", "build-info.json", "README.txt"].every((name) => assets.some((a) => a.name === name))
    && assets.filter((a) => new RegExp(`^codex-desktop_[0-9.]+_${arch}\\.deb$`).test(a.name)).length === 1;
}
function chooseRelease(releases, key, arch, force) {
  if (force) return null;
  return releases.find((r) => completeRelease(r, key, arch)) || null;
}
function verifyAssets(release, expected) {
  if (release.assets?.length !== expected.length) throw Error("Release asset count mismatch");
  for (const file of expected) {
    const asset = release.assets.find((a) => a.name === file.name);
    if (!asset || asset.state !== "uploaded" || asset.size !== file.size
        || asset.digest !== `sha256:${file.sha256}`) throw Error(`Release asset mismatch: ${file.name}`);
  }
}
function notes(plan, deb, runId) {
  return `${marker(plan.key)}
## 本次发布 / Release

ChatGPT Community 社区构建，基于 OpenAI 官方 Linux 包 **${plan.metadata.version}**，架构 **${plan.metadata.architecture}**。

### 更新内容

- 源码提交、官方签名包或功能配置变化时自动构建并发布；无变化时复用已发布的 Release。
- 包含自动更新器及缓存清理：保护当前版本、待安装版本和一份回退备份。
- 默认关闭可选 Linux 功能；构建来源与配置哈希见 \`build-info.json\`。

### 下载、校验与安装

将本页四个附件下载到同一目录，运行：

\`\`\`bash
sha256sum -c SHA256SUMS
\`\`\`

全部显示 OK 后，先保存工作并退出应用，再安装或升级（Debian/Ubuntu，需满足包依赖）：

\`\`\`bash
sudo apt install ./${deb}
\`\`\`

预览缓存清理计划：\`codex-update-manager clean-cache --dry-run\`。
GitHub 自动生成的 Source code 压缩包是源码，不是安装包。

### 来源与验证

- [构建记录](https://github.com/${REPO}/actions/runs/${runId})
- [源码提交 ${plan.source}](https://github.com/${REPO}/commit/${plan.source})
- 官方包 SHA-256：\`${plan.metadata.sha256}\`
- 已通过官方签名和哈希验证、更新器测试与 Clippy、deb 架构/版本及包内更新器检查。
- 发布前核对全部附件的远端 SHA-256。验证范围为云端构建和包检查，未执行桌面安装/运行验收。

附件：\`${deb}\`、\`SHA256SUMS\`、\`build-info.json\`、\`README.txt\`。
Release 附件不受 Actions 14 天保留期限影响。此为社区维护版本，非 OpenAI 官方发布。
`;
}
function publish(plan, env = process.env, io = {}) {
  if (env.GITHUB_REPOSITORY !== REPO) throw Error("Unexpected release repository");
  if (!/^[a-f0-9]{64}$/.test(plan.key) || !/^[a-f0-9]{40}$/.test(plan.source)
      || !["amd64", "arm64"].includes(plan.metadata.architecture)
      || !/^\d+$/.test(env.GITHUB_RUN_ID)) throw Error("Invalid release identity");
  const gh = io.gh || ((args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  const api = io.api || ((endpoint) => JSON.parse(gh(["api", endpoint])));
  const dir = path.resolve(env.COMMUNITY_ARTIFACT_DIR || "community-artifacts");
  const info = JSON.parse(fs.readFileSync(path.join(dir, "build-info.json"), "utf8"));
  const match = /^codex-desktop_([0-9.]+)_(amd64|arm64)\.deb$/.exec(info.deb);
  if (!match || match[2] !== plan.metadata.architecture || info.key !== plan.key
      || info.source !== plan.source || info.workflowRun !== env.GITHUB_RUN_ID) throw Error("Build provenance mismatch");
  const names = [info.deb, "SHA256SUMS", "build-info.json", "README.txt"].sort();
  if (JSON.stringify(fs.readdirSync(dir).sort()) !== JSON.stringify(names)) throw Error("Unexpected release files");
  // The build has already inspected the deb; verify its bytes once more before publishing.
  execFileSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: dir, stdio: "pipe" });
  const expected = names.map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size,
    sha256: hash(path.join(dir, name)) }));
  const tag = `v${match[1]}-${match[2]}`;
  const body = notes(plan, info.deb, env.GITHUB_RUN_ID);
  const notesFile = path.join(path.resolve(env.BUILD_STATE_DIR), "release-notes.md");
  fs.writeFileSync(notesFile, body);
  const lookup = () => JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${REPO}/releases?per_page=100`]))
    .flat().find((r) => r.tag_name === tag);
  const existing = lookup();
  if (existing) {
    if (!existing.body?.includes(marker(plan.key)) || existing.target_commitish !== plan.source) {
      throw Error("Existing release belongs to different input");
    }
    if (!existing.draft) {
      verifyAssets(existing, expected);
      return existing.html_url;
    }
    if ((existing.assets || []).some((a) => !names.includes(a.name))) throw Error("Unexpected draft assets");
  } else {
    gh(["release", "create", tag, "--repo", REPO, "--target", plan.source, "--draft",
      "--title", `ChatGPT Community ${match[1]} (${match[2]}) · 自动清理更新缓存`, "--notes-file", notesFile]);
  }
  gh(["release", "upload", tag, "--repo", REPO, "--clobber", ...names.map((n) => path.join(dir, n))]);
  // Drafts do not necessarily have a published tag yet; address them by release ID.
  const draftInfo = lookup();
  if (!Number.isSafeInteger(draftInfo?.id)) throw Error("Release draft not found");
  const draft = api(`repos/${REPO}/releases/${draftInfo.id}`);
  verifyAssets(draft, expected);
  gh(["release", "edit", tag, "--repo", REPO, "--draft=false", "--latest", "--notes-file", notesFile]);
  const published = api(`repos/${REPO}/releases/${draftInfo.id}`);
  verifyAssets(published, expected);
  if (!completeRelease(published, plan.key, match[2])) throw Error("Release is not publicly complete");
  return published.html_url;
}
module.exports = { chooseRelease, completeRelease, verifyAssets, notes, publish };

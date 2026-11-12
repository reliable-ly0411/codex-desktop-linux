"use strict";
const crypto = require("node:crypto");
const POLICY = "scripts/ci/community-release-policy.json";
const REPOSITORY = "https://persistent.oaistatic.com/codex-app-prod/linux/deb";
function officialIdentity(metadata) {
  if (metadata.repository !== REPOSITORY || metadata.package !== "chatgpt"
    || !["amd64", "arm64"].includes(metadata.architecture)
    || !/^[0-9A-Za-z.+:~_-]+$/.test(metadata.version || "")
    || !/^[a-f0-9]{64}$/.test(metadata.sha256 || "")
    || !/^[a-f0-9]{64}$/.test(metadata.inReleaseSha256 || "")
    || !/^[a-f0-9]{64}$/.test(metadata.packagesSha256 || "")
    || !/^[A-F0-9]{40}$/.test(metadata.signatureFingerprint || "")) throw Error("Invalid signed official package identity");
  // Index resigning or unrelated package-index additions are provenance changes,
  // not a new app release. They are recorded, but do not trigger duplicate builds.
  return crypto.createHash("sha256").update(JSON.stringify({repository:metadata.repository,
    package:metadata.package,version:metadata.version,architecture:metadata.architecture,
    sha256:metadata.sha256})).digest("hex");
}
class MissingRedistributionPermissionError extends Error {
  constructor() {
    super("Redistribution permission evidence not verified for this exact payload; publication blocked");
    this.name = "MissingRedistributionPermissionError";
  }
}
function requireLicense(policy, metadata) {
  officialIdentity(metadata);
  if (!Array.isArray(policy.redistributionApprovals)
      || policy.redistributionApprovals.some(e => !e || typeof e !== "object" || Array.isArray(e))) {
    throw Error("Invalid redistribution approvals policy");
  }
  const evidence = policy.redistributionApprovals.find(e => e.packageSha256 === metadata.sha256
    && e.architecture === metadata.architecture && e.version === metadata.version
    && e.permission === "redistribute-repackaged-payload" && typeof e.reviewedBy === "string"
    && e.reviewedBy.trim() && /^https:\/\//.test(e.evidenceUrl || ""));
  if (!evidence) throw new MissingRedistributionPermissionError();
  return evidence;
}
module.exports = { officialIdentity, requireLicense, MissingRedistributionPermissionError, POLICY, REPOSITORY };

// Debian version ordering, not lexical or semver ordering (epochs/revisions count).
function compareVersions(a, b) {
  const { spawnSync } = require("node:child_process");
  for (const op of ["lt", "gt"]) {
    const r = spawnSync("dpkg", ["--compare-versions", a, op, b]);
    if (r.error) throw r.error;
    if (r.status === 0) return op === "lt" ? -1 : 1;
    if (r.status !== 1) throw Error("Invalid Debian package version comparison");
  }
  return 0;
}
const historyMarker = metadata => `<!-- official-package-metadata:${Buffer.from(JSON.stringify(metadata)).toString("base64")} -->`;
function releaseHistory(releases) {
  return releases.filter(r => r.tag_name?.startsWith("official-")).map(r => {
    const match = /<!-- official-package-metadata:([A-Za-z0-9+/=]+) -->/.exec(r.body || "");
    if (!match) throw Error("Official release missing immutable version history");
    const metadata = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (`official-${officialIdentity(metadata)}` !== r.tag_name) throw Error("Release history identity mismatch");
    return metadata;
  });
}
function checkPackageUpdate(metadata, policy, releases) {
  officialIdentity(metadata);
  if (!Array.isArray(policy.baselinePackages) || policy.baselinePackages.length === 0) throw Error("Verified signed package baseline missing");
  let seen = false;
  const history = [...policy.baselinePackages, ...releaseHistory(releases)];
  if (!history.some(m => m.architecture === metadata.architecture)) throw Error("Architecture baseline missing");
  for (const previous of history) {
    officialIdentity(previous);
    if (previous.architecture !== metadata.architecture) continue;
    const order = compareVersions(metadata.version, previous.version);
    if (order < 0) throw Error("Official package downgrade rejected");
    if (order === 0) {
      if (metadata.sha256 !== previous.sha256) throw Error("Same-version official payload SHA drift rejected");
      seen = true;
    }
  }
  return !seen;
}
Object.assign(module.exports, { compareVersions, historyMarker, releaseHistory, checkPackageUpdate });
function verifyPublishedHistory(releases, readAsset) {
  for (const release of releases.filter(r => r.tag_name?.startsWith("official-") && !r.draft)) {
    const asset = release.assets?.find(a => a.name === "build-info.json");
    if (!asset || !Number.isSafeInteger(asset.id) || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) throw Error("Published provenance asset missing");
    const bytes = readAsset(asset.id);
    if (`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) throw Error("Published provenance digest mismatch");
    const info = JSON.parse(bytes.toString());
    const [metadata] = releaseHistory([release]);
    if (officialIdentity(info.metadata) !== officialIdentity(metadata)
      || info.upstreamKey !== officialIdentity(metadata) || !/^[a-f0-9]{40}$/.test(info.source || "")
      || !/^[a-f0-9]{64}$/.test(info.key || "")
      || !release.body?.includes(`<!-- community-build-key:${info.key} -->`)) throw Error("Published provenance identity mismatch");
    for (const field of ["inReleaseSha256", "packagesSha256", "signatureFingerprint"]) {
      if (info.metadata[field] !== metadata[field]) throw Error("Published signed-index provenance mismatch");
    }
  }
}
module.exports.verifyPublishedHistory = verifyPublishedHistory;

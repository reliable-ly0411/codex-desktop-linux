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
function requireLicense(policy, metadata) {
  officialIdentity(metadata);
  const evidence = policy.redistributionApprovals?.find(e => e.packageSha256 === metadata.sha256
    && e.architecture === metadata.architecture && e.version === metadata.version
    && e.permission === "redistribute-repackaged-payload" && typeof e.reviewedBy === "string"
    && e.reviewedBy.trim() && /^https:\/\//.test(e.evidenceUrl || ""));
  if (!evidence) throw Error("Redistribution permission evidence not verified for this exact payload; publication blocked");
  return evidence;
}
module.exports = { officialIdentity, requireLicense, POLICY, REPOSITORY };

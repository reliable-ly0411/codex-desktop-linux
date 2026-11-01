# Community release policy

Manual dispatch defaults to `run_mode: sync-only`: it synchronizes source and
runs offline orchestration/signature-fixture checks, and the entire package build
job is skipped. It does not resolve official package metadata, build packages,
upload artifacts or publish Releases. Explicit `release-candidate` dispatch is
separate; the six-hour schedule retains the guarded package-update policy.

The six-hour schedule synchronizes source from `ilysenko/codex-desktop-linux`
and runs ordinary offline orchestration checks. Only an update to OpenAI's
**official signed stable installation package** triggers a package Release.
An ilysenko GitHub Release, wrapper source commit or feature configuration change
alone does not. The package release identity consists of repository, package,
version, architecture and payload SHA-256. Signed InRelease and Packages hashes
and the pinned signing fingerprint are retained as evidence; an index re-sign
or unrelated index addition alone is not a new app release.

The candidate records the immutable synchronized wrapper SHA, verified official
payload and index hashes, architecture, feature configuration and originating
run. Official signatures and indexed hashes must verify before any build. If
signed metadata changes during download, that candidate fails closed. Each
package identity has one stable `official-<identity hash>` fork tag. Published
tags and assets are never overwritten; an incomplete matching draft may upload
only missing assets when resuming the exact same candidate bytes and originating
run. A different run must NOT rebuild and replace a partial draft: it fails
closed and requires explicit operator recovery of the original artifacts/provenance.
Existing draft bytes must match exactly. A new wrapper
commit cannot trigger a rebuild/republication of the same official payload.

## Current permission blocker

The upstream README explicitly limits its MIT license to wrapper source,
packaging, documentation and community-owned extensions, and does not grant
rights to the official payload. No payload redistribution permission evidence
has yet been verified. `community-release-policy.json` therefore has an empty
`redistributionApprovals` list and package build/upload/publication fails closed.
Official signatures prove package origin, not redistribution permission.

To resolve this blocker, review an actual rights-holder permission source for
repackaging and public redistribution. A reviewed, committed approval entry must
identify `version`, `packageSha256`, `architecture`,
`permission: "redistribute-repackaged-payload"`, `reviewedBy` and `evidenceUrl`.
Do not fill these fields using assumptions, the wrapper MIT license, or a user
request to publish. This is a license review gate, not recurring manual desktop
acceptance. Ordinary source synchronization and CI do not require this approval.

`baselinePackages` records both architectures of the independently signature-verified
26.1027.51404 package observed on 2026-11-01. It is not backfilled. Before building
and again before publishing, compare each architecture against this baseline and
all previous `official-*` Release metadata using Debian version ordering. Reject
older versions and same-version payload SHA changes, even if signature and license
checks pass. A same-version, same-payload observation is a no-op. Missing or
inconsistent release-history metadata fails closed, not silently discarded.

Publication is limited to this fork's GitHub Releases. No website deployment,
registry upload, R2 deletion, issue/PR closures, comments or labels are authorized.
Restoring Actions requires separately merged side-effect guards. No credentials
are added. Native package installation or desktop runtime acceptance is not
claimed by these cloud-only checks. Sync merges pinned upstream commits while
preserving `.github`, `scripts/ci` and this policy document; other conflicts stop
synchronization without pushing. It never force-pushes.

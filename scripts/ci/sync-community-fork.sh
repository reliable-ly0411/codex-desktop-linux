#!/usr/bin/env bash
set -euo pipefail
: "${GH_REPO:?}" "${GITHUB_OUTPUT:?}" "${GITHUB_STEP_SUMMARY:?}"
[[ "$GH_REPO" == 'reliable-ly0411/codex-desktop-linux' ]]
[[ "${SYNC_UPSTREAM:-true}" == true || "${SYNC_UPSTREAM:-true}" == false ]]
parent=$(gh api "repos/$GH_REPO" --jq '.parent.full_name')
[[ "$parent" == 'ilysenko/codex-desktop-linux' ]]
before=$(gh api "repos/$GH_REPO/git/ref/heads/main" --jq '.object.sha')
[[ "$before" =~ ^[0-9a-f]{40}$ ]]
if [[ "${SYNC_UPSTREAM:-true}" == true ]]; then
    # A conflict or permission error must stop the downstream build job.
    gh api --method POST "repos/$GH_REPO/merge-upstream" -f branch=main
fi
after=$(gh api "repos/$GH_REPO/git/ref/heads/main" --jq '.object.sha')
[[ "$after" =~ ^[0-9a-f]{40}$ ]]
printf 'source_sha=%s\n' "$after" >> "$GITHUB_OUTPUT"
printf '### Source / 源码\n\nBefore: `%s`\n\nBuild commit: `%s`\n' "$before" "$after" >> "$GITHUB_STEP_SUMMARY"

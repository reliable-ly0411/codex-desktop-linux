#!/usr/bin/env bash
set -euo pipefail
: "${GH_REPO:?}" "${GITHUB_OUTPUT:?}" "${GITHUB_STEP_SUMMARY:?}"
[[ "$GH_REPO" == 'reliable-ly0411/codex-desktop-linux' ]]
[[ "${SYNC_UPSTREAM:-true}" == true || "${SYNC_UPSTREAM:-true}" == false ]]
parent=$(gh api "repos/$GH_REPO" --jq '.parent.full_name')
[[ "$parent" == 'ilysenko/codex-desktop-linux' ]]
before=$(gh api "repos/$GH_REPO/git/ref/heads/main" --jq '.object.sha')
[[ "$before" =~ ^[0-9a-f]{40}$ ]]
git fetch --no-tags origin main
[[ $(git rev-parse FETCH_HEAD) == "$before" ]]
git checkout --detach "$before"
if [[ "${SYNC_UPSTREAM:-true}" == true ]]; then
    # Pin the fetched source. Do not let an upstream workflow change remove the
    # fork's local release/license and non-scope side-effect policy.
    git fetch --no-tags https://github.com/ilysenko/codex-desktop-linux.git main
    upstream=$(git rev-parse FETCH_HEAD)
    [[ "$upstream" =~ ^[0-9a-f]{40}$ ]]
    git config user.name 'github-actions[bot]'
    git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
    if ! git merge --no-ff --no-commit "$upstream"; then
        while IFS= read -r file; do
            case "$file" in
                .github/*|scripts/ci/*|docs/community-release-policy.md) ;;
                *) echo "Upstream source conflict: $file" >&2; exit 1 ;;
            esac
        done < <(git diff --name-only --diff-filter=U)
        # A failed merge without conflicts is an actual error, not permission to continue.
        [[ -n $(git diff --name-only --diff-filter=U) ]]
    fi
    git restore --source="$before" --staged --worktree -- .github scripts/ci docs/community-release-policy.md
    [[ -z $(git diff --name-only --diff-filter=U) ]]
    if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
        git commit -m "Sync pinned upstream $upstream; preserve fork automation policy"
    fi
    # Non-force push provides an atomic non-fast-forward rejection if main moved.
    # Token is provided by Actions; no persistent credentials or secret setup.
    git -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' push origin HEAD:refs/heads/main
fi
after=$(git rev-parse HEAD)
[[ "$after" =~ ^[0-9a-f]{40}$ ]]
remote=$(gh api "repos/$GH_REPO/git/ref/heads/main" --jq '.object.sha')
[[ "$after" == "$remote" ]]
printf 'source_sha=%s\n' "$after" >> "$GITHUB_OUTPUT"
printf '### Source / 源码\n\nBefore: `%s`\n\nBuild commit: `%s`\n' "$before" "$after" >> "$GITHUB_STEP_SUMMARY"

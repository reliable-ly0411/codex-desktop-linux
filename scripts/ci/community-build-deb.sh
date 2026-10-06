#!/usr/bin/env bash
set -euo pipefail
umask 022
: "${BUILD_STATE_DIR:?}" "${BUILD_ARCH:?}" "${SOURCE_SHA:?}"
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]]
[[ "$(dpkg --print-architecture)" == "$BUILD_ARCH" ]]
export TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop-dev/tmp"
mkdir -p "$TMPDIR"
package=$(node scripts/ci/community-build.js download)
export PACKAGE_WITH_UPDATER=1
export CODEX_TARGET_ARCH="$BUILD_ARCH"
export PACKAGE_VERSION="$(date -u +%Y.%m.%d.%H%M%S)"
cargo build --locked --release -p codex-update-manager
./install.sh "$package"
./scripts/build-deb.sh
mkdir -p community-artifacts
output="dist/codex-desktop_${PACKAGE_VERSION}_${BUILD_ARCH}.deb"
[[ "$(dpkg-deb -f "$output" Package)" == codex-desktop ]]
[[ "$(dpkg-deb -f "$output" Architecture)" == "$BUILD_ARCH" ]]
[[ "$(dpkg-deb -f "$output" Version)" == "$PACKAGE_VERSION" ]]
verify_dir=$(mktemp -d)
trap 'rm -rf "$verify_dir"' EXIT
dpkg-deb -x "$output" "$verify_dir"
# Inspect the artifact itself; never invoke package maintainer scripts or install it.
updater="$verify_dir/usr/bin/codex-update-manager"
test -x "$updater"
cmp target/release/codex-update-manager "$updater"
test -f "$verify_dir/usr/lib/systemd/user/codex-update-manager.service"
test -f "$verify_dir/opt/codex-desktop/update-builder/install.sh"
"$updater" clean-cache --help | grep -F -- --dry-run
cp "$output" community-artifacts/
node scripts/ci/community-build.js record
(cd community-artifacts && sha256sum -c SHA256SUMS)

#!/bin/sh
# Puts the golem and shem of tools.versions into src-tauri/resources/, after
# checking each archive against the release's SHA256SUMS (docs/adr/0008).
#
#   bundle-tools.sh [versions file] [resources dir]
#
# ALEPH_RELEASES_URL replaces https://github.com/tett23 (tests use file://).
# Exit status: 0 bundled, 1 a download or a check failed, 64 usage.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
versions=${1:-$root/tools.versions}
resources=${2:-$root/src-tauri/resources}
base=${ALEPH_RELEASES_URL:-https://github.com/tett23}
[ -f "$versions" ] || { echo "bundle-tools: no $versions" >&2; exit 64; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$resources"

grep -v '^[[:space:]]*#' "$versions" | grep -v '^[[:space:]]*$' | while read -r name tag pattern; do
  archive=$(printf '%s' "$pattern" | sed "s/{tag}/$tag/g")
  url="$base/$name/releases/download/$tag"
  dir="$work/$name"
  mkdir -p "$dir"
  curl -fsSL -o "$dir/$archive" "$url/$archive" || { echo "bundle-tools: cannot fetch $url/$archive" >&2; exit 1; }
  curl -fsSL -o "$dir/SHA256SUMS" "$url/SHA256SUMS" || { echo "bundle-tools: cannot fetch $url/SHA256SUMS" >&2; exit 1; }
  want=$(awk -v a="$archive" '$2 == a || $2 == "*" a { print $1 }' "$dir/SHA256SUMS")
  got=$(sha256 "$dir/$archive")
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    echo "bundle-tools: $archive does not match SHA256SUMS" >&2
    exit 1
  fi
  tar -xzf "$dir/$archive" -C "$dir"
  top="$dir/$(basename "$archive" .tar.gz)"
  [ -x "$top/$name" ] || { echo "bundle-tools: no $name in $archive" >&2; exit 1; }
  cp "$top/$name" "$resources/$name"
  mkdir -p "$resources/licenses/$name"
  cp "$top/LICENSE" "$resources/licenses/$name/LICENSE"
  [ -d "$top/THIRD_PARTY_LICENSES" ] && cp -R "$top/THIRD_PARTY_LICENSES" "$resources/licenses/$name/"
  echo "bundled $name $tag"
done

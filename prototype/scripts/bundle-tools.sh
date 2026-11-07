#!/bin/sh
# Copies golem and shem into src-tauri/resources/ so that the app bundles them.
# usage: scripts/bundle-tools.sh [golem binary] [shem binary]
set -eu
dir=$(cd "$(dirname "$0")/.." && pwd)/src-tauri/resources
golem=${1:-$(command -v golem)}
shem=${2:-$(command -v shem || true)}
cp "$golem" "$dir/golem"
[ -n "$shem" ] && cp "$shem" "$dir/shem"
ls -l "$dir"

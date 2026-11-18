#!/bin/sh
# Puts the tools and files of tools.versions into src-tauri/resources/
# (docs/adr/0008, docs/adr/0081). A row of tools.versions is one of:
#
#   <name> <tag> <archive>
#       a release of github.com/tett23/<name> (golem, shem), checked against
#       the release's SHA256SUMS; installs <name> and licenses/<name>/.
#   <name> <tag> <archive> <repo> <sha256> <file>...
#       a release archive of github.com/<repo> (llama.cpp), checked against
#       <sha256>; installs each <file> into <name>/, and LICENSE into
#       licenses/<name>/.
#   manual <file> <repo> <sha256>
#       manual/chapters/<file> of <repo> at the tag of the golem row, checked
#       against <sha256>; installs manual/<file>.
#
# {tag} in <archive> is replaced with the tag.
#
#   bundle-tools.sh [versions file] [resources dir]
#
# ALEPH_RELEASES_URL replaces https://github.com/tett23, ALEPH_GITHUB_URL
# https://github.com and ALEPH_RAW_URL https://raw.githubusercontent.com
# (tests use file://). Every file is fetched and checked before anything is
# installed, so a failure leaves the resources as they were.
# Exit status: 0 bundled, 1 a download or a check failed, 64 usage.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
versions=${1:-$root/tools.versions}
resources=${2:-$root/src-tauri/resources}
releases=${ALEPH_RELEASES_URL:-https://github.com/tett23}
github=${ALEPH_GITHUB_URL:-https://github.com}
raw=${ALEPH_RAW_URL:-https://raw.githubusercontent.com}
[ -f "$versions" ] || { echo "bundle-tools: no $versions" >&2; exit 64; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fail() { echo "bundle-tools: $*" >&2; exit 1; }

fetch() { # url file
  curl -fsSL -o "$2" "$1" || fail "cannot fetch $1"
}

check() { # file sha256 name
  [ "$(sha256 "$1")" = "$2" ] || fail "$3 does not match its SHA-256 in tools.versions"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stage="$work/stage"
mkdir -p "$stage"

grep -v '^[[:space:]]*#' "$versions" | grep -v '^[[:space:]]*$' > "$work/rows" || true
golem_tag=$(awk '$1 == "golem" { print $2; exit }' "$work/rows")
if grep -q '^[[:space:]]*manual[[:space:]]' "$work/rows" && [ -z "$golem_tag" ]; then
  echo "bundle-tools: manual rows need a golem row for the tag" >&2
  exit 64
fi

# a release of github.com/tett23/<name>, checked against SHA256SUMS
released() { # name tag pattern
  name=$1 tag=$2
  archive=$(printf '%s' "$3" | sed "s/{tag}/$tag/g")
  url="$releases/$name/releases/download/$tag"
  dir="$work/$name"
  mkdir -p "$dir"
  fetch "$url/$archive" "$dir/$archive"
  fetch "$url/SHA256SUMS" "$dir/SHA256SUMS"
  want=$(awk -v a="$archive" '$2 == a || $2 == "*" a { print $1 }' "$dir/SHA256SUMS")
  [ -n "$want" ] && [ "$want" = "$(sha256 "$dir/$archive")" ] || fail "$archive does not match SHA256SUMS"
  tar -xzf "$dir/$archive" -C "$dir"
  top="$dir/$(basename "$archive" .tar.gz)"
  [ -x "$top/$name" ] || fail "no $name in $archive"
  cp "$top/$name" "$stage/$name"
  mkdir -p "$stage/licenses/$name"
  cp "$top/LICENSE" "$stage/licenses/$name/LICENSE"
  if [ -d "$top/THIRD_PARTY_LICENSES" ]; then cp -R "$top/THIRD_PARTY_LICENSES" "$stage/licenses/$name/"; fi
  echo "checked $name $tag"
}

# the directory an archive was unpacked into, or its one top directory
only_dir() { # dir
  set -- "$1"/*
  if [ $# -eq 1 ] && [ -d "$1" ]; then printf '%s' "$1"; else dirname "$1"; fi
}

# a release archive of github.com/<repo>, checked against the SHA-256 given
pinned() { # name tag pattern repo sha256 file...
  name=$1 tag=$2 repo=$4 want=$5
  archive=$(printf '%s' "$3" | sed "s/{tag}/$tag/g")
  shift 5
  [ $# -gt 0 ] || { echo "bundle-tools: no files to copy for $name" >&2; exit 64; }
  dir="$work/$name"
  mkdir -p "$dir/x"
  fetch "$github/$repo/releases/download/$tag/$archive" "$dir/$archive"
  check "$dir/$archive" "$want" "$archive"
  tar -xzf "$dir/$archive" -C "$dir/x"
  top=$(only_dir "$dir/x")
  mkdir -p "$stage/$name"
  for f do
    [ -e "$top/$f" ] || fail "no $f in $archive"
    # cp follows a symbolic link, so a library lands under the name it is loaded by
    if [ "$f" = LICENSE ]; then
      mkdir -p "$stage/licenses/$name"
      cp "$top/$f" "$stage/licenses/$name/LICENSE"
    else
      cp "$top/$f" "$stage/$name/$f"
    fi
  done
  echo "checked $name $tag"
}

# manual/chapters/<file> of <repo> at the golem tag, checked against the SHA-256 given
chapter() { # file repo sha256
  mkdir -p "$stage/manual"
  fetch "$raw/$2/$golem_tag/manual/chapters/$1" "$stage/manual/$1"
  check "$stage/manual/$1" "$3" "$1"
  echo "checked manual $1 $golem_tag"
}

while read -r first second rest; do
  set -f; set -- $rest; set +f
  if [ "$first" = manual ]; then chapter "$second" "$@"
  elif [ $# -eq 1 ]; then released "$first" "$second" "$1"
  else pinned "$first" "$second" "$@"; fi
done < "$work/rows"

# all checked: install them together, replacing the directories
mkdir -p "$resources"
for entry in "$stage"/* "$stage"/licenses/*; do
  [ -e "$entry" ] || continue
  rel=${entry#"$stage"/}
  [ "$rel" = licenses ] && continue
  rm -rf "${resources:?}/$rel"
  mkdir -p "$(dirname "$resources/$rel")"
  cp -R "$entry" "$resources/$rel"
done
echo "bundled into $resources"

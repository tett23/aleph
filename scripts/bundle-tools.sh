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
#   manual-manifest <repo> <sha256>
#   manual-label <label> <sha256> [<legacy-name>]
#       Find the heading label in the pinned manual's chapters. Verify the
#       manifest and selected original; install manual/labels/<label>.gm.
#       An optional alias is also installed under manual/ for older readers.
#   model <file> <repo> <revision> <sha256>
#       <file> of the Hugging Face repository <repo> at <revision>, checked
#       against <sha256>; installs models/<file>. A file already installed
#       that matches <sha256> is kept instead of being fetched again.
#
# {tag} in <archive> is replaced with the tag.
#
#   bundle-tools.sh [versions file] [resources dir]
#
# ALEPH_RELEASES_URL replaces https://github.com/tett23, ALEPH_GITHUB_URL
# https://github.com, ALEPH_RAW_URL https://raw.githubusercontent.com and
# ALEPH_HF_URL https://huggingface.co (tests use file://). With
# ALEPH_SKIP_MODELS set to anything but the empty string, the model rows are
# skipped and the installed models are left as they are (the benchmark, which
# needs golem only). Every file is fetched and checked before anything is
# installed, so a failure leaves the resources as they were.
# Exit status: 0 bundled, 1 a download or a check failed, 64 usage.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
versions=${1:-$root/tools.versions}
resources=${2:-$root/src-tauri/resources}
releases=${ALEPH_RELEASES_URL:-https://github.com/tett23}
github=${ALEPH_GITHUB_URL:-https://github.com}
raw=${ALEPH_RAW_URL:-https://raw.githubusercontent.com}
hf=${ALEPH_HF_URL:-https://huggingface.co}
skip_models=${ALEPH_SKIP_MODELS:-}
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
if grep -Eq '^[[:space:]]*manual(-manifest|-label)?[[:space:]]' "$work/rows" && [ -z "$golem_tag" ]; then
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

# The manual's pinned manifest uses a top-level array of literal source paths.
# Read that array and reject unsupported or non-relative source paths.
manual_chapters() {
  awk '
    !active {
      if ($0 ~ /^[[:space:]]*\[/) exit 1
      if (!sub(/^[[:space:]]*chapters[[:space:]]*=[[:space:]]*\[/, "")) next
      active = 1
    }
    active {
      sub(/#.*/, "")
      sub(/[[:space:]]*$/, "")
      while (1) {
        sub(/^[[:space:]]*/, "")
        if ($0 == "") break
        if ($0 == "]") { closed = 1; exit }
        if (!match($0, /^"[^"]+"|^\047[^\047]+\047/)) exit 1
        file = substr($0, 2, RLENGTH - 2)
        $0 = substr($0, RLENGTH + 1)
        if (file !~ /^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*\.gm$/ ||
            file ~ /(^|\/)\.\.?\// || seen[file]++) exit 1
        print file
        if (!sub(/^[[:space:]]*,/, "") && $0 !~ /^[[:space:]]*\]/) exit 1
      }
    }
    END { if (!closed) exit 1 }
  ' "$1"
}

bundle_labels() (
  awk '$1 == "manual-label" { if (NF < 3 || NF > 4) exit 1; print $2, $3, $4 }' "$work/rows" > "$work/manual-pins" ||
    fail "manual-label rows need a label, SHA-256 and optional legacy name"
  [ -s "$work/manual-pins" ] || exit 0
  manifest=$(awk '$1 == "manual-manifest" { if (NF != 3 || ++count > 1) exit 1; print $2, $3 }' "$work/rows") ||
    fail "manual-label rows need exactly one manual-manifest repo SHA-256 row"
  set -- $manifest
  [ "$#" -eq 2 ] || fail "manual-label rows need one manual-manifest repo SHA-256 row"
  manual_url="$raw/$1/$golem_tag/manual"
  fetch "$manual_url/manifest.toml" "$work/manual-manifest"
  check "$work/manual-manifest" "$2" "manual/manifest.toml"
  manual_chapters "$work/manual-manifest" > "$work/manual-chapters" ||
    fail "cannot read chapters in manual/manifest.toml"

  mkdir -p "$work/manual-originals" "$stage/manual/labels"
  i=0
  while IFS= read -r source; do
    i=$((i + 1))
    file="$work/manual-originals/$i"
    fetch "$manual_url/$source" "$file"
    awk -v i="$i" '
      /^[ ]*```/ {
        match($0, /^ */)
        if (!fenced) { fenced = 1; indent = RLENGTH; label = "" }
        else if (RLENGTH == indent && $0 ~ /^ *```[[:blank:]]*$/) fenced = 0
        next
      }
      fenced { next }
      /^@label[[:space:]]/ && NF == 2 { label = $2; next }
      /^#+[[:space:]]/ && label != "" && !seen[label]++ { print label, i }
      !/^[[:space:]]*($|%%)|^@[a-z-]+/ { label = "" }
    ' "$file"
  done < "$work/manual-chapters" > "$work/manual-labels"

  while read -r label digest alias; do
    case "$label" in ""|*[!a-zA-Z0-9_-]*) fail "invalid manual label: $label";; esac
    source=$(awk -v label="$label" '$1 == label { print $2 }' "$work/manual-labels")
    set -- $source
    case $# in
      0) fail "manual label $label is missing";;
      1) ;;
      *) fail "manual label $label occurs in multiple originals";;
    esac
    check "$work/manual-originals/$1" "$digest" "manual label $label"
    cp "$work/manual-originals/$1" "$stage/manual/labels/$label.gm"
    case "$alias" in
      "") ;;
      .*|*[!a-zA-Z0-9_.-]*) fail "invalid manual alias: $alias";;
      *.gm) cp "$work/manual-originals/$1" "$stage/manual/$alias";;
      *) fail "invalid manual alias: $alias";;
    esac
    echo "checked manual label $label $golem_tag"
  done < "$work/manual-pins"
)

# <file> of the Hugging Face repository <repo> at <revision>, checked against
# the SHA-256 given; the installed copy when it matches
model() { # file repo revision sha256
  [ $# -eq 4 ] || { echo "bundle-tools: a model row is: model <file> <repo> <revision> <sha256>" >&2; exit 64; }
  mkdir -p "$stage/models"
  installed="$resources/models/$1"
  if [ -f "$installed" ] && [ "$(sha256 "$installed")" = "$4" ]; then
    # a hard link where it can, as the file is large
    ln "$installed" "$stage/models/$1" 2>/dev/null || cp "$installed" "$stage/models/$1"
    echo "checked model $1 (installed)"
  else
    fetch "$hf/$2/resolve/$3/$1" "$stage/models/$1"
    check "$stage/models/$1" "$4" "$1"
    echo "checked model $1 $3"
  fi
}

while read -r first second rest; do
  set -f; set -- $rest; set +f
  if [ "$first" = manual ]; then chapter "$second" "$@"
  elif [ "$first" = manual-label ] || [ "$first" = manual-manifest ]; then :
  elif [ "$first" = model ]; then
    if [ -n "$skip_models" ]; then echo "skipped model $second"; else model "$second" "$@"; fi
  elif [ $# -eq 1 ]; then released "$first" "$second" "$1"
  else pinned "$first" "$second" "$@"; fi
done < "$work/rows"
bundle_labels

# all checked: install them together, replacing the directories; moved, not
# copied, as the stage goes anyway and a model is large
mkdir -p "$resources"
for entry in "$stage"/* "$stage"/licenses/*; do
  [ -e "$entry" ] || continue
  rel=${entry#"$stage"/}
  [ "$rel" = licenses ] && continue
  rm -rf "${resources:?}/$rel"
  mkdir -p "$(dirname "$resources/$rel")"
  mv "$entry" "$resources/$rel"
done
echo "bundled into $resources"

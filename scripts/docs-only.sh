#!/bin/sh
# Whether a change touches documentation only (docs/adr/0080).
# Reads the changed file names, one per line, from the standard input, and
# prints "true" when there is at least one and every one is documentation,
# "false" otherwise. Runs with the BSD tools of macOS and the GNU tools of Linux.
set -u

files=0
while IFS= read -r f || [ -n "$f" ]; do
  [ -z "$f" ] && continue
  files=$((files + 1))
  case "$f" in
    README.md | README.ja.md | CONTRIBUTING.md | CONTRIBUTING.ja.md) ;;
    docs/specifications.md | docs/roadmap.md | docs/glossary.md) ;;
    docs/adr/?* | docs/research/?*) ;;
    docs/audits/?* | docs/audit/?* | docs/benchmarks/?* | docs/benchmark/?*) ;;
    *)
      echo false
      exit 0
      ;;
  esac
done

if [ "$files" -gt 0 ]; then echo true; else echo false; fi

#!/bin/sh
# Whether a change touches documentation only (docs/adr/0080, docs/adr/0084).
# Reads the changed file names, one per line, from the standard input, and
# prints "true" when there is at least one and every one is documentation,
# "false" otherwise. Runs with the BSD tools of macOS and the GNU tools of Linux.
set -u

files=0
while IFS= read -r f || [ -n "$f" ]; do
  [ -z "$f" ] && continue
  files=$((files + 1))
  case "$f" in
    # docs that tests read are inputs of the tests (docs/adr/0084);
    # scripts/docs-only.test.ts fails when a test reads a doc missing here
    docs/glossary.md | docs/specifications.md | docs/adr/0082-ui-names-and-glossary.md | docs/adr/0087-preview-in-a-tab.md)
      echo false
      exit 0
      ;;
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

#!/bin/sh
# Tests of scripts/docs-only.sh (docs/adr/0080): the boundary inputs of the ADR.
# Runs with the BSD tools of macOS and the GNU tools of Linux.
set -u

script=$(cd "$(dirname "$0")" && pwd)/docs-only.sh
failures=0
cases=0

# check <name> <expected> <file names, one per line>
check() {
  cases=$((cases + 1))
  got=$(printf '%s' "$3" | sh "$script")
  if [ "$got" != "$2" ]; then
    echo "FAIL: $1: expected $2, got $got"
    failures=$((failures + 1))
  fi
}

nl='
'

check "ADR 0080 I1: an ADR alone is docs only" true "docs/adr/0080-skip-app-checks-for-docs-only-changes.md$nl"
check "ADR 0080 I1: README and its translation are docs only" true "README.md${nl}README.ja.md$nl"
check "ADR 0080 I1: CONTRIBUTING and its translation are docs only" true "CONTRIBUTING.md${nl}CONTRIBUTING.ja.md$nl"
check "ADR 0080 I1, ADR 0084 I2: the roadmap is docs only" true "docs/roadmap.md$nl"
check "ADR 0084 I1: the glossary, read by a test, is not docs only" false "docs/glossary.md$nl"
check "ADR 0084 I1: the specification, read by a test, is not docs only" false "docs/specifications.md$nl"
check "ADR 0084 I1: ADR 0082, read by a test, is not docs only" false "docs/adr/0082-ui-names-and-glossary.md$nl"
check "ADR 0084 I2: another ADR is still docs only" true "docs/adr/0080-skip-app-checks-for-docs-only-changes.md$nl"
check "ADR 0084 I2: the roadmap and README are still docs only" true "docs/roadmap.md${nl}README.md$nl"
check "ADR 0080 I1: research and records are docs only" true "docs/research/a.md${nl}docs/audits/a.md${nl}docs/audit/2026-11-08-security.md${nl}docs/benchmarks/b.json${nl}docs/benchmark/c.json$nl"
check "ADR 0080 I1, I2: the roadmap with code is not docs only" false "docs/roadmap.md${nl}app/main.ts$nl"
check "ADR 0080 I1, I2: docs/budgets.md is not docs only" false "docs/budgets.md$nl"
check "ADR 0080 I1, I2: a docs/ file outside the list is not docs only" false "docs/notes.md$nl"
check "ADR 0080 I1, I2: a workflow is not docs only" false ".github/workflows/ci.yml$nl"
check "ADR 0080 I1, I2: no changed file is not docs only" false ""
check "ADR 0080 I1, I2: a blank line alone is not docs only" false "$nl"
check "ADR 0080 I1: a directory like docs/adr is not docs/adr" false "docs/adrs/x.md$nl"
check "ADR 0080 I1: a name that starts like README.md is not README.md" false "README.md.bak$nl"
check "ADR 0080 I1: docs/adr itself without a file is not docs only" false "docs/adr$nl"
check "ADR 0080 I1: a nested README is not the root README" false "app/README.md$nl"
check "ADR 0080 I1: input without a final newline is read" true "docs/roadmap.md"

echo "$cases cases, $failures failures"
[ "$failures" -eq 0 ]

#!/bin/sh
# Writes app/entities.ts, the HTML named character references that end in ";"
# (the ones CommonMark reads), from WHATWG's table (docs/adr/0061).
# The table is under CC BY 4.0: https://html.spec.whatwg.org/entities.json
#
#   gen-entities.sh [out file]
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/app/entities.ts}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/entities.json" https://html.spec.whatwg.org/entities.json
node -e '
const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const m = {};
for (const [k, v] of Object.entries(e)) if (k.endsWith(";")) m[k.slice(1, -1)] = v.characters;
const keys = Object.keys(m).sort();
process.stdout.write(
  "// The HTML named character references that end in \";\" (docs/adr/0061), by scripts/gen-entities.sh.\n" +
  "// From WHATWG HTML, https://html.spec.whatwg.org/entities.json (CC BY 4.0).\n" +
  "export const ENTITIES: Record<string, string> = {\n" +
  keys.map((k) => "  " + JSON.stringify(k) + ": " + JSON.stringify(m[k]) + ",").join("\n") +
  "\n};\n",
);
' "$work/entities.json" > "$out"

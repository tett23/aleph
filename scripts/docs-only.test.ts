// The docs that tests read are not docs-only changes (docs/adr/0084): every quoted
// docs/… or README….md path in a test file makes scripts/docs-only.sh print false.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");

/** The quoted paths of docs a test source names: docs/….md or README….md inside quotes. */
export const docsReadBy = (src: string): string[] =>
  [...new Set([...src.matchAll(/["'`]((?:docs\/[^"'`\s]+|README[^"'`\s/]*)\.md)["'`]/g)].map((m) => m[1]))];

const testFiles = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const p = `${dir}/${f}`;
    if (f === "node_modules") return [];
    if (statSync(join(root, p)).isDirectory()) return testFiles(p);
    return f.endsWith(".test.ts") ? [p] : [];
  });

const docsOnly = (path: string) =>
  spawnSync("sh", [join(root, "scripts/docs-only.sh")], { input: `${path}\n`, encoding: "utf8" }).stdout.trim();

test("ADR 0084 I1: quoted docs paths are picked; ADR numbers in names and comments are not", () => {
  assert.deepEqual(docsReadBy(`const ADR = "docs/adr/0082-ui-names-and-glossary.md"; read("docs/glossary.md");`), [
    "docs/adr/0082-ui-names-and-glossary.md",
    "docs/glossary.md",
  ]);
  assert.deepEqual(docsReadBy(`test("the key settings (docs/adr/0034)", () => {}); // docs/adr/0057: a note`), []);
  assert.deepEqual(docsReadBy("read(`README.ja.md`)"), ["README.ja.md"]);
});

test("ADR 0084 I1: every doc a test reads makes scripts/docs-only.sh print false", () => {
  const read = [...new Set(["app", "scripts", "bench"].flatMap((d) => { try { return testFiles(d); } catch { return []; } })
    .filter((f) => f !== "scripts/docs-only.test.ts")
    .flatMap((f) => docsReadBy(readFileSync(join(root, f), "utf8"))))];
  assert.ok(read.includes("docs/glossary.md"), "the glossary test reads docs/glossary.md");
  for (const p of read) assert.equal(docsOnly(p), "false", p);
});

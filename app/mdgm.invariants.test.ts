// The invariants of the conversion to gm that need no golem (docs/adr/0061): I1, I3, I7, I8 and I9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "./md.ts";
import { mdToGm, type GmCtx } from "./mdgm.ts";
import { BOUNDARY, generate, longLines, rng } from "./mdgm.testlib.ts";

const SEPS = ["blank-line", "line"] as const;
const CTXS: GmCtx[] = [
  { dir: null, resolveEmbed: () => null },
  { dir: "chapters", resolveEmbed: (t) => (t.endsWith(".png") ? `images/${t}` : null) },
];
const inputs = (n: number) => {
  const r = rng(61);
  return [...BOUNDARY, ...Array.from({ length: n }, () => generate(r))];
};

/** I7: no C0 control but tab and newline, no U+FFFE, U+FFFF, and no BOM at the start. */
const noControl = (gm: string) => !/[\x00-\x08\x0B-\x1F￾￿]/.test(gm) && !gm.startsWith("﻿");
/** I8: every @figure follows @nonumber, quotes its path and has an alt. */
const figuresOk = (gm: string) =>
  gm.split("\n").every((l, k, ls) => !/^\s*@figure/.test(l) || (/^\s*@nonumber\s*$/.test(ls[k - 1] ?? "") && /^\s*@figure "(?:[^"\\]|\\.)*" alt="(?:[^"\\]|\\.)*"$/.test(l)));

test("I1 I3 I7 I8: on 100,000 generated inputs and the boundary inputs, no throw, the same gm twice, no control characters, figures right", () => {
  for (const md of inputs(100_000))
    for (const sep of SEPS)
      for (const ctx of CTXS) {
        const gm = mdToGm(md, sep, ctx);
        assert.equal(typeof gm, "string");
        assert.equal(mdToGm(md, sep, ctx), gm, JSON.stringify(md));
        assert.ok(noControl(gm), `I7 ${JSON.stringify(md)} → ${JSON.stringify(gm)}`);
        assert.ok(figuresOk(gm), `I8 ${JSON.stringify(md)} → ${JSON.stringify(gm)}`);
      }
});

test("I1: the boundary inputs: empty and blank inputs give an empty gm", () => {
  for (const md of ["", "\n\n\n", "   \n  "]) for (const sep of SEPS) assert.equal(mdToGm(md, sep), "");
});

test("I7: each control character goes; a BOM goes and the heading after it stays", () => {
  for (const c of ["\u0000", "\u0007", "\u000B", "\u001F", "￾", "￿"]) assert.equal(mdToGm(`a${c}b\n`, "blank-line"), "ab\n");
  assert.equal(mdToGm("﻿", "blank-line"), "");
  assert.equal(mdToGm("﻿# 見出し\n", "blank-line"), "# 見出し\n");
  // a U+FEFF that only a quote's mark kept from the file's start
  assert.ok(!mdToGm("> ﻿a", "blank-line").startsWith("﻿"));
});

test("I9: a line of about 1 MB of unclosed openers is read and converted in 5 seconds", () => {
  for (const s of longLines()) {
    const t0 = performance.now();
    parseMarkdown(s);
    mdToGm(s, "blank-line");
    const ms = performance.now() - t0;
    assert.ok(ms < 5000, `${JSON.stringify(s.slice(0, 6))}… took ${Math.round(ms)} ms`);
  }
});

// Three-way merge by lines (docs/adr/0063): base is the content last read or written,
// ours the editor's, theirs the disk's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchLines, merge3, resolve, type Choice } from "./merge3.ts";

const lines = (...xs: string[]) => xs.join("\n");
const merged = (base: string, ours: string, theirs: string) => {
  const r = merge3(base, ours, theirs);
  return r.conflicts === 0 ? resolve(r.chunks, []) : null;
};

test("a change on one side only is taken; the same change on both sides once", () => {
  const base = lines("a", "b", "c", "d", "e");
  assert.equal(merged(base, lines("A", "b", "c", "d", "e"), lines("a", "b", "c", "d", "E")), lines("A", "b", "c", "d", "E"));
  assert.equal(merged(base, lines("a", "B", "c", "d", "e"), lines("a", "B", "c", "d", "e")), lines("a", "B", "c", "d", "e"));
  assert.equal(merged(base, base, lines("a", "x", "e")), lines("a", "x", "e"));
  assert.equal(merged(base, lines("a", "x", "e"), base), lines("a", "x", "e"));
});

test("both sides changing one place differently is a conflict holding base, ours and theirs", () => {
  const r = merge3(lines("a", "b", "c"), lines("a", "ours", "c"), lines("a", "theirs", "c"));
  assert.equal(r.conflicts, 1);
  assert.deepEqual(r.chunks, [
    { t: "ok", lines: ["a"] },
    { t: "conflict", base: ["b"], ours: ["ours"], theirs: ["theirs"] },
    { t: "ok", lines: ["c"] },
  ]);
});

test("one side adds while the other removes elsewhere; adjacent changes; the first and last lines", () => {
  const base = lines("a", "b", "c", "d");
  assert.equal(merged(base, lines("a", "b", "new", "c", "d"), lines("b", "c", "d")), lines("b", "new", "c", "d"));
  assert.equal(merged(base, lines("A", "b", "c", "d"), lines("a", "b", "c", "D")), lines("A", "b", "c", "D"));
  // changes on neighbouring lines with no line between them meet in one place
  const adj = merge3(lines("a", "b", "c", "d"), lines("a", "B", "c", "d"), lines("a", "b", "C", "d"));
  assert.equal(adj.conflicts, 1);
});

test("empty files and the final newline", () => {
  assert.equal(merged("", "", "x"), "x");
  assert.equal(merged("", "y", ""), "y");
  assert.equal(merged("a\n", "a\nb\n", "a\n"), "a\nb\n");
  assert.equal(merged("a\nb\n", "a\nb\n", "a\nb"), "a\nb");
  assert.equal(merge3("", "x", "y").conflicts, 1);
});

test("choices: each conflict takes theirs, ours, or both (ours first)", () => {
  const r = merge3(lines("a", "b", "c", "d"), lines("a", "B1", "c", "D1"), lines("a", "B2", "c", "D2"));
  assert.equal(r.conflicts, 2);
  const pick = (c: Choice[]) => resolve(r.chunks, c);
  assert.equal(pick(["ours", "theirs"]), lines("a", "B1", "c", "D2"));
  assert.equal(pick(["theirs", "both"]), lines("a", "B2", "c", "D1", "D2"));
  // a choice not given is ours
  assert.equal(pick([]), lines("a", "B1", "c", "D1"));
});

test("matchLines: the longest common subsequence of lines, in order", () => {
  const m = matchLines(["a", "b", "c", "d"], ["x", "a", "c", "y", "d"]);
  assert.deepEqual([...m], [1, -1, 2, 4]);
  assert.deepEqual([...matchLines([], ["a"])], []);
  assert.deepEqual([...matchLines(["a"], [])], [-1]);
});

// a seeded pseudo-random generator (mulberry32)
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test("10,000 random triples: no conflict keeps every line only one side changed; equal sides give the other", () => {
  const r = rng(63);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  for (let n = 0; n < 10_000; n++) {
    const base = Array.from({ length: Math.floor(r() * 8) }, (_, i) => `l${i}`);
    const edit = (tag: string) => {
      const out = [...base];
      const k = Math.floor(r() * 3);
      for (let j = 0; j < k; j++) {
        const at = Math.floor(r() * (out.length + 1));
        const op = pick(["add", "del", "chg"]);
        if (op === "add") out.splice(at, 0, `${tag}${n}-${j}`);
        else if (op === "del" && at < out.length) out.splice(at, 1);
        else if (at < out.length) out[at] = `${tag}${n}-${j}`;
      }
      return out;
    };
    const ours = edit("o");
    const theirs = edit("t");
    const b = base.join("\n");
    const o = ours.join("\n");
    const t = theirs.join("\n");
    assert.equal(resolve(merge3(b, b, t).chunks, []), t);
    assert.equal(resolve(merge3(b, o, b).chunks, []), o);
    const m = merge3(b, o, t);
    if (m.conflicts === 0) {
      const out = resolve(m.chunks, []).split("\n");
      for (const l of [...ours, ...theirs]) if (!base.includes(l)) assert.ok(out.includes(l), `${l} lost: ${JSON.stringify({ b, o, t })}`);
    }
  }
});

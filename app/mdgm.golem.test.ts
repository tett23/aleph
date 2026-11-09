// The invariants of the conversion to gm that golem decides (docs/adr/0061): I2, I4, I5 and I6, on the
// boundary inputs and 2,000 generated ones, in both paragraph styles. In CI a missing golem fails them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToGm } from "./mdgm.ts";
import { BOUNDARY, checkAll, generate, golemBin, golemSkip, golemVisible, mdVisible, multiset, rng } from "./mdgm.testlib.ts";

const golem = golemBin();
const ctx = { dir: "chapters", resolveEmbed: () => null };

test("I2 I4 I5: golem check reads every result, the visible characters stay, the same in both styles", { skip: golemSkip(golem) }, () => {
  assert.ok(golem, "golem is needed in CI (scripts/bundle-tools.sh)");
  const r = rng(61);
  const mds = [...BOUNDARY, ...Array.from({ length: 2000 }, () => generate(r))];
  const docs = mds.flatMap((md) => (["blank-line", "line"] as const).map((sep) => ({ md, sep, gm: mdToGm(md, sep, ctx) })));
  const res = checkAll(golem, docs);
  res.forEach((x, k) => {
    const d = docs[k];
    assert.deepEqual(x.errors, [], `I2 ${d.sep} ${JSON.stringify(d.md)} → ${JSON.stringify(d.gm)}`);
    assert.equal(multiset(golemVisible(x.text ?? "")), multiset(mdVisible(d.md, ctx.dir)), `I4 ${d.sep} ${JSON.stringify(d.md)} → ${JSON.stringify(d.gm)}`);
  });
  for (let k = 0; k < res.length; k += 2) assert.equal(multiset(golemVisible(res[k].text ?? "")), multiset(golemVisible(res[k + 1].text ?? "")), `I5 ${JSON.stringify(docs[k].md)}`);
});

test("I6: a soft break between two non-CJK characters is a space; next to a CJK character it is none", { skip: golemSkip(golem) }, () => {
  const cases: [string, string][] = [
    ["hello\nworld\n", "hello world"],
    ["日本\n語の文\n", "日本語の文"],
    ["word\n日本語\nword\n", "word日本語word"],
    ["**a\nb**\n", "a b"],
    ["- one\n  two\n", "one two"],
  ];
  const docs = cases.flatMap(([md]) => (["blank-line", "line"] as const).map((sep) => ({ md, sep, gm: mdToGm(md, sep, ctx) })));
  const res = checkAll(golem!, docs);
  res.forEach((x, k) => assert.ok((x.text ?? "").includes(cases[Math.floor(k / 2)][1]), `${docs[k].sep} ${JSON.stringify(docs[k].gm)} → ${JSON.stringify(x.text)}`));
});

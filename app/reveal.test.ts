import { test } from "node:test";
import assert from "node:assert/strict";
import { revealItems, tabTarget } from "./reveal.ts";
import type { Doc, Tab } from "./store.ts";

const doc = (path: string) => ({ path }) as Doc;

test("a sheet tab shows its focused sheet", () => {
  const t: Tab = { id: 1, open: [doc("/w/p/a.gm"), doc("/w/p/b.gm")], focus: 1, plot: null };
  assert.equal(tabTarget(t), "/w/p/b.gm");
});

test("a plot tab shows the project's plot.csv", () => {
  assert.equal(tabTarget({ id: 1, open: [], focus: 0, plot: "/w/p" }), "/w/p/plot.csv");
});

test("an empty tab shows nothing", () => {
  assert.equal(tabTarget({ id: 1, open: [], focus: 0, plot: null }), null);
});

test("the menu offers Finder for files and folders alike", () => {
  const shown: string[] = [];
  for (const p of ["/w/p/a.gm", "/w/p"]) {
    const items = revealItems(p, (x) => shown.push(x));
    assert.equal(items.length, 1);
    const it = items[0];
    assert.ok(it !== "-");
    assert.equal(it.label, "Finder で表示");
    it.run();
  }
  assert.deepEqual(shown, ["/w/p/a.gm", "/w/p"]);
});

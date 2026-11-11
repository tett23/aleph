// Tabs and the split (docs/adr/0024): the state's panes and tabs, with `open`,
// `focus` and `plot` kept as the selected tab's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allDocs, closeTarget, dropMissing, initialState, readTabs, reduce, writeTabs, type Action, type Doc, type State } from "./store.ts";

const doc = (path: string, text = ""): Doc => ({
  path,
  kind: path.split(".").pop()!,
  text,
  saved: text,
  project: "/w/p",
  workspace: "/w",
  grid: { chars: 38, lines: 16, vertical: false },
});

const run = (actions: Action[], from: State = initialState()) => actions.reduce(reduce, from);
const paths = (s: State) => s.panes.map((p) => p.tabs.map((t) => (t.plot ? `plot:${t.plot}` : t.open.map((d) => d.path).join("+"))));
const A = "/w/a.md", B = "/w/b.md", C = "/w/c.md";
const ch1 = "/w/p/01.gm", ch2 = "/w/p/02.gm";

test("opening replaces the selected tab; a new tab goes after it", () => {
  let s = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)] }]);
  assert.deepEqual(paths(s), [[B]]);
  s = run([{ type: "open", docs: [doc(C)], newTab: true }], s);
  assert.deepEqual(paths(s), [[B, C]]);
  assert.equal(s.panes[0].active, 1);
  assert.deepEqual(s.open.map((d) => d.path), [C]);
});

test("a sheet open in a tab is selected there instead of opened again", () => {
  const s = run([
    { type: "open", docs: [doc(A)] },
    { type: "open", docs: [doc(B)], newTab: true },
    { type: "open", docs: [doc(A)] },
  ]);
  assert.deepEqual(paths(s), [[A, B]]);
  assert.equal(s.panes[0].active, 0);
  assert.equal(s.open[0].path, A);
});

test("a chapter of chapters opened together selects their tab and moves to it", () => {
  const s = run([
    { type: "open", docs: [doc(ch1), doc(ch2)] },
    { type: "open", docs: [doc(A)], newTab: true },
    { type: "open", docs: [doc(ch2)] },
  ]);
  assert.deepEqual(paths(s), [[`${ch1}+${ch2}`, A]]);
  assert.equal(s.panes[0].active, 0);
  assert.equal(s.focus, 1);
});

test("a sheet open in the other pane selects that pane", () => {
  const s = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "split" }, { type: "selectPane", pane: 0 }, { type: "open", docs: [doc(B)] }]);
  assert.equal(s.pane, 1);
  assert.equal(s.open[0].path, B);
});

test("the plot opens as a tab, and an open plot is selected again", () => {
  let s = run([{ type: "open", docs: [doc(A)] }, { type: "plot", project: "/w/p", newTab: true }]);
  assert.deepEqual(paths(s), [[A, "plot:/w/p"]]);
  assert.equal(s.plot, "/w/p");
  assert.deepEqual(s.open, []);
  s = run([{ type: "selectTab", pane: 0, index: 0 }, { type: "plot", project: "/w/p" }], s);
  assert.equal(s.panes[0].active, 1);
});

test("closing a tab selects the one to its right, or else to its left", () => {
  const base = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "open", docs: [doc(C)], newTab: true }]);
  let s = run([{ type: "selectTab", pane: 0, index: 1 }, { type: "closeTab", pane: 0, index: 1 }], base);
  assert.deepEqual(paths(s), [[A, C]]);
  assert.equal(s.open[0].path, C);
  s = run([{ type: "closeTab", pane: 0, index: 2 }], base);
  assert.equal(s.open[0].path, B);
  // a tab left of the selected one: the selection stays on the same tab
  s = run([{ type: "closeTab", pane: 0, index: 0 }], base);
  assert.equal(s.open[0].path, C);
});

test("closing the last tab leaves an empty pane; `close` closes the selected tab", () => {
  const s = run([{ type: "open", docs: [doc(A)] }, { type: "close" }]);
  assert.deepEqual(paths(s), [[]]);
  assert.deepEqual(s.open, []);
  assert.equal(s.plot, null);
});

test("closing the right pane's last tab ends the split", () => {
  const s = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "split" }, { type: "closeTab", pane: 1, index: 0 }]);
  assert.equal(s.panes.length, 1);
  assert.equal(s.pane, 0);
  assert.equal(s.open[0].path, A);
});

test("the sheets to save when a tab closes are its sheets with changes", () => {
  const s = run([{ type: "open", docs: [doc(ch1), doc(ch2)] }, { type: "edit", path: ch2, text: "x" }]);
  assert.deepEqual(closeTarget(s, 0, 0).map((d) => d.path), [ch2]);
  assert.deepEqual(closeTarget(s, 0, 5), []);
});

test("⌃Tab and ⌃⇧Tab go round the tabs; ⌘1–9 pick one, out of range does nothing", () => {
  const base = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "open", docs: [doc(C)], newTab: true }]);
  assert.equal(run([{ type: "cycleTab", dir: 1 }], base).panes[0].active, 0);
  assert.equal(run([{ type: "cycleTab", dir: -1 }], base).panes[0].active, 1);
  assert.equal(run([{ type: "selectTab", pane: 0, index: 0 }], base).open[0].path, A);
  assert.equal(run([{ type: "selectTab", pane: 0, index: 8 }], base), base);
});

test("tabs move within a pane and to the other pane, the moved tab selected", () => {
  const base = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "open", docs: [doc(C)], newTab: true }]);
  let s = run([{ type: "moveTab", from: { pane: 0, index: 2 }, to: { pane: 0, index: 0 } }], base);
  assert.deepEqual(paths(s), [[C, A, B]]);
  assert.equal(s.open[0].path, C);
  s = run([{ type: "split" }, { type: "moveTab", from: { pane: 0, index: 0 }, to: { pane: 1, index: 1 } }], base);
  assert.deepEqual(paths(s), [[B], [C, A]]);
  assert.equal(s.pane, 1);
  assert.equal(s.open[0].path, A);
});

test("splitting moves the selected tab to a new right pane and selects it", () => {
  const s = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "split" }]);
  assert.deepEqual(paths(s), [[A], [B]]);
  assert.equal(s.pane, 1);
  assert.equal(s.open[0].path, B);
  // the right panel follows the selected pane
  assert.equal(run([{ type: "selectPane", pane: 0 }], s).open[0].path, A);
  // a pane of one tab is not split
  const one = run([{ type: "open", docs: [doc(A)] }]);
  assert.equal(run([{ type: "split" }], one), one);
});

test("edits, saves and renames reach the sheets of every tab", () => {
  let s = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc("/w/d/x.md")], newTab: true }, { type: "selectTab", pane: 0, index: 0 }]);
  s = run([{ type: "edit", path: "/w/d/x.md", text: "y" }], s);
  assert.equal(allDocs(s).find((d) => d.path === "/w/d/x.md")?.text, "y");
  s = run([{ type: "rename", from: "/w/d", to: "/w/e" }], s);
  assert.deepEqual(allDocs(s).map((d) => d.path), [A, "/w/e/x.md"]);
});

test("ADR 0070 invariant 4: renaming an ancestor keeps descendant edits, tabs, and plot paths", () => {
  let s = run([
    { type: "open", docs: [{ ...doc("/w/book/chapters/01.gm"), project: "/w/book" }] },
    { type: "edit", path: "/w/book/chapters/01.gm", text: "unfinished" },
    { type: "plot", project: "/w/book", newTab: true },
    { type: "rename", from: "/w/book", to: "/w/novel" },
  ]);
  assert.equal(s.panes[0].tabs[0].open[0].path, "/w/novel/chapters/01.gm");
  assert.equal(s.panes[0].tabs[0].open[0].text, "unfinished");
  assert.equal(s.panes[0].tabs[0].open[0].project, "/w/novel");
  assert.equal(s.panes[0].tabs[1].plot, "/w/novel");
  s = run([{ type: "rename", from: "/w/novel/chapters", to: "/w/novel/drafts" }], s);
  assert.equal(s.panes[0].tabs[0].open[0].path, "/w/novel/drafts/01.gm");
  assert.equal(s.panes[0].tabs[0].open[0].text, "unfinished");
});

test("the tabs are written to ui and read back; missing sheets are dropped", () => {
  const s = run([
    { type: "open", docs: [doc(ch1), doc(ch2)] },
    { type: "open", docs: [doc(A)], newTab: true },
    { type: "plot", project: "/w/p", newTab: true },
    { type: "selectTab", pane: 0, index: 1 },
  ]);
  const w = writeTabs(s);
  assert.deepEqual(readTabs(JSON.parse(JSON.stringify(w))), w);
  assert.deepEqual(w, { pane: 0, panes: [{ active: 1, tabs: [{ paths: [ch1, ch2], focus: 0 }, { paths: [A], focus: 0 }, { plot: "/w/p" }] }] });
  const kept = dropMissing(w, (p) => p !== A);
  assert.deepEqual(kept, { pane: 0, panes: [{ active: 1, tabs: [{ paths: [ch1, ch2], focus: 0 }, { plot: "/w/p" }] }] });
  assert.equal(readTabs({ panes: "x" }), null);
  assert.equal(readTabs(undefined), null);
});

test("a tab keeps its id through edits and renames, and a replaced tab gets a new one", () => {
  let s = run([{ type: "open", docs: [doc("/w/d/x.md")] }]);
  const id = s.panes[0].tabs[0].id;
  s = run([{ type: "edit", path: "/w/d/x.md", text: "y" }, { type: "rename", from: "/w/d", to: "/w/e" }], s);
  assert.equal(s.panes[0].tabs[0].id, id);
  s = run([{ type: "open", docs: [doc(A)] }], s);
  assert.notEqual(s.panes[0].tabs[0].id, id);
  const r = run([{ type: "restoreTabs", panes: [{ active: 0, tabs: [{ open: [doc(A)], focus: 0, plot: null }, { open: [], focus: 0, plot: "/w/p" }] }], pane: 0 }]);
  assert.equal(new Set(r.panes[0].tabs.map((t) => t.id)).size, 2);
  assert.equal(r.open[0].path, A);
});

test("a workspace switch empties the panes", () => {
  const s = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "split" }, { type: "workspace", path: "/v" }]);
  assert.deepEqual(paths(s), [[]]);
  assert.equal(s.pane, 0);
});

test("focusing a sheet's editor selects its pane and tab and follows that sheet", () => {
  const s = run([{ type: "open", docs: [doc(ch1), doc(ch2)] }, { type: "open", docs: [doc(A)], newTab: true }, { type: "split" }, { type: "focusDoc", path: ch2 }]);
  assert.equal(s.pane, 0);
  assert.equal(s.focus, 1);
  assert.equal(s.open[1].path, ch2);
  assert.equal(run([{ type: "focusDoc", path: "/none" }], s), s);
});

test("split again moves the selected tab to the end of the other pane and selects it (docs/adr/0037)", () => {
  const s = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "open", docs: [doc(C)], newTab: true }, { type: "split" }, { type: "selectPane", pane: 0 }, { type: "split" }]);
  assert.deepEqual(paths(s), [[A], [C, B]]);
  assert.equal(s.pane, 1);
  assert.equal(s.open[0].path, B);
});

test("the left pane emptied, by closing or by moving, ends the split too (docs/adr/0037)", () => {
  const split = run([{ type: "open", docs: [doc(A)] }, { type: "open", docs: [doc(B)], newTab: true }, { type: "split" }]);
  let s = run([{ type: "closeTab", pane: 0, index: 0 }], split);
  assert.deepEqual(paths(s), [[B]]);
  assert.equal(s.pane, 0);
  assert.equal(s.open[0].path, B);
  s = run([{ type: "moveTab", from: { pane: 0, index: 0 }, to: { pane: 1, index: 1 } }], split);
  assert.deepEqual(paths(s), [[B, A]]);
  assert.equal(s.open[0].path, A);
});

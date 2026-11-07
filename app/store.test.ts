import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, dirty, focused, initialState, reduce, type Action, type Doc, type State } from "./store.ts";

const doc = (path: string, text = ""): Doc => ({
  path,
  kind: path.split(".").pop()!,
  text,
  saved: text,
  project: "/w/p",
  workspace: "/w",
  grid: { chars: 38, lines: 16, vertical: true },
});

const run = (actions: Action[], from: State = initialState()) => actions.reduce(reduce, from);

test("opening one sheet is an array of one, and expands the folders down to it", () => {
  const s = run([{ type: "open", docs: [doc("/w/p/chapters/01.gm")] }]);
  assert.equal(s.open.length, 1);
  assert.equal(focused(s)?.path, "/w/p/chapters/01.gm");
  assert.deepEqual(s.expanded.sort(), ["/w/p", "/w/p/chapters"]);
  assert.equal(s.anchor, "/w/p/chapters/01.gm");
});

test("opening several sheets selects them and focuses the first", () => {
  const s = run([{ type: "open", docs: [doc("/w/p/chapters/01.gm"), doc("/w/p/chapters/02.gm")] }]);
  assert.equal(s.open.length, 2);
  assert.equal(s.focus, 0);
  assert.deepEqual(s.selected, ["/w/p/chapters/01.gm", "/w/p/chapters/02.gm"]);
});

test("focus moves only within the open sheets", () => {
  const two = run([{ type: "open", docs: [doc("/a.gm"), doc("/b.gm")] }]);
  assert.equal(run([{ type: "focus", index: 1 }], two).focus, 1);
  assert.equal(run([{ type: "focus", index: 5 }], two).focus, 0);
});

test("editing and saving change only that sheet", () => {
  const s = run([
    { type: "open", docs: [doc("/a.gm", "x"), doc("/b.gm", "y")] },
    { type: "edit", path: "/b.gm", text: "y2" },
  ]);
  assert.equal(dirty(s.open[0]), false);
  assert.equal(dirty(s.open[1]), true);
  const saved = run([{ type: "saved", path: "/b.gm", text: "y2" }], s);
  assert.equal(dirty(saved.open[1]), false);
});

test("closing clears the sheets and the selection", () => {
  const s = run([{ type: "open", docs: [doc("/a.gm"), doc("/b.gm")] }, { type: "close" }]);
  assert.deepEqual(s.open, []);
  assert.deepEqual(s.selected, []);
});

test("renaming follows the open sheet, the selection and the anchor", () => {
  const s = run([{ type: "open", docs: [doc("/a.gm")] }, { type: "rename", from: "/a.gm", to: "/c.gm" }]);
  assert.equal(s.open[0].path, "/c.gm");
  assert.equal(s.anchor, "/c.gm");
});

test("the same left icon twice folds the sidebar; another opens it", () => {
  const s1 = run([{ type: "left", panel: "files" }]);
  assert.equal(s1.showLeft, false);
  const s2 = run([{ type: "left", panel: "search" }], s1);
  assert.equal(s2.showLeft, true);
  assert.equal(s2.left, "search");
});

test("panels and switches", () => {
  const s = run([
    { type: "right", panel: "outline" },
    { type: "toggleRight" },
    { type: "side", side: "pages" },
    { type: "vertical", on: true },
  ]);
  assert.equal(s.right, "outline");
  assert.equal(s.showRight, false);
  assert.equal(s.side, "pages");
  assert.equal(s.vertical, true);
});

test("workspaces keep the current one when it is still registered", () => {
  const s = run([{ type: "workspaces", workspaces: ["/a", "/b"] }, { type: "workspace", path: "/b" }]);
  assert.equal(run([{ type: "workspaces", workspaces: ["/b", "/c"] }], s).workspace, "/b");
  assert.equal(run([{ type: "workspaces", workspaces: ["/c"] }], s).workspace, "/c");
});

test("switching the workspace closes the sheets", () => {
  const s = run([{ type: "open", docs: [doc("/w/p/a.gm")] }, { type: "workspace", path: "/x" }]);
  assert.deepEqual(s.open, []);
});

test("the plot replaces the sheets", () => {
  const s = run([{ type: "open", docs: [doc("/w/p/a.gm")] }, { type: "plot", project: "/w/p" }]);
  assert.equal(s.plot, "/w/p");
  assert.deepEqual(s.open, []);
});

test("expanding is idempotent and collapsing all clears", () => {
  const s = run([
    { type: "expand", path: "/w/p", on: true },
    { type: "expand", path: "/w/p", on: true },
  ]);
  assert.deepEqual(s.expanded, ["/w/p"]);
  assert.deepEqual(run([{ type: "collapseAll" }], s).expanded, []);
});

test("the store notifies only on change", () => {
  const store = createStore();
  let calls = 0;
  store.subscribe(() => calls++);
  store.dispatch({ type: "focus", index: 3 }); // no sheet: no change
  store.dispatch({ type: "side", side: "plain" });
  assert.equal(calls, 1);
});

test("selecting sets the rows; the anchor stays unless one is given", () => {
  const a = run([{ type: "select", paths: ["/w/a.gm"], anchor: "/w/a.gm" }]);
  assert.deepEqual([a.selected, a.anchor], [["/w/a.gm"], "/w/a.gm"]);
  const b = run([{ type: "select", paths: ["/w/a.gm", "/w/b.gm"] }], a);
  assert.deepEqual([b.selected, b.anchor], [["/w/a.gm", "/w/b.gm"], "/w/a.gm"]);
  const c = run([{ type: "select", paths: [], anchor: null }], b);
  assert.deepEqual([c.selected, c.anchor], [[], null]);
});

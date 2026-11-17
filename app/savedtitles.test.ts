import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState, reduce, type Action, type Doc, type State } from "./store.ts";
import { readTitleOnSave } from "./savedtitles.ts";

const doc = (path: string, text = ""): Doc => ({
  path,
  kind: path.split(".").pop()!,
  text,
  saved: text,
  project: "/w/p",
  workspace: "/w",
  grid: { chars: 38, lines: 16, vertical: true },
});

const open = (...docs: Doc[]): State => reduce(initialState(), { type: "open", docs });

/** Runs one action through the reducer and the title reading, counting the redraws and the treeReloaded runs. */
const step = async (s: State, a: Action, titles: Map<string, string>) => {
  const n = { redraw: 0, reloaded: 0 };
  const next = reduce(s, a);
  const changed = await readTitleOnSave(next, s, a, titles, { redraw: () => void n.redraw++, reloaded: () => void n.reloaded++ });
  return { s: next, n, changed };
};

test("ADR 0079 I1, I3: a heading rewritten and saved becomes the name; one redraw and one treeReloaded run", async () => {
  const titles = new Map([["/w/a.md", "節構成"]]);
  const r = await step(open(doc("/w/a.md", "# 節構成\n本文")), { type: "saved", path: "/w/a.md", text: "# 章構成\n本文" }, titles);
  assert.equal(titles.get("/w/a.md"), "章構成");
  assert.deepEqual(r.n, { redraw: 1, reloaded: 1 });
  assert.equal(r.changed, true);
});

test("ADR 0079 I1, I3: a gm heading is read with the same titleOf as the tree", async () => {
  const titles = new Map([["/w/p/01.gm", "一"]]);
  const r = await step(open(doc("/w/p/01.gm", "# 一\n")), { type: "saved", path: "/w/p/01.gm", text: "# 二[note]\n" }, titles);
  assert.equal(titles.get("/w/p/01.gm"), "二");
  assert.deepEqual(r.n, { redraw: 1, reloaded: 1 });
});

test("ADR 0079 I1, I3: a heading removed and saved drops the name, so the row shows the file name", async () => {
  const titles = new Map([["/w/a.md", "節構成"]]);
  const r = await step(open(doc("/w/a.md", "# 節構成\n本文")), { type: "saved", path: "/w/a.md", text: "本文" }, titles);
  assert.equal(titles.has("/w/a.md"), false);
  assert.deepEqual(r.n, { redraw: 1, reloaded: 1 });
});

test("ADR 0079 I1, I3: a heading written into a sheet without one and saved becomes the name", async () => {
  const titles = new Map<string, string>();
  const r = await step(open(doc("/w/a.md", "本文")), { type: "saved", path: "/w/a.md", text: "# 一\n本文" }, titles);
  assert.equal(titles.get("/w/a.md"), "一");
  assert.deepEqual(r.n, { redraw: 1, reloaded: 1 });
});

test("ADR 0079 I1, I3: only the body after the heading changed keeps the name and draws nothing", async () => {
  const titles = new Map([["/w/a.md", "章構成"]]);
  const r = await step(open(doc("/w/a.md", "# 章構成\n本文")), { type: "saved", path: "/w/a.md", text: "# 章構成\n別の本文" }, titles);
  assert.equal(titles.get("/w/a.md"), "章構成");
  assert.deepEqual(r.n, { redraw: 0, reloaded: 0 });
  assert.equal(r.changed, false);
});

test("ADR 0079 I3: saving the same text draws nothing", async () => {
  const titles = new Map([["/w/a.md", "章構成"]]);
  const r = await step(open(doc("/w/a.md", "# 章構成\n本文")), { type: "saved", path: "/w/a.md", text: "# 章構成\n本文" }, titles);
  assert.equal(titles.get("/w/a.md"), "章構成");
  assert.deepEqual(r.n, { redraw: 0, reloaded: 0 });
});

test("ADR 0079 I1: an empty sheet saved has no name", async () => {
  const titles = new Map([["/w/a.md", "古い"]]);
  await step(open(doc("/w/a.md", "# 古い")), { type: "saved", path: "/w/a.md", text: "" }, titles);
  assert.equal(titles.has("/w/a.md"), false);
  const none = new Map<string, string>();
  const r = await step(open(doc("/w/b.md", "x")), { type: "saved", path: "/w/b.md", text: "" }, none);
  assert.equal(none.has("/w/b.md"), false);
  assert.deepEqual(r.n, { redraw: 0, reloaded: 0 });
});

test("ADR 0079 I4: a heading rewritten but not saved keeps the old name", async () => {
  const titles = new Map([["/w/a.md", "節構成"]]);
  const r = await step(open(doc("/w/a.md", "# 節構成\n本文")), { type: "edit", path: "/w/a.md", text: "# 章構成\n本文" }, titles);
  assert.equal(titles.get("/w/a.md"), "節構成");
  assert.deepEqual(r.n, { redraw: 0, reloaded: 0 });
});

test("ADR 0079 I2: with two sheets open, saving one leaves the other's name", async () => {
  const titles = new Map([
    ["/w/a.md", "甲"],
    ["/w/b.md", "乙"],
  ]);
  let s = open(doc("/w/a.md", "# 甲"), doc("/w/b.md", "# 乙"));
  // the other sheet has an unsaved new heading; it must not be read
  s = reduce(s, { type: "edit", path: "/w/b.md", text: "# 丙" });
  const r = await step(s, { type: "saved", path: "/w/a.md", text: "# 丁" }, titles);
  assert.equal(titles.get("/w/a.md"), "丁");
  assert.equal(titles.get("/w/b.md"), "乙");
  assert.deepEqual(r.n, { redraw: 1, reloaded: 1 });
});

test("ADR 0079 I2: the saved of manifest.toml leaves the titles as they are", async () => {
  const titles = new Map([["/w/p/01.gm", "一"]]);
  const before = [...titles];
  const r = await step(open(doc("/w/p/manifest.toml", "chapters = []\n")), { type: "saved", path: "/w/p/manifest.toml", text: '# heading-like comment\nchapters = ["01.gm"]\n' }, titles);
  assert.deepEqual([...titles], before);
  assert.equal(titles.has("/w/p/manifest.toml"), false);
  assert.deepEqual(r.n, { redraw: 0, reloaded: 0 });
});

test("ADR 0079 I1: a saved that takes in text changed outside gives that text's heading", async () => {
  const titles = new Map([["/w/a.md", "前"]]);
  // the watcher takes in the disk's text: the editor's text and saved both become it (app/watchmount.ts)
  let s = open(doc("/w/a.md", "# 前"));
  s = reduce(s, { type: "edit", path: "/w/a.md", text: "# 外" });
  const r = await step(s, { type: "saved", path: "/w/a.md", text: "# 外" }, titles);
  assert.equal(titles.get("/w/a.md"), "外");
  assert.deepEqual(r.n, { redraw: 1, reloaded: 1 });
});

test("ADR 0079 I2: a saved of a sheet that is not open changes nothing", async () => {
  const titles = new Map([["/w/a.md", "甲"]]);
  const r = await step(open(doc("/w/a.md", "# 甲")), { type: "saved", path: "/w/z.md", text: "# 乙" }, titles);
  assert.deepEqual([...titles], [["/w/a.md", "甲"]]);
  assert.equal(titles.has("/w/z.md"), false);
  assert.deepEqual(r.n, { redraw: 0, reloaded: 0 });
});

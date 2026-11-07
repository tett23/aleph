import { test } from "node:test";
import assert from "node:assert/strict";
import { goalOf, metaFor, parseMeta, renameKey, writeMeta } from "./notes.ts";

test("reading: no file, the current form, and the old form with several notes", () => {
  assert.deepEqual(parseMeta(""), {});
  assert.deepEqual(parseMeta("not json"), {});
  assert.deepEqual(parseMeta('{"a.gm":{"goal":900,"note":"x","done":["d"]}}'), { "a.gm": { goal: 900, note: "x", done: ["d"] } });
  assert.deepEqual(parseMeta('{"a.gm":{"notes":[{"text":"一"},{"text":"二"}],"done":[]}}'), { "a.gm": { note: "一\n\n二", done: [] } });
});

test("writing leaves out empty entries and reads back the same", () => {
  const m = { "a.gm": { note: "x", done: ["d"], goal: 500 }, "b.gm": { note: "", done: [] } };
  const text = writeMeta(m);
  assert.deepEqual(parseMeta(text), { "a.gm": m["a.gm"] });
});

test("an entry for a sheet that has none yet", () => {
  assert.deepEqual(metaFor({}, "a.gm"), { note: "", done: [] });
});

test("renaming moves the key", () => {
  const m = { "chapters/01.gm": { note: "x", done: [] } };
  assert.deepEqual(renameKey(m, "chapters/01.gm", "chapters/01-霧笛.gm"), { "chapters/01-霧笛.gm": { note: "x", done: [] } });
  assert.deepEqual(renameKey(m, "nope.gm", "x.gm"), m);
});

test("the goal: the one set by hand, else the plot's planned characters, else none", () => {
  assert.deepEqual(goalOf(1200, 900), { goal: 1200, from: "hand" });
  assert.deepEqual(goalOf(undefined, 900), { goal: 900, from: "plot" });
  assert.deepEqual(goalOf(undefined, null), { goal: null, from: null });
});

test("keywords are read and written; an empty list is left out; renaming carries them (docs/adr/0028)", () => {
  assert.deepEqual(parseMeta('{"a.gm":{"note":"","done":[],"keywords":["父","灯台",3]}}'), { "a.gm": { note: "", done: [], keywords: ["父", "灯台"] } });
  assert.deepEqual(parseMeta('{"a.gm":{"note":"","done":[],"keywords":[]}}'), {});
  const m = { "a.gm": { note: "", done: [], keywords: ["父"] }, "b.gm": { note: "", done: [], keywords: [] } };
  assert.deepEqual(parseMeta(writeMeta(m)), { "a.gm": { note: "", done: [], keywords: ["父"] } });
  assert.deepEqual(renameKey(m, "a.gm", "c.gm")["c.gm"].keywords, ["父"]);
});

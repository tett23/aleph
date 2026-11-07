import { test } from "node:test";
import assert from "node:assert/strict";
import { expired, parseEntry, removeNotes, restoreNotes, type Entry } from "./trash.ts";

test("notes: taken out by key and put back; an existing key is not overwritten", () => {
  const meta = { "chapters/01.gm": { note: "a", done: [] }, "chapters/02.gm": { note: "b", done: [] }, "notes/x.md": { note: "c", done: [] } };
  const r = removeNotes(meta, ["chapters/01.gm", "chapters/02.gm"]);
  assert.deepEqual(Object.keys(r.meta), ["notes/x.md"]);
  assert.deepEqual(r.removed, { "chapters/01.gm": { note: "a", done: [] }, "chapters/02.gm": { note: "b", done: [] } });
  const back = restoreNotes({ ...r.meta, "chapters/02.gm": { note: "new", done: [] } }, r.removed, (k) => k);
  assert.deepEqual(back["chapters/01.gm"], { note: "a", done: [] });
  assert.deepEqual(back["chapters/02.gm"], { note: "new", done: [] });
  // put back under a new name
  assert.deepEqual(Object.keys(restoreNotes({}, { "a.gm": { note: "a", done: [] } }, () => "a-2.gm")), ["a-2.gm"]);
});

test("entries past 30 days, the boundary included", () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 30);
  const e = (id: string, at: number): Entry => ({ id, original: `/w/${id}`, deletedAt: at, workspace: "/w", kind: "sheet", chapters: null, notes: null });
  assert.deepEqual(expired([e("old", now - 31 * day), e("edge", now - 30 * day), e("new", now - 29 * day)], now).map((x) => x.id), ["old", "edge"]);
});

test("entry.json: read back as written; broken ones are skipped", () => {
  const e: Entry = { id: "20261108-120000-1", original: "/w/p/chapters/01.gm", deletedAt: 1, workspace: "/w", kind: "sheet", chapters: { project: "/w/p", removed: [{ index: [0], text: '"chapters/01.gm"' }] }, notes: { root: "/w/p", removed: { "chapters/01.gm": { note: "a", done: [] } } } };
  assert.deepEqual(parseEntry(JSON.stringify(e)), e);
  assert.equal(parseEntry("{"), null);
  assert.equal(parseEntry('{"id":1}'), null);
});

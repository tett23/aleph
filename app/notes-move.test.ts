import assert from "node:assert/strict";
import { test } from "node:test";
import { planMoveMetadata } from "./notes-move.ts";

const workspace = "/w";
const projects = ["/w/a", "/w/b", "/w/collection/c"];
const moving = { note: "未保存を先に書き出したメモ", goal: 800, done: ["見直し"], future: { extra: true } };

test("ADR 0100 I4, I5: migrate cross-project notes and goals without duplicating them", () => {
  const from = JSON.stringify({ "chapters/draft/one.gm": moving, "chapters/keep.gm": { goal: 10 } });
  const to = JSON.stringify({ "existing.gm": { goal: 20 } });
  const result = planMoveMetadata(workspace, "/w/a/chapters/draft", "/w/b/materials/draft", projects, new Map([
    ["/w/a", from], ["/w/b", to],
  ]));
  assert.deepEqual(result.map(({ path, before, after }) => ({ path, before, after: JSON.parse(after) })), [
    { path: "/w/a/.aleph/notes.json", before: from, after: { "chapters/keep.gm": { goal: 10 } } },
    { path: "/w/b/.aleph/notes.json", before: to, after: { "existing.gm": { goal: 20 }, "materials/draft/one.gm": moving } },
  ]);
});

test("ADR 0100 I2, I3: stale metadata at the destination stops a physical move", () => {
  const documents = new Map([
    ["/w/a", JSON.stringify({ "x.gm": moving })],
    ["/w/b", JSON.stringify({ "x.gm": { goal: 99 } })],
  ]);
  assert.throws(() => planMoveMetadata(workspace, "/w/a/x.gm", "/w/b/x.gm", projects, documents), /\/w\/b\/x\.gm/);
});

test("ADR 0100 I4, I5: moving an ancestor of a project preserves its relative notes store", () => {
  const original = JSON.stringify({ "collection/outside.gm": moving });
  const result = planMoveMetadata(workspace, "/w/collection", "/w/boxes/collection", projects, new Map([
    [workspace, original], ["/w/collection/c", JSON.stringify({ "inside.gm": moving })],
  ]));
  assert.deepEqual(result.map(({ path, after }) => [path, JSON.parse(after)]), [
    ["/w/.aleph/notes.json", { "boxes/collection/outside.gm": moving }],
  ]);
});

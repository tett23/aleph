import assert from "node:assert/strict";
import test from "node:test";
import { applyFileRenamePlans, planFileRename, type FileEditPlan } from "./file-rename.ts";
import { uriOf } from "./protocol.ts";

const root = "/w/book";
const uri = (path: string) => uriOf(`${root}/${path}`);
const edit = (path: string, version: number | null, edits: { line: number; start: number; end: number; text: string }[]) => ({
  textDocument: { uri: uri(path), version },
  edits: edits.map(({ line, start, end, text }) => ({ range: { start: { line, character: start }, end: { line, character: end } }, newText: text })),
});

test("Golem ADR 0338 R2: repeated identical edits apply once; separate occurrences remain", () => {
  const snapshots = new Map([[`${root}/a.gm`, { text: "a.gm a.gm", version: 7 }]]);
  const result = planFileRename(root, { documentChanges: [edit("a.gm", 7, [
    { line: 0, start: 0, end: 4, text: "b.gm" },
    { line: 0, start: 0, end: 4, text: "b.gm" },
    { line: 0, start: 5, end: 9, text: "b.gm" },
  ])] }, snapshots);
  assert.equal(result.length, 1);
  assert.equal(result[0].changes.length, 2);
  assert.equal(result[0].after, "b.gm b.gm");
});

test("Golem ADR 0338 R2: stale versions and conflicting ranges are rejected", () => {
  const snapshots = new Map([[`${root}/a.gm`, { text: "a.gm", version: 8 }]]);
  assert.throws(() => planFileRename(root, { documentChanges: [edit("a.gm", 7, [{ line: 0, start: 0, end: 4, text: "b.gm" }])] }, snapshots));
  assert.throws(() => planFileRename(root, { documentChanges: [edit("a.gm", 8, [
    { line: 0, start: 0, end: 4, text: "b.gm" },
    { line: 0, start: 0, end: 4, text: "c.gm" },
  ])] }, snapshots));
});

test("Golem ADR 0338 R2: outside paths, invalid ranges and RenameFile are rejected", () => {
  const snapshots = new Map([[`${root}/a.gm`, { text: "a.gm", version: null }]]);
  assert.throws(() => planFileRename(root, { documentChanges: [edit("../outside.gm", null, [{ line: 0, start: 0, end: 4, text: "b.gm" }])] }, snapshots));
  assert.throws(() => planFileRename(root, { documentChanges: [edit("a.gm", null, [{ line: 0, start: 0, end: 9, text: "b.gm" }])] }, snapshots));
  assert.throws(() => planFileRename(root, { documentChanges: [{ kind: "rename", oldUri: uri("a.gm"), newUri: uri("b.gm") }] }, snapshots));
});

test("Golem ADR 0338 R3: an application failure rolls back only applied documents", async () => {
  const files = new Map([["a", "old a"], ["b", "old b"]]);
  const plans: FileEditPlan[] = [
    { path: "a", before: "old a", after: "new a", version: null, changes: [] },
    { path: "b", before: "old b", after: "new b", version: null, changes: [] },
  ];
  await assert.rejects(() => applyFileRenamePlans(plans, {
    read: async (path) => files.get(path)!,
    write: async (path, text) => { if (path === "b") throw new Error("disk failure"); files.set(path, text); },
  }));
  assert.deepEqual([...files], [["a", "old a"], ["b", "old b"]]);
});

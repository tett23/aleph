import assert from "node:assert/strict";
import test from "node:test";
import type { Entry } from "./api.ts";
import { moveProject, orderProjectEntries, projectNeighbors } from "./project-order.ts";
import { workspaceRows } from "./workspace.ts";
import { normalize } from "./config.ts";

const f = (path: string): Entry => ({ path, name: path.split("/").at(-1)!, dir: false, children: [] });
const d = (path: string, children: Entry[]): Entry => ({ path, name: path.split("/").at(-1)!, dir: true, children });
const project = (path: string, children: Entry[] = []) => d(path, [f(`${path}/manifest.toml`), ...children]);
const tree = [
  d("/w/collection", [project("/w/collection/A", [f("/w/collection/A/a.gm")]), d("/w/collection/notes", []), project("/w/collection/B")]),
  d("/w/drafts", [project("/w/drafts/A")]),
];
const known = new Set(["/w/collection/A", "/w/collection/B", "/w/drafts/A"]);
const paths = (entries: Entry[]) => entries.map((e) => e.path);

 test("ADR 0074 invariant 1: only adjacent sibling project slots exchange", () => {
  assert.deepEqual(projectNeighbors("/w", tree, known, {}, "/w/collection/A"), { up: null, down: "/w/collection/B" });
  const order = moveProject("/w", tree, known, {}, "/w/collection/A", "down");
  assert.deepEqual(paths(orderProjectEntries("/w", tree, known, order)[0].children), ["/w/collection/B", "/w/collection/notes", "/w/collection/A"]);
  assert.deepEqual(projectNeighbors("/w", tree, known, order, "/w/collection/B"), { up: null, down: "/w/collection/A" });
  assert.deepEqual(projectNeighbors("/w", tree, known, order, "/w/collection/A"), { up: "/w/collection/B", down: null });
  assert.deepEqual(projectNeighbors("/w", tree, known, order, "/w/drafts/A"), { up: null, down: null });
  assert.deepEqual(projectNeighbors("/w", tree, known, order, "/w"), { up: null, down: null });
  assert.deepEqual(projectNeighbors("/w", [d("/w/folder", [])], new Set(), {}, "/w/folder"), { up: null, down: null });
 });

 test("ADR 0074 invariant 2: child rows retain parents, expansion and selection are unchanged", () => {
  const order = moveProject("/w", tree, known, {}, "/w/collection/A", "down");
  const ordered = orderProjectEntries("/w", tree, known, order);
  const expanded = new Set(["/w/collection", "/w/collection/A", "/w/drafts"]);
  const selected = ["/w/collection/A/a.gm"];
  const rows = workspaceRows("/w", ordered, expanded, () => [], known);
  assert.deepEqual(rows.filter((r) => r.t === "dir" && r.project).map((r) => r.entry.path), ["/w/collection/B", "/w/collection/A", "/w/drafts/A"]);
  assert.equal(rows.filter((r) => r.entry.path === selected[0]).length, 1);
  assert.deepEqual([...expanded], ["/w/collection", "/w/collection/A", "/w/drafts"]);
  assert.deepEqual(selected, ["/w/collection/A/a.gm"]);
 });

 test("ADR 0074 invariant 3: config restores each workspace independently and appends new projects", () => {
  const saved = moveProject("/w", tree, known, {}, "/w/collection/A", "down");
  const restored = normalize({ projectOrder: saved }).projectOrder;
  const changed = [d("/w/collection", [project("/w/collection/A"), d("/w/collection/notes", []), project("/w/collection/C")])];
  const changedKnown = new Set(["/w/collection/A", "/w/collection/C"]);
  assert.deepEqual(paths(orderProjectEntries("/w", changed, changedKnown, restored)[0].children), ["/w/collection/A", "/w/collection/notes", "/w/collection/C"]);
  const other = [project("/v/A"), project("/v/B")];
  assert.deepEqual(paths(orderProjectEntries("/v", other, new Set(paths(other)), restored)), paths(other));
 });

test("ADR 0074 invariant 1: invisible projects are not menu destinations and inherited keys are ignored", () => {
  const onlyA = [project("/w/collection/A")];
  const visible = [d("/w/collection", onlyA)];
  const allKnown = new Set(["/w/collection/A", "/w/collection/B"]);
  assert.deepEqual(projectNeighbors("/w", visible, allKnown, { "/w": { collection: ["collection/B", "collection/A"] } }, "/w/collection/A"), { up: null, down: null });
  const special = [d("/w/constructor", [project("/w/constructor/A"), project("/w/constructor/B")])];
  const specialKnown = new Set(["/w/constructor/A", "/w/constructor/B"]);
  const inherited = { "/w": {} } as Record<string, Record<string, string[]>>;
  assert.deepEqual(paths(orderProjectEntries("/w", special, specialKnown, inherited)[0].children), ["/w/constructor/A", "/w/constructor/B"]);
  assert.deepEqual(projectNeighbors("/w", special, specialKnown, inherited, "/w/constructor/A"), { up: null, down: "/w/constructor/B" });
});

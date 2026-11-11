import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entry } from "./api.ts";
import { OPEN_KINDS, TEXT_KINDS, collectProjects, projectsIn, workspaceRows, kindOf, projectOf, readGrid, titleOf, treeRows, workspaceOf } from "./workspace.ts";

const f = (path: string): Entry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), dir: false, children: [] });
const d = (path: string, children: Entry[]): Entry => ({ path, name: path.slice(path.lastIndexOf("/") + 1), dir: true, children });

const tree: Entry[] = [
  d("/w/notes", [f("/w/notes/a.md"), f("/w/notes/x.bin")]),
  d("/w/novel", [
    d("/w/novel/chapters", [f("/w/novel/chapters/01.gm"), f("/w/novel/chapters/02.gm"), f("/w/novel/chapters/99.gm")]),
    d("/w/novel/inner", [f("/w/novel/inner/manifest.toml")]),
    f("/w/novel/manifest.toml"),
    f("/w/novel/plot.csv"),
    f("/w/novel/style.toml"),
  ]),
  d("/w/group", [d("/w/group/short", [f("/w/group/short/manifest.toml")])]),
];

test("projects at any depth, but not inside a project", () => {
  assert.deepEqual(collectProjects(tree), ["/w/novel", "/w/group/short"]);
});

test("project and workspace of a path", () => {
  assert.equal(projectOf("/w/novel/chapters/01.gm", ["/w/novel"]), "/w/novel");
  assert.equal(projectOf("/w/novelx/a.gm", ["/w/novel"]), null);
  assert.equal(workspaceOf("/w/a/b.gm", ["/w", "/w/a"]), "/w/a");
  assert.equal(workspaceOf("/x/b.gm", ["/w"]), null);
});

test("kinds", () => {
  assert.equal(kindOf("/a/b.mermaid"), "mmd");
  assert.equal(kindOf("/a/b.GM"), "gm");
});

test("tree rows: chapters first in the manifest's order, then the plot, then the rest", () => {
  const rows = treeRows(tree, new Set(["/w/novel", "/w/novel/chapters", "/w/notes"]), () => ["/w/novel/chapters/02.gm", "/w/novel/chapters/01.gm"]);
  const names = rows.map((r) => (r.t === "dir" ? `${r.entry.name}/` : r.entry.name) + (r.t === "file" && r.plot ? "*" : ""));
  assert.deepEqual(names, ["notes/", "a.md", "novel/", "plot.csv*", "chapters/", "02.gm", "01.gm", "99.gm", "inner/", "manifest.toml", "style.toml", "group/"]);
  const novel = rows.find((r) => r.t === "dir" && r.entry.name === "novel");
  assert.equal(novel?.t === "dir" && novel.project, true);
});

test("a chapters folder remains visible when it contains only registered chapters", () => {
  const t = [d("/w/p", [d("/w/p/chapters", [f("/w/p/chapters/01.gm")]), f("/w/p/manifest.toml")])];
  const rows = treeRows(t, new Set(["/w/p", "/w/p/chapters"]), () => ["/w/p/chapters/01.gm"]);
  assert.deepEqual(rows.map((r) => r.entry.name), ["p", "chapters", "01.gm", "manifest.toml"]);
});

test("files Aleph does not open are not shown", () => {
  const rows = treeRows(tree, new Set(["/w/notes"]), () => []);
  assert.ok(!rows.some((r) => r.entry.name === "x.bin"));
});

test("titles: the first heading, without commands, outside code blocks", () => {
  assert.equal(titleOf("gm", "@import a.emet as a\n\n# [ruby: 霧笛|むてき] の [= a.x(1)]夜\n"), "霧笛 の 夜");
  assert.equal(titleOf("gm", "```\n# not\n```\n## 本当\n"), "本当");
  assert.equal(titleOf("md", "text\n# あとがき #\n"), "あとがき");
  assert.equal(titleOf("gm", "本文だけ\n"), null);
  assert.equal(titleOf("toml", "# comment\n"), null);
});

test("grid: characters and lines in [page.grid], writing-mode in [page]", () => {
  const style = `[page]\nsize = "A6"\nwriting-mode = "vertical"\n\n[page.grid]\nfont-size = "12.5Q"\ncharacters = 38\nlines = 16\n\n[fonts.body]\nlines = 99\n`;
  assert.deepEqual(readGrid(style), { chars: 38, lines: 16, vertical: true });
  assert.deepEqual(readGrid(`[page]\nwriting-mode = "horizontal"\n`), { chars: 40, lines: 16, vertical: false });
  assert.deepEqual(readGrid(`[page.grid]\ncharacters = 30\n[other]\nwriting-mode = "vertical"\n`), { chars: 30, lines: 16, vertical: false });
});

import { selectChapters } from "./workspace.ts";

test("shift selects the range from the anchor in the tree's order", () => {
  const rows = ["/a.gm", "/b.gm", "/c.gm", "/d.gm"];
  assert.deepEqual(selectChapters(rows, [], "/b.gm", "/d.gm", "range"), ["/b.gm", "/c.gm", "/d.gm"]);
  assert.deepEqual(selectChapters(rows, [], "/d.gm", "/b.gm", "range"), ["/b.gm", "/c.gm", "/d.gm"]);
});

test("cmd adds and removes one, keeping the tree's order", () => {
  const rows = ["/a.gm", "/b.gm", "/c.gm"];
  assert.deepEqual(selectChapters(rows, [], "/c.gm", "/a.gm", "toggle"), ["/a.gm", "/c.gm"]);
  assert.deepEqual(selectChapters(rows, ["/a.gm", "/c.gm"], "/c.gm", "/a.gm", "toggle"), ["/c.gm"]);
});

test("without an anchor among the rows, the click alone", () => {
  assert.deepEqual(selectChapters(["/a.gm"], [], null, "/a.gm", "range"), ["/a.gm"]);
  assert.deepEqual(selectChapters(["/a.gm", "/b.gm"], [], "/x.md", "/b.gm", "range"), ["/b.gm"]);
});

test("JSON, JSONC, JSON5 and JSON Lines open as text, are shown in the tree and searched (docs/adr/0021)", () => {
  for (const k of ["json", "jsonc", "json5", "jsonl"]) {
    assert.equal(kindOf(`/w/a.${k}`), k);
    assert.equal(TEXT_KINDS.includes(k), true, k);
    assert.equal(OPEN_KINDS.includes(k), true, k);
  }
  assert.equal(kindOf("/w/A.JSON"), "json");
});

// a workspace whose root is itself a Golem project (the manifest at the top)
const rootTree: Entry[] = [
  d("/r/chapters", [f("/r/chapters/01.gm")]),
  d("/r/inner", [f("/r/inner/manifest.toml")]),
  f("/r/manifest.toml"),
  f("/r/style.toml"),
];

test("a workspace whose root holds manifest.toml is the project, and nothing inside it is", () => {
  assert.deepEqual(projectsIn("/r", rootTree), ["/r"]);
  assert.deepEqual(projectsIn("/w", tree), ["/w/novel", "/w/group/short"]);
});

test("the tree of a root project: its row first, then its chapters in order", () => {
  const rows = workspaceRows("/r", rootTree, new Set(), () => ["/r/chapters/01.gm"]);
  assert.equal(rows[0].t, "dir");
  assert.equal(rows[0].entry.path, "/r");
  assert.equal(rows[1].entry.path, "/r/chapters");
  assert.equal(rows[2].entry.path, "/r/inner");
  assert.equal(rows[0].project, true);
  assert.ok(rows.slice(1).every((r) => r.depth === 1));
  assert.deepEqual(workspaceRows("/w", tree, new Set(), () => []), treeRows(tree, new Set(), () => []));
});

test("ADR 0067 invariant 1: registered chapters stay under their actual parent once", () => {
  const nested = [d("/w/p", [d("/w/p/chapters", [d("/w/p/chapters/part", [f("/w/p/chapters/part/a.gm")])]), f("/w/p/manifest.toml")])];
  const rows = treeRows(nested, new Set(["/w/p", "/w/p/chapters", "/w/p/chapters/part"]), () => ["/w/p/chapters/part/a.gm"]);
  assert.deepEqual(rows.map((r) => [r.entry.path, r.depth]), [
    ["/w/p", 0], ["/w/p/chapters", 1], ["/w/p/chapters/part", 2],
    ["/w/p/chapters/part/a.gm", 3], ["/w/p/manifest.toml", 1],
  ]);
  assert.equal(rows.filter((r) => r.entry.path.endsWith("a.gm")).length, 1);
  const collapsed = treeRows(nested, new Set(["/w/p"]), () => ["/w/p/chapters/part/a.gm"]);
  assert.deepEqual(collapsed.map((r) => r.entry.path), ["/w/p", "/w/p/chapters", "/w/p/manifest.toml"]);
});

test("ADR 0067 invariant 1: registered siblings follow manifest order, then plot", () => {
  const nested = [d("/w/p", [f("/w/p/b.gm"), f("/w/p/plot.csv"), f("/w/p/a.gm"), f("/w/p/manifest.toml")])];
  const rows = treeRows(nested, new Set(["/w/p"]), () => ["/w/p/a.gm", "/w/p/b.gm"]);
  assert.deepEqual(rows.map((r) => r.entry.name), ["p", "a.gm", "b.gm", "plot.csv", "manifest.toml"]);
});

test("ADR 0067 invariant 1: a known project stays a project when its manifest is hidden by display settings", () => {
  const visible = [d("/w/book", [f("/w/book/plot.csv"), d("/w/book/chapters", [f("/w/book/chapters/a.gm")])])];
  const rows = workspaceRows("/w", visible, new Set(["/w/book", "/w/book/chapters"]), () => ["/w/book/chapters/a.gm"], new Set(["/w/book"]));
  assert.equal(rows[0].t, "dir");
  assert.equal(rows[0].project, true);
  assert.equal(rows[1].t, "file");
  assert.equal(rows[1].plot, true);
  assert.equal(rows[3].project, "/w/book");
});

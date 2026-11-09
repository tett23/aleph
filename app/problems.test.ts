import { test } from "node:test";
import assert from "node:assert/strict";
import { countProblems, fromGolem, groupProblems, panelHeight, type Problem } from "./problems.ts";

const p = (file: string | null, line: number | null, message: string, severity: Problem["severity"] = "error", source = "golem"): Problem => ({
  file,
  line,
  col: line === null ? null : 1,
  severity,
  message,
  source,
  code: "",
});

test("problems are grouped by file: the focused sheet first, the others by relative path, the ones without a place last", () => {
  const g = groupProblems([p("/w/p/b.gm", 1, "b"), p(null, null, "nowhere"), p("/w/p/a.gm", 2, "a"), p("/w/p/z.gm", 1, "z")], "/w/p/z.gm", "/w");
  assert.deepEqual(
    g.map((x) => [x.file, x.label]),
    [
      ["/w/p/z.gm", "p/z.gm"],
      ["/w/p/a.gm", "p/a.gm"],
      ["/w/p/b.gm", "p/b.gm"],
      [null, "（位置のない診断）"],
    ],
  );
});

test("a file's problems are in line and column order", () => {
  const list = [p("/w/a.gm", 9, "nine"), { ...p("/w/a.gm", 2, "two-b"), col: 5 }, p("/w/a.gm", 2, "two-a")];
  assert.deepEqual(
    groupProblems(list, null, "/w")[0].items.map((x) => x.message),
    ["two-a", "two-b", "nine"],
  );
});

test("the same message at the same place of the same file is shown once", () => {
  const g = groupProblems([p("/w/a.gm", 2, "same", "error", "golem"), p("/w/a.gm", 2, "same", "error", "check"), p("/w/a.gm", 2, "other")], null, "/w");
  assert.deepEqual(
    g[0].items.map((x) => x.message),
    ["same", "other"],
  );
});

test("problems are counted by severity", () => {
  assert.deepEqual(countProblems([p("/a", 1, "e"), p("/a", 2, "w", "warning"), p("/a", 3, "i", "info"), p("/a", 4, "e2")]), { errors: 2, warnings: 1, others: 1 });
});

test("golem's results become problems under the project, notices and infos as others", () => {
  const out = fromGolem("/w/p", "lint", [
    { code: "G03120", severity: "notice", message: "n", span: { file: "manifest.toml", line: 1, column: 1 } },
    { code: "G09014", severity: "error", message: "e" },
  ]);
  assert.deepEqual(out, [
    { file: "/w/p/manifest.toml", line: 1, col: 1, severity: "info", message: "n", source: "lint", code: "G03120" },
    { file: null, line: null, col: null, severity: "error", message: "e", source: "lint", code: "G09014" },
  ]);
});

test("the panel's height is kept between its bounds, and a malformed value is the default", () => {
  assert.equal(panelHeight(300, 1000), 300);
  assert.equal(panelHeight(20, 1000), 80);
  assert.equal(panelHeight(900, 1000), 700);
  assert.equal(panelHeight("big", 1000), 220);
  assert.equal(panelHeight(Number.NaN, 1000), 220);
  // a short column still gets the minimum
  assert.equal(panelHeight(300, 100), 80);
});

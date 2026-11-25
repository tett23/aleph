import assert from "node:assert/strict";
import { test } from "node:test";
import { countProblems, emptyText, filterGroups, groupProblems, nextFilter, type Problem } from "./problems.ts";

const p = (file: string | null, line: number, severity: Problem["severity"], message = `${severity} ${line}`): Problem => ({
  file, line, col: 1, severity, message, source: "golem", code: "",
});

const mixed = [
  p("/w/a.gm", 3, "warning"), p("/w/a.gm", 1, "error"), p("/w/a.gm", 2, "info"),
  p("/w/b.gm", 1, "error"), p("/w/b.gm", 5, "warning"), p(null, 0, "info"),
];

test("ADR 0110 I1: without a filter the list is the list as it was", () => {
  const groups = groupProblems(mixed, "/w/a.gm", "/w");
  assert.deepEqual(filterGroups(groups, null), groups);
  assert.deepEqual(filterGroups([], null), []);
});

test("ADR 0110 I2, I4: with no diagnostics a filter gives an empty list and zero counts", () => {
  assert.deepEqual(filterGroups([], "error"), []);
  assert.deepEqual(countProblems([]), { errors: 0, warnings: 0, others: 0 });
  assert.equal(emptyText("error"), "エラーはありません");
  assert.equal(emptyText(null), "問題はありません");
});

test("ADR 0110 I2, I3: one error under an error filter is kept; under a warning filter the list is empty", () => {
  const groups = groupProblems([p("/w/a.gm", 1, "error")], null, "/w");
  assert.deepEqual(filterGroups(groups, "error").flatMap((g) => g.items), [p("/w/a.gm", 1, "error")]);
  assert.deepEqual(filterGroups(groups, "warning"), []);
  assert.equal(emptyText("warning"), "警告はありません");
  assert.equal(emptyText("info"), "そのほかの問題はありません");
});

test("ADR 0110 I4: the counts come from every diagnostic, whatever the filter", () => {
  const groups = groupProblems([p("/w/a.gm", 1, "error")], null, "/w");
  filterGroups(groups, "warning");
  assert.deepEqual(countProblems(groups.flatMap((g) => g.items)), { errors: 1, warnings: 0, others: 0 });
});

test("ADR 0110 I2, I3: a filter keeps every item of its severity in order, drops empty files, and counts what it shows", () => {
  const groups = groupProblems(mixed, "/w/a.gm", "/w");
  for (const severity of ["error", "warning", "info"] as const) {
    const shown = filterGroups(groups, severity);
    const expected = groups.flatMap((g) => g.items).filter((x) => x.severity === severity);
    assert.deepEqual(shown.flatMap((g) => g.items), expected, severity);
    for (const g of shown) {
      assert.ok(g.items.length > 0);
      assert.ok(g.items.every((x) => x.severity === severity));
      const whole = groups.find((w) => w.file === g.file)!;
      assert.equal(g.label, whole.label);
    }
  }
  assert.deepEqual(filterGroups(groups, "warning").map((g) => [g.file, g.items.length]), [["/w/a.gm", 1], ["/w/b.gm", 1]]);
});

test("ADR 0110 I2: the same warning at the same place is shown once under a warning filter", () => {
  const twice = [p("/w/a.gm", 1, "warning", "same"), p("/w/a.gm", 1, "warning", "same")];
  assert.equal(filterGroups(groupProblems(twice, null, "/w"), "warning").flatMap((g) => g.items).length, 1);
});

test("ADR 0110 I5: pressing the filter's own severity clears it; any other sets it", () => {
  const all = [null, "error", "warning", "info"] as const;
  for (const now of all)
    for (const pressed of ["error", "warning", "info"] as const)
      assert.equal(nextFilter(now, pressed), now === pressed ? null : pressed, `${now} ${pressed}`);
});

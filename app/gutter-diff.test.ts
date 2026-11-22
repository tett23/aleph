import { test } from "node:test";
import assert from "node:assert/strict";
import { compareLines, markAtLine } from "./diff.ts";
import { characterSpans } from "./difftab/characters.ts";
import { snapshotDiff } from "./difftab/snapshot.ts";
import { hoverBounds, hoverPosition } from "./ed/diff-hover-placement.ts";

test("ADR 0104 I1: a marked run retains its before and after text", () => {
  const changed = compareLines("a\nb\nc", "a\nB1\nB2\nc");
  const first = markAtLine(changed, 1);
  assert.equal(first[0], markAtLine(changed, 2)[0]);
  assert.deepEqual(first.map(({ before, after }) => [before, after]), [[["b"], ["B1", "B2"]]]);
  assert.deepEqual(compareLines(false, "a").marks.size, 0);
  assert.deepEqual(compareLines(null, "").marks.size, 0);
  assert.deepEqual(markAtLine(compareLines(null, "a"), 0)[0].before, []);
});

test("ADR 0104 I1: trailing and entire deletions are addressable, including coinciding runs", () => {
  assert.deepEqual(markAtLine(compareLines("a\nb", "a"), 0)[0].before, ["b"]);
  assert.deepEqual(markAtLine(compareLines("a\nb", ""), 0)[0].after, []);
  assert.deepEqual(markAtLine(compareLines("a\nx\nb", "x"), 0).map((r) => r.before), [["a"], ["b"]]);
});

test("ADR 0104 I1: coarse comparison retains both middles", () => {
  const before = Array.from({ length: 2001 }, (_, i) => "a" + i);
  const after = before.map((x) => x.replace("a", "b"));
  const result = compareLines(before.join("\n"), after.join("\n"));
  assert.deepEqual(markAtLine(result, 101)[0].before, before);
  assert.deepEqual(markAtLine(result, 101)[0].after, after);
});

test("ADR 0104 I5: code-point spans reconstruct Japanese, emoji, combining marks, and apparent HTML", () => {
  const before = "いろは🐱a\u0301<script>";
  const after = "いろほ🐶a\u0300<script>";
  const spans = characterSpans(before, after);
  assert.deepEqual(spans.filter((s) => s.kind !== "added").map((s) => s.text).join(""), before);
  assert.deepEqual(spans.filter((s) => s.kind !== "removed").map((s) => s.text).join(""), after);
  assert.ok(spans.some((s) => s.kind === "removed" && s.text.includes("🐱")));
  assert.ok(spans.some((s) => s.kind === "added" && s.text.includes("🐶")));
});

test("ADR 0104 I6: rendering limits include headings and retain a target after 2000 rows", () => {
  const base = Array.from({ length: 9 }, (_, i) => "base" + i).concat("target");
  const now = Array(5000).fill("changed").concat(base.slice(0, -1), "found");
  const comparison = compareLines(base.join("\n"), now.join("\n"));
  const result = snapshotDiff(base.join("\n"), now.join("\n"), comparison.runs, markAtLine(comparison, now.length - 1));
  assert.equal(result.lines.length, 2000);
  assert.ok(result.omittedBefore > 0);
  assert.equal(result.omittedAfter, 0);
  assert.ok(result.lines.slice(result.target).some((line) => line.kind === "text" && line.spans.some((s) => s.text.includes("found"))));

  for (const count of [1998, 1999]) {
    const now = Array.from({ length: count }, (_, i) => "a" + i).join("\n");
    const c = compareLines(null, now);
    const result = snapshotDiff(null, now, c.runs, c.runs);
    assert.equal(result.lines.length, 2000);
    assert.equal(result.omittedBefore, 0);
    assert.equal(result.omittedAfter, count - 1998);
  }
});

test("ADR 0104 I7: frame bounds clamp and flip in both axes using visual offsets", () => {
  const bounds = hoverBounds({ left: 20, top: 30, width: 100, height: 60 })!;
  assert.deepEqual(bounds, { left: 28, top: 38, right: 112, bottom: 82, width: 84, height: 44 });
  assert.deepEqual(hoverPosition(bounds, { left: 90, top: 60, right: 100, bottom: 70 }, 50, 20), { left: 40, top: 40 });
  assert.deepEqual(hoverPosition(bounds, { left: 90, top: 60, right: 100, bottom: 70 }, 84, 44), { left: 28, top: 38 });
  assert.equal(hoverPosition(bounds, { left: 90, top: 60, right: 100, bottom: 70 }, 85, 44), null);
  assert.equal(hoverBounds({ left: 0, top: 0, width: 0, height: 20 }), null);
  assert.equal(hoverBounds({ left: 0, top: 0, width: 20, height: 6 })?.height, 3);
});

test("ADR 0104 I3: invalidation and a newer HEAD read discard older results", async () => {
  const { createDiffSource } = await import("./ed/diff-source.ts");
  const pending: ((text: string) => void)[] = [];
  const source = createDiffSource(() => new Promise((resolve) => pending.push(resolve)));
  const older = source.get(false)();
  const newer = source.get(true)();
  pending[1]("new");
  assert.equal(await newer, "new");
  pending[0]("old");
  assert.equal(await older, undefined);
  const destroyed = source.get(true)();
  source.invalidate();
  pending[2]("late");
  assert.equal(await destroyed, undefined);
});

test("ADR 0104 I1, I3, A3: one tab retains the clicked text, and old reloads cannot replace a new target", async () => {
  const { initialState, reduce } = await import("./store.ts");
  const result = compareLines("before", "unsaved");
  const first = { base: "before", text: "unsaved", runs: result.runs, selected: result.runs, line: 0, path: "/work/test.md", workspace: "/work" };
  let state = reduce(initialState(), { type: "workspace", path: "/work" });
  state = reduce(state, { type: "showDiff", snapshot: first });
  const tab = () => state.panes.flatMap((p) => p.tabs).find((t) => t.diff)!;
  assert.equal(tab().snapshot?.text, "unsaved");
  const id = tab().id;
  const second = { ...first, path: "/work/test2.md" };
  state = reduce(state, { type: "showDiff", snapshot: second });
  assert.equal(tab().id, id);
  state = reduce(state, { type: "replaceDiffSnapshot", previous: first, snapshot: { ...first, text: "late" } });
  assert.equal(tab().snapshot, second);
  state = reduce(state, { type: "showDiff" });
  assert.equal(tab().snapshot, undefined);
});

test("ADR 0104 I5, I7: a very long changed line retains both coarse middles and its common ends", async () => {
  const { snapshotCharacterSpans } = await import("./difftab/snapshot.ts");
  const before = "猫".repeat(50_000);
  const after = "犬".repeat(50_000);
  assert.deepEqual(snapshotCharacterSpans(`前${before}後`, `前${after}後`), [
    { kind: "same", text: "前" },
    { kind: "removed", text: before },
    { kind: "added", text: after },
    { kind: "same", text: "後" },
  ]);
});

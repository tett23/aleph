import assert from "node:assert/strict";
import { test } from "node:test";
import { runManuscript, type ManuscriptRange } from "./manuscript.ts";

test("ADR 0117 I3: visit every chapter in order when a 200,000-character manuscript must split", async () => {
  const chapters = [
    { file: "one.gm", text: "あ".repeat(99_999) + "甲" },
    { file: "two.gm", text: "い".repeat(99_998) + "乙😀" },
  ];
  const ordered: string[] = [];
  const answer = await runManuscript(chapters, async (ranges, reconciliation) => {
    if (reconciliation) {
      assert.equal(reconciliation.length, 2);
      return { explanation: "照合済み", edits: [] };
    }
    if (ranges.length > 1) throw Error("コンテキスト上限を超えました");
    ordered.push(ranges[0].file);
    const find = ranges[0].file === "one.gm" ? "甲" : "乙😀";
    return { explanation: "確認", edits: [{ file: ranges[0].file, find, replace: "訂正" }] };
  }, () => {});
  assert.deepEqual(ordered, ["one.gm", "two.gm"]);
  assert.deepEqual(answer.chapters.map((c) => c.edits[0]?.find), ["甲", "乙😀"]);
  assert.deepEqual(answer.failed, []);
  assert.equal(answer.reconciliation, "照合済み");
});

test("ADR 0117 I3: missing ranges are reported and the source file is never guessed", async () => {
  const visited: ManuscriptRange[] = [];
  const answer = await runManuscript([{ file: "a.gm", text: "😀甲\n\n😀乙" }], async (ranges, reconcile) => {
    if (reconcile) return { explanation: "", edits: [] };
    const range = ranges[0];
    if (range.text.length > 5) throw Error("コンテキスト上限を超えました");
    visited.push(range);
    if (range.text.includes("甲")) throw Error("時間切れ");
    return { explanation: "", edits: [{ file: "b.gm", find: "乙", replace: "丙" }] };
  }, () => {});
  assert.equal(visited.map((r) => r.text).join(""), "😀甲\n\n😀乙");
  assert.equal(answer.failed.length, 1);
  assert.equal(answer.chapters[0].edits.length, 0);
  assert.match(answer.rejected[0], /b\.gm/);
});

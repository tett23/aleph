import { test } from "node:test";
import assert from "node:assert/strict";
import { filterGroups, groupProblems, problemsCopyText, type Problem } from "./problems.ts";
import { copyDisplayedText, displayedSections } from "./ui/copy-displayed-text.ts";

test("ADR 0114 I2: copy the filtered groups in their visible order", () => {
  const warning: Problem = { file: "/w/b.gm", line: 2, col: null, severity: "warning", message: "一行目\n二行目", source: "lint", code: "G001" };
  const groups = groupProblems([
    warning,
    { ...warning, file: "/w/a.gm", line: 1, severity: "error" },
    { ...warning, file: null, line: null, source: "", code: "", message: "位置なし" },
  ], null, "/w");
  assert.equal(problemsCopyText(filterGroups(groups, "warning")), "b.gm\n警告 lint G001 [2, 1] 一行目\n二行目\n\n（位置のない診断）\n警告 位置なし");
  assert.equal(problemsCopyText(filterGroups(groups, "info")), "");
});

test("ADR 0114 I3, I4: keep visible content in section order with its internal whitespace", () => {
  assert.equal(displayedSections(["第一章\n  code", "", "第二章"]), "第一章\n  code\n\n第二章");
  assert.equal(displayedSections(["説明", "+ 追加\n…\n- 削除"]), "説明\n\n+ 追加\n…\n- 削除");
});

test("ADR 0114 I5: write once and notify once for each completed copy", async () => {
  const texts: string[] = [];
  const notices: { level: string; message: string }[] = [];
  const notify = (notice: { level: string; message: string }) => { notices.push(notice); };
  await copyDisplayedText("本文", async (text) => { texts.push(text); }, notify);
  await copyDisplayedText("不可", async (text) => { texts.push(text); throw new Error("pasteboard"); }, notify);
  await copyDisplayedText("", async (text) => { texts.push(text); }, notify);
  assert.deepEqual(texts, ["本文", "不可"]);
  assert.deepEqual(notices, [
    { level: "info", message: "コピーしました" },
    { level: "error", message: "コピーできませんでした" },
  ]);
});

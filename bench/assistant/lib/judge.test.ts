import { test } from "node:test";
import assert from "node:assert/strict";
import { errorsIn, judgeCommand, judgeEdit, judgeGolem, parseAnswer } from "./judge.ts";

const target = 'line-pitch = "20H"\nlines = 16\n';
const expected = ['line-pitch = "22H"\nlines = 16\n'];

test("ADR 0081 judging: a right rewrite passes", () => {
  const v = judgeEdit(target, { explanation: "", edits: [{ find: '"20H"', replace: '"22H"' }] }, expected);
  assert.equal(v.pass, true);
});

test("ADR 0081 judging: any of the expected texts passes", () => {
  const v = judgeEdit("a", { explanation: "", edits: [{ find: "a", replace: "c" }] }, ["b", "c"]);
  assert.equal(v.pass, true);
});

test("ADR 0081 judging: a rewrite that applies but gives another text fails", () => {
  const v = judgeEdit(target, { explanation: "", edits: [{ find: '"20H"', replace: '"24H"' }] }, expected);
  assert.equal(v.pass, false);
  assert.match(v.reason, /正解と違います/);
});

test("ADR 0081 judging: a rewrite that does not apply fails (I1)", () => {
  const v = judgeEdit(target, { explanation: "", edits: [{ find: "18H", replace: "22H" }] }, expected);
  assert.equal(v.pass, false);
  assert.match(v.reason, /適用できません/);
});

test("ADR 0081 judging: no edits on a rewrite task fail", () => {
  assert.equal(judgeEdit(target, { explanation: "広げます", edits: [] }, expected).pass, false);
});

test("ADR 0081 judging: a command named by its id or its label passes, with no edits", () => {
  assert.equal(judgeCommand({ explanation: "project.build を使います", edits: [] }, "project.build", "ビルド").pass, true);
  assert.equal(judgeCommand({ explanation: "コマンド「ビルド」で組めます", edits: [] }, "project.build", "ビルド").pass, true);
});

test("ADR 0081 judging: a command answer with edits, or naming another command, fails", () => {
  assert.equal(judgeCommand({ explanation: "project.build", edits: [{ find: "a", replace: "b" }] }, "project.build", "ビルド").pass, false);
  assert.equal(judgeCommand({ explanation: "保存してください", edits: [] }, "project.build", "ビルド").pass, false);
});

test("ADR 0081 judging: the answer must have the shape of the schema", () => {
  assert.equal(parseAnswer('{"explanation":"x","edits":[]}').ok, true);
  assert.equal(parseAnswer("not json").ok, false);
  assert.equal(parseAnswer('{"edits":[]}').ok, false);
  assert.equal(parseAnswer('{"explanation":"x","edits":[{"find":1,"replace":"a"}]}').ok, false);
  assert.equal(parseAnswer("[]").ok, false);
});

test("ADR 0081 judging: errors of golem check are counted in the target file only", () => {
  const diags = [
    { severity: "error", span: { file: "style.toml" } },
    { severity: "warning", span: { file: "style.toml" } },
    { severity: "error", span: { file: "manifest.toml" } },
  ];
  assert.equal(errorsIn(diags, "style.toml"), 1);
  assert.equal(errorsIn("nonsense", "style.toml"), 0);
});

test("ADR 0081 judging: a Golem file fails when golem check finds more errors after the edit", () => {
  const ok = { pass: true, reason: "" };
  assert.equal(judgeGolem(ok, 1, 1).pass, true);
  assert.equal(judgeGolem(ok, 1, 0).pass, true);
  assert.equal(judgeGolem(ok, 0, 1).pass, false);
  assert.equal(judgeGolem({ pass: false, reason: "x" }, 0, 0).pass, false);
});

// 「適用」 of the assistant's tab (docs/adr/0081 I1 to I4, docs/adr/0088): the edits checked again
// on the current text, the decision and dialogs before applying, one undoable change, the save,
// then the diff tab when Git can show it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../ed/core.ts";
import { applyAnswer, assistantChange, type ApplyDeps } from "./applyflow.ts";
import type { Scope } from "./edits.ts";

type Log = string[];

const deps = (log: Log, o: { text?: () => string; prepare?: ApplyDeps["prepare"]; save?: boolean; diff?: boolean } = {}): ApplyDeps => {
  let text = "a = 1\nb = 2\n";
  return {
    text: o.text ?? (() => text),
    prepare: o.prepare ?? (async () => (log.push("prepare"), "apply")),
    change: (before, after) => {
      log.push(`change ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      text = after;
    },
    save: async () => (log.push("save"), o.save ?? true),
    diffAvailable: async () => o.diff ?? true,
    showDiff: () => void log.push("showDiff"),
  };
};

const sheet: Scope = { kind: "sheet" };
const edit = [{ find: "a = 1", replace: "a = 9" }];

test("ADR 0081 I1, I2: an edit that fits the current text is applied after the pre-apply step, then saved and the diff shown", async () => {
  const log: Log = [];
  const r = await applyAnswer(deps(log), sheet, edit);
  assert.deepEqual(r, { kind: "applied" });
  assert.deepEqual(log, ["prepare", 'change "a = 1\\nb = 2\\n" -> "a = 9\\nb = 2\\n"', "save", "showDiff"]);
});

test("ADR 0081 I1: an edit that no longer fits is not applied, with the reason, and no dialog is shown (ADR 0088)", async () => {
  const log: Log = [];
  const r = await applyAnswer(deps(log, { text: () => "a = 1\na = 1\n" }), sheet, edit);
  assert.equal(r.kind, "unapplicable");
  assert.match(r.kind === "unapplicable" ? r.reason : "", /2 か所/);
  assert.deepEqual(log, []);
});

test("ADR 0081 I1: after the writer changed the text outside the target, the edit is counted again and applies", async () => {
  const log: Log = [];
  let text = "x\na = 1\nb = 2\n";
  const d = { ...deps(log), text: () => text, change: (_: string, after: string) => void (log.push("change"), (text = after)) };
  const r = await applyAnswer(d, { kind: "selection", text: "a = 1\n" }, edit);
  assert.deepEqual(r, { kind: "applied" });
  assert.equal(text, "x\na = 9\nb = 2\n");
});

test("ADR 0081 I1: after the writer changed the text inside the selection, the edit does not apply", async () => {
  const log: Log = [];
  const r = await applyAnswer(deps(log, { text: () => "a = 2\nb = 2\n" }), { kind: "selection", text: "a = 1\n" }, edit);
  assert.equal(r.kind, "unapplicable");
  assert.deepEqual(log, []);
});

test("ADR 0081 I4: 「やめる」 in the dialog leaves the text as it was", async () => {
  const log: Log = [];
  const r = await applyAnswer(deps(log, { prepare: async () => (log.push("prepare"), "cancel") }), sheet, edit);
  assert.deepEqual(r, { kind: "cancelled" });
  assert.deepEqual(log, ["prepare"]);
});

test("ADR 0081 I1: when the edit no longer fits after the commit, it is not applied, with the reason", async () => {
  const log: Log = [];
  let text = "a = 1\nb = 2\n";
  const d = { ...deps(log), text: () => text, prepare: async (applicable: () => boolean) => ((text = "b = 2\n"), applicable() ? ("apply" as const) : ("unapplicable" as const)) };
  const r = await applyAnswer(d, sheet, edit);
  assert.equal(r.kind, "unapplicable");
  assert.match(r.kind === "unapplicable" ? r.reason : "", /見つかりません/);
  assert.deepEqual(log, []);
});

test("ADR 0081: the edit is applied to the text as it is after the dialog (a save meanwhile)", async () => {
  const log: Log = [];
  let text = "a = 1\nb = 2\n";
  const d = { ...deps(log), text: () => text, prepare: async () => ((text = "a = 1\nb = 3\n"), "apply" as const), change: (_: string, after: string) => void (text = after) };
  await applyAnswer(d, sheet, edit);
  assert.equal(text, "a = 9\nb = 3\n");
});

test("ADR 0088: without Git or a repository, the sheet is saved and the diff tab is not shown", async () => {
  const log: Log = [];
  await applyAnswer(deps(log, { diff: false }), sheet, edit);
  assert.deepEqual(log.slice(-1), ["save"]);
});

test("ADR 0088: when the save fails, the diff tab is not shown", async () => {
  const log: Log = [];
  const r = await applyAnswer(deps(log, { save: false }), sheet, edit);
  assert.deepEqual(r, { kind: "applied" });
  assert.ok(!log.includes("showDiff"));
});

test("ADR 0081 I3: the assistant's change is one step, and one undo puts back the text before", () => {
  const c = createCore("a = 1\nb = 2\n");
  c.apply([{ from: 12, to: 12, insert: "c" }], "input.type");
  const before = c.text();
  const after = "a = 9\nb = 2\nc";
  assert.equal(c.apply(assistantChange(before, after), "assistant"), true);
  assert.equal(c.text(), after);
  assert.equal(c.undo(), true);
  assert.equal(c.text(), before);
});

test("ADR 0081 I3: two edits far apart are still one step", () => {
  const before = "a\nb\nc\nd\n";
  const after = "A\nb\nc\nD\n";
  const c = createCore(before);
  c.apply(assistantChange(before, after), "assistant");
  assert.equal(c.text(), after);
  c.undo();
  assert.equal(c.text(), before);
});

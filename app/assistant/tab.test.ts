// The pure parts of the assistant's tab (docs/adr/0081, 下部パネルのタブ): the target, its label,
// the file named in the prompt, the send key, the answer's JSON, the diff of the changed lines and
// the connectors offered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorChoices, isSendKey, lineDiff, parseAnswer, promptFile, seconds, targetLabel, targetOf, targetText } from "./tab.ts";

test("ADR 0081: the target is the selection when the editor has one", () => {
  const t = targetOf("/w/p/style.toml", "a = 1\nb = 2\n", { from: 6, to: 11 });
  assert.deepEqual(t.scope, { kind: "selection", text: "b = 2" });
  assert.equal(targetText(t, "a = 1\nb = 2\n"), "b = 2");
  assert.equal(targetLabel(t), "選択の範囲（5 字）");
});

test("ADR 0081: the target is the whole sheet without a selection", () => {
  for (const range of [null, { from: 3, to: 3 }]) {
    const t = targetOf("/w/a.md", "本文。\n", range);
    assert.deepEqual(t.scope, { kind: "sheet" });
    assert.equal(targetText(t, "本文。\n"), "本文。\n");
    assert.equal(targetLabel(t), "シートの全体");
  }
});

test("ADR 0081: the selection's length counts characters, not UTF-16 units", () => {
  const t = targetOf("/w/a.md", "𠮷野家", { from: 0, to: 4 });
  assert.equal(targetLabel(t), "選択の範囲（3 字）");
});

test("ADR 0081: the file in the prompt is the path from the project, else from the workspace, else the name", () => {
  assert.equal(promptFile("/w/p/chapters/01.gm", "/w/p", "/w"), "chapters/01.gm");
  assert.equal(promptFile("/w/notes/a.md", null, "/w"), "notes/a.md");
  assert.equal(promptFile("/lib/a.md", null, "/w"), "a.md");
  assert.equal(promptFile("/w/a.md", null, null), "a.md");
});

test("ADR 0081: ⌘↩ sends the request; ↩ alone, ⇧⌘↩ and ↩ while composing do not", () => {
  const k = { key: "Enter", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false };
  assert.equal(isSendKey(k), true);
  assert.equal(isSendKey({ ...k, metaKey: false }), false);
  assert.equal(isSendKey({ ...k, shiftKey: true }), false);
  assert.equal(isSendKey({ ...k, isComposing: true }), false);
  assert.equal(isSendKey({ ...k, key: "a" }), false);
});

test("ADR 0081: an answer's JSON gives the explanation and the edits", () => {
  assert.deepEqual(parseAnswer('{"explanation":"広げます。","edits":[{"find":"a","replace":"b"}]}'), {
    ok: true,
    answer: { explanation: "広げます。", edits: [{ find: "a", replace: "b" }] },
  });
  assert.deepEqual(parseAnswer('{"explanation":"設定を使います。","edits":[]}'), { ok: true, answer: { explanation: "設定を使います。", edits: [] } });
});

test("ADR 0081: an answer that is not the JSON of the form is refused with the reason", () => {
  for (const raw of ["", "not json", "[]", '{"edits":[]}', '{"explanation":"x"}', '{"explanation":"x","edits":[{"find":1}]}']) {
    const r = parseAnswer(raw);
    assert.equal(r.ok, false, raw);
    assert.ok(!r.ok && r.reason !== "", raw);
  }
});

test("ADR 0081: the diff shows the changed lines with one line of context", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\n";
  const after = "a\nb\nC\nd\ne\nf\nG\n";
  assert.deepEqual(lineDiff(before, after), [
    { op: " ", text: "b" },
    { op: "-", text: "c" },
    { op: "+", text: "C" },
    { op: " ", text: "d" },
    { op: "…", text: "" },
    { op: " ", text: "f" },
    { op: "-", text: "g" },
    { op: "+", text: "G" },
    { op: " ", text: "" },
  ]);
});

test("ADR 0081: the diff of equal texts is empty; added and removed lines show alone", () => {
  assert.deepEqual(lineDiff("a\n", "a\n"), []);
  assert.deepEqual(lineDiff("a", "a\nb"), [
    { op: " ", text: "a" },
    { op: "+", text: "b" },
  ]);
  assert.deepEqual(lineDiff("a\nb", "b"), [
    { op: "-", text: "a" },
    { op: " ", text: "b" },
  ]);
});

test("ADR 0081: the time an answer took is in seconds with one decimal", () => {
  assert.equal(seconds(12345), "12.3 秒");
  assert.equal(seconds(0), "0.0 秒");
});

test("ADR 0081: the connectors offered are the local one and those found", () => {
  const infos = [
    { id: "local" as const, name: "ローカル", found: true, approved: true },
    { id: "claude" as const, name: "Claude Code", found: false, approved: false },
    { id: "codex" as const, name: "Codex", found: true, approved: false },
  ];
  assert.deepEqual(connectorChoices(infos).map((c) => c.id), ["local", "codex"]);
  assert.deepEqual(connectorChoices([]).map((c) => c.id), ["local"]);
});

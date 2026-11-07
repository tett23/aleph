import { test } from "node:test";
import assert from "node:assert/strict";
import { createIme, diffText, type ImeEvent } from "./ime.ts";
import { textOf, type Text } from "./text.ts";

/** Runs events; `dom` is the text of the composing lines as the DOM has it after each event. */
const run = (doc: Text, sel: { from: number; to: number }, events: ImeEvent[]) => {
  const ime = createIme();
  const out: unknown[] = [];
  ime.start(doc, sel);
  for (const e of events) out.push(ime.feed(e));
  return { ime, out };
};
const applyCommit = (doc: Text, c: { from: number; to: number; insert: string }) => doc.replace(c.from, c.to, c.insert).toString();

test("the smallest change between the text before and after, never splitting a surrogate pair", () => {
  assert.deepEqual(diffText("あいう", "あかう"), { from: 1, to: 2, insert: "か" });
  assert.deepEqual(diffText("ab", "ab"), null);
  assert.deepEqual(diffText("a🌊b", "a🌀b"), { from: 1, to: 3, insert: "🌀" });
  assert.deepEqual(diffText("", "火"), { from: 0, to: 0, insert: "火" });
});

test("composing in the middle of a line and committing", () => {
  const doc = textOf("前の行\n灯台と\n次");
  const { out } = run(doc, { from: 6, to: 6 }, [
    { type: "beforeinput", inputType: "insertCompositionText", data: "k" },
    { type: "input", dom: "灯台kと" },
    { type: "beforeinput", inputType: "insertCompositionText", data: "か" },
    { type: "input", dom: "灯台かと" },
    { type: "beforeinput", inputType: "insertCompositionText", data: "火" },
    { type: "input", dom: "灯台火と" },
    { type: "compositionend", data: "火", dom: "灯台火と" },
  ]);
  const end = out[out.length - 1] as { commit: { from: number; to: number; insert: string }; caret: number };
  assert.equal(applyCommit(doc, end.commit), "前の行\n灯台火と\n次");
  assert.equal(end.caret, 7);
  // nothing is committed before the end
  assert.ok(out.slice(0, -1).every((o) => !(o as { commit?: unknown }).commit));
});

test("at the start and at the end of a line, and on an empty line", () => {
  const doc = textOf("灯台\n\n終");
  const a = run(doc, { from: 0, to: 0 }, [{ type: "compositionend", data: "霧", dom: "霧灯台" }]).out[0] as { commit: { from: number; to: number; insert: string } };
  assert.equal(applyCommit(doc, a.commit), "霧灯台\n\n終");
  const b = run(doc, { from: 2, to: 2 }, [{ type: "compositionend", data: "笛", dom: "灯台笛" }]).out[0] as { commit: { from: number; to: number; insert: string } };
  assert.equal(applyCommit(doc, b.commit), "灯台笛\n\n終");
  const c = run(doc, { from: 3, to: 3 }, [{ type: "compositionend", data: "冬", dom: "冬" }]).out[0] as { commit: { from: number; to: number; insert: string } };
  assert.equal(applyCommit(doc, c.commit), "灯台\n冬\n終");
});

test("replacing a selection, also across lines (the DOM merges them into one line)", () => {
  const doc = textOf("灯台の\n冬の海");
  const a = run(doc, { from: 0, to: 2 }, [{ type: "compositionend", data: "霧笛", dom: "霧笛の" }]).out[0] as { commit: { from: number; to: number; insert: string } };
  assert.equal(applyCommit(doc, a.commit), "霧笛の\n冬の海");
  const b = run(doc, { from: 2, to: 5 }, [{ type: "compositionend", data: "が", dom: "灯台がの海" }]).out[0] as { commit: { from: number; to: number; insert: string } };
  assert.equal(applyCommit(doc, b.commit), "灯台がの海");
});

test("a cancelled composition changes nothing", () => {
  const doc = textOf("灯台");
  const { out } = run(doc, { from: 1, to: 1 }, [
    { type: "beforeinput", inputType: "insertCompositionText", data: "か" },
    { type: "input", dom: "灯か台" },
    { type: "beforeinput", inputType: "deleteCompositionText", data: null },
    { type: "compositionend", data: "", dom: "灯台" },
  ]);
  assert.deepEqual(out[out.length - 1], { commit: null, caret: 1 });
});

test("Enter that commits is not a new line; Enter after the end is", () => {
  const doc = textOf("灯");
  const ime = createIme();
  ime.start(doc, { from: 1, to: 1 });
  assert.equal(ime.swallowKey({ key: "Enter", isComposing: true, keyCode: 229 }), true);
  ime.feed({ type: "compositionend", data: "台", dom: "灯台" });
  // WebKit sends the committing Enter's keydown after compositionend with keyCode 229
  assert.equal(ime.swallowKey({ key: "Enter", isComposing: false, keyCode: 229 }), true);
  assert.equal(ime.swallowKey({ key: "Enter", isComposing: false, keyCode: 13 }), false);
});

test("draws asked for while composing wait until the end, then run once", () => {
  const doc = textOf("灯");
  const ime = createIme();
  let drawn = 0;
  ime.start(doc, { from: 1, to: 1 });
  ime.whenIdle(() => drawn++);
  ime.whenIdle(() => drawn++);
  assert.equal(drawn, 0);
  ime.feed({ type: "compositionend", data: "台", dom: "灯台" });
  assert.equal(drawn, 2);
  ime.whenIdle(() => drawn++);
  assert.equal(drawn, 3); // not composing: at once
});

test("compositions one after another each commit their own change", () => {
  let doc = textOf("");
  const ime = createIme();
  ime.start(doc, { from: 0, to: 0 });
  let r = ime.feed({ type: "compositionend", data: "灯", dom: "灯" }) as { commit: { from: number; to: number; insert: string }; caret: number };
  doc = doc.replace(r.commit.from, r.commit.to, r.commit.insert);
  ime.start(doc, { from: r.caret, to: r.caret });
  r = ime.feed({ type: "compositionend", data: "台", dom: "灯台" }) as { commit: { from: number; to: number; insert: string }; caret: number };
  doc = doc.replace(r.commit.from, r.commit.to, r.commit.insert);
  assert.equal(doc.toString(), "灯台");
});

test("leaving the editor while composing commits what the DOM has", () => {
  const doc = textOf("灯");
  const ime = createIme();
  ime.start(doc, { from: 1, to: 1 });
  ime.feed({ type: "input", dom: "灯だい" });
  const r = ime.feed({ type: "blur", dom: "灯だい" }) as { commit: { from: number; to: number; insert: string } };
  assert.equal(applyCommit(doc, r.commit), "灯だい");
  assert.equal(ime.composing(), false);
});

test("combining characters and surrogate pairs in the commit", () => {
  const doc = textOf("a");
  const r = run(doc, { from: 1, to: 1 }, [{ type: "compositionend", data: "が🌊", dom: "aが🌊" }]).out[0] as { commit: { from: number; to: number; insert: string }; caret: number };
  assert.equal(applyCommit(doc, r.commit), "aが🌊");
  assert.equal(r.caret, 5);
});

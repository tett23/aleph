import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createCore } from "./core.ts";
import { createInput, replay, type Recorded } from "./control.ts";

test("typed characters and deletions are applied, and the browser is kept from changing the DOM", () => {
  const core = createCore("ab");
  const input = createInput(core);
  core.select({ anchor: 1, head: 1 });
  assert.equal(input.beforeInput({ inputType: "insertText", data: "X", isComposing: false }), "prevent");
  assert.equal(core.text(), "aXb");
  assert.equal(input.beforeInput({ inputType: "deleteContentBackward", data: null, isComposing: false }), "prevent");
  assert.equal(core.text(), "ab");
  assert.deepEqual(core.sel(), { anchor: 1, head: 1 });
});

test("composition text is left to the browser and taken in at the end", () => {
  const core = createCore("灯台と");
  const input = createInput(core);
  core.select({ anchor: 2, head: 2 });
  input.compositionStart();
  assert.equal(input.beforeInput({ inputType: "insertCompositionText", data: "か", isComposing: true }), "allow");
  assert.equal(core.text(), "灯台と");
  input.compositionEnd("火", () => "灯台火と");
  assert.equal(core.text(), "灯台火と");
  assert.deepEqual(core.sel(), { anchor: 3, head: 3 });
});

test("the composed region is read from the lines being composed only", () => {
  const core = createCore("一\n二\n三");
  const input = createInput(core);
  core.select({ anchor: 2, head: 3 });
  input.compositionStart();
  let asked: number[] = [];
  input.compositionEnd("弐", (first, last) => ((asked = [first, last]), "弐"));
  assert.deepEqual(asked, [2, 2]);
  assert.equal(core.text(), "一\n弐\n三");
});

test("the Enter that commits is not a new line, and the 229 Enter after the end is swallowed too", () => {
  const core = createCore("");
  const input = createInput(core);
  input.compositionStart();
  assert.equal(input.keyDown({ key: "Enter", keyCode: 229, isComposing: true }), true);
  input.compositionEnd("霧", () => "霧");
  assert.equal(input.keyDown({ key: "Enter", keyCode: 229, isComposing: false }), true);
  assert.equal(input.keyDown({ key: "Enter", keyCode: 13, isComposing: false }), false);
  assert.equal(core.text(), "霧");
});

test("undo after a commit takes the whole committed text away at once", () => {
  const core = createCore("灯台");
  const input = createInput(core);
  core.select({ anchor: 2, head: 2 });
  input.compositionStart();
  input.compositionEnd("の霧笛", () => "灯台の霧笛");
  assert.equal(input.beforeInput({ inputType: "historyUndo", data: null, isComposing: false }), "prevent");
  assert.equal(core.text(), "灯台");
});

test("two compositions in a row each become their own step", () => {
  const core = createCore("");
  const input = createInput(core);
  input.compositionStart();
  input.compositionEnd("霧", () => "霧");
  input.compositionStart();
  input.compositionEnd("笛", () => "霧笛");
  assert.equal(core.text(), "霧笛");
  core.undo();
  assert.equal(core.text(), "霧");
});

test("losing focus while composing commits what the DOM has", () => {
  const core = createCore("海");
  const input = createInput(core);
  core.select({ anchor: 1, head: 1 });
  input.compositionStart();
  input.blur(() => "海へ");
  assert.equal(core.text(), "海へ");
  assert.equal(input.composing(), false);
});

test("replaying a recorded sequence: the DOM's full text gives the composed lines", () => {
  const rec: Recorded = {
    name: "synthetic",
    ua: "",
    initial: "前\n灯台\n後",
    events: [
      { type: "select", anchor: 4, head: 4 },
      { type: "compositionstart" },
      { type: "beforeinput", inputType: "insertCompositionText", data: "ka", isComposing: true },
      { type: "compositionupdate", data: "か" },
      { type: "compositionend", data: "火", dom: "前\n灯台火\n後" },
      { type: "beforeinput", inputType: "insertParagraph", data: null, isComposing: false },
    ],
    expected: "前\n灯台火\n\n後",
  };
  assert.equal(replay(rec).text, rec.expected);
});

// sequences recorded in the Tauri WebView (WebKit) with a Japanese input method (docs/adr/0019)
const dir = new URL("./fixtures/", import.meta.url);
const fixtures = (() => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
})();
for (const f of fixtures) {
  const rec = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Recorded;
  test(`recorded: ${rec.name} (${f})`, () => {
    const r = replay(rec);
    assert.equal(r.text, rec.expected);
    if (rec.caret !== undefined) assert.equal(r.caret, rec.caret);
  });
}

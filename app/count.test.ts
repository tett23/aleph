import { test } from "node:test";
import assert from "node:assert/strict";
import { countText, paragraphsOf, stats } from "./count.ts";

test("characters: without spaces; .gm without commands, expressions and comments", () => {
  const gm = "@import a.emet as a\n\n# 霧笛\n\n[ruby: 霧笛|むてき]は　三度。%% メモ %%\n残りは[= a.f(1)]L。\n";
  assert.deepEqual(paragraphsOf("gm", gm), ["霧笛", "霧笛は　三度。残りはL。"]);
  assert.equal(countText("gm", gm, { cols: 20, rows: 20 }).chars, 2 + 11); // the full-width space is not counted
});

test("the line style: each line is a paragraph", () => {
  assert.deepEqual(paragraphsOf("gm", "一行目\n二行目\n", "line"), ["一行目", "二行目"]);
  assert.deepEqual(paragraphsOf("gm", "一行目\n二行目\n"), ["一行目二行目"]);
});

test("Markdown: the text of blocks, without marks", () => {
  assert.deepEqual(paragraphsOf("md", "# 題\n\n**強く** `code` と [リンク](x)\n\n- 項目\n"), ["題", "強く code と リンク", "項目"]);
});

test("words by Intl.Segmenter", () => {
  assert.equal(stats(["The lighthouse keeper."], 20, 20).words, 3);
  assert.ok(stats(["灯台守の冬"], 20, 20).words >= 2);
});

test("manuscript sheets: each paragraph's lines rounded up, divided by the lines of a sheet", () => {
  // 25 characters → 2 lines, 5 → 1 line, 41 → 3 lines: 6 lines on 20-line sheets
  const s = stats(["あ".repeat(25), "い".repeat(5), "う".repeat(41)], 20, 20);
  assert.equal(s.chars, 71);
  assert.equal(s.sheets, 0.3);
  assert.equal(stats(["あ".repeat(400)], 20, 20).sheets, 1);
  assert.equal(stats([], 20, 20).sheets, 0);
});

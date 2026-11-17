import { test } from "node:test";
import assert from "node:assert/strict";
import { countsStatus, countText, fileChars, goalProgress, paragraphsOf, sheetCounts, stats } from "./count.ts";
import { createCore } from "./ed/core.ts";

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

test("Markdown counts: characters, words and sheets of its text", () => {
  const s = countText("md", "# 題\n\n**強く** `x` と [リンク](u)\n", { cols: 20, rows: 20 });
  assert.equal(s.chars, 1 + [..."強くxとリンク"].length);
  assert.ok(s.words >= 3);
  assert.equal(s.sheets, 0.1);
});

test("manuscript lines count characters without spaces, as the character count does", () => {
  // 20 characters and 10 full-width spaces: one line of 20, not two
  assert.equal(stats(["あ　".repeat(10) + "い".repeat(10)], 20, 1).sheets, 1);
  assert.equal(stats(["あ".repeat(20) + "　".repeat(10)], 20, 1).sheets, 1);
});

test("a wikilink counts as the text it shows (docs/adr/0027)", () => {
  assert.deepEqual(paragraphsOf("md", "父は[[人物|あの人]]と[[場所#灯台]]へ"), ["父はあの人と場所 > 灯台へ"]);
});

test("strikethrough counts; task marks do not (docs/adr/0035)", () => {
  assert.deepEqual(paragraphsOf("md", "~~消す~~文\n\n- [x] 読む"), ["消す文", "読む"]);
});

// ---- ADR 0075: the body characters and the file characters, side by side ----

const m20 = { cols: 20, rows: 20 };

test("ADR 0075 I1: the file characters are the code points of the buffer (the boundary table)", () => {
  const rows: [string, string, number, number][] = [
    ["md", "", 0, 0],
    ["md", "# 猫", 1, 3],
    ["md", "# 猫\n", 1, 4],
    ["md", "🐈", 1, 1],
    ["txt", "A \nB", 2, 4],
    ["md", "é", 2, 2],
  ];
  for (const [kind, src, body, file] of rows) {
    const c = sheetCounts(kind, src, m20);
    assert.ok(c, `${JSON.stringify(src)} has counts`);
    assert.equal(c.chars, body, `body of ${JSON.stringify(src)}`);
    assert.equal(c.fileChars, file, `file of ${JSON.stringify(src)}`);
    assert.equal(fileChars(src), file);
  }
});

test("ADR 0075 I1: an unsaved LF and its undo move the file characters 3 → 4 → 3, and redo back to 4", () => {
  const core = createCore("# 猫");
  const counted = () => sheetCounts("md", core.text(), m20)!.fileChars;
  assert.equal(counted(), 3);
  core.apply([{ from: 3, insert: "\n" }], "input.type");
  assert.equal(counted(), 4);
  core.undo();
  assert.equal(counted(), 3);
  core.redo();
  assert.equal(counted(), 4);
});

test("ADR 0075 I1: the status bar shows the body characters and the file characters side by side", () => {
  const html = countsStatus(sheetCounts("md", "# 猫\n", m20)!);
  assert.match(html, /<span>本文文字数 1<\/span><span>ファイル文字数 4<\/span>/);
});

test("ADR 0075 I1: sheets without a body (PDF and other binary or data files) show no text counts", () => {
  for (const kind of ["pdf", "png", "svg", "csv", "json"]) assert.equal(sheetCounts(kind, "%PDF-1.7\n", m20), null, kind);
});

test("ADR 0075 I2: changing 猫 to # 猫 keeps the goal progress and the body, and adds 2 file characters", () => {
  const before = sheetCounts("md", "猫", m20)!;
  const after = sheetCounts("md", "# 猫", m20)!;
  assert.equal(after.chars, before.chars);
  assert.equal(goalProgress(after, 10), goalProgress(before, 10));
  assert.equal(goalProgress(after, 10), 0.1);
  assert.equal(after.fileChars - before.fileChars, 2);
});

test("ADR 0075 I1, I2: a comment added to a .gm keeps the body and adds its code points to the file characters", () => {
  const src = "# 霧笛\n\n霧笛は三度鳴った。\n";
  const comment = "%% 夜明け前 🐈 %%";
  const before = sheetCounts("gm", src, m20)!;
  const after = sheetCounts("gm", src.replace("鳴った。", `鳴った。${comment}`), m20)!;
  assert.ok(before.chars > 0);
  assert.equal(after.chars, before.chars);
  assert.equal(goalProgress(after, 100), goalProgress(before, 100));
  assert.equal(after.fileChars - before.fileChars, [...comment].length);
});

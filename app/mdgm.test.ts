import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mdToGm } from "./mdgm.ts";

const gm = (md: string, sep: "blank-line" | "line" = "blank-line") => mdToGm(md, sep);

test("headings stay; the closing #s go", () => {
  assert.equal(gm("# 霧笛 #\n\n## 灯の交代\n"), "# 霧笛\n\n## 灯の交代\n");
});

test("lists: bullets become -, nesting two spaces; numbered become +", () => {
  assert.equal(gm("* 一\n    + 二\n        - 三\n- 四\n"), "- 一\n  - 二\n    - 三\n- 四\n");
  assert.equal(gm("1. 一\n2) 二\n"), "+ 一\n+ 二\n");
});

test("emphasis, italics and code become commands; nested", () => {
  assert.equal(gm("**強く**と*斜め*と`code`\n"), "[strong: 強く]と[italic: 斜め]と[code: code]\n");
  assert.equal(gm("__a *b* c__\n"), "[strong: a [italic: b] c]\n");
  assert.equal(gm("**`x*y`**\n"), "[strong: [code: x*y]]\n");
});

test("inside a prose slot ] and | are escaped; in running text they are not", () => {
  assert.equal(gm("**a]b|c**\n"), "[strong: a\\]b\\|c]\n");
  assert.equal(gm("a]b|c\n"), "a]b|c\n");
  assert.equal(gm("`[x|y]`\n"), "[code: \\[x\\|y\\]]\n");
});

test("running text: [ and \\ and %% are escaped", () => {
  assert.equal(gm("配列は a\\[0\\] と書く。\\\\ と 50%% 引き\n"), "配列は a\\[0] と書く。\\\\ と 50\\%% 引き\n");
});

test("a paragraph starting with # - + = @ | is escaped; so is ## before a digit", () => {
  assert.equal(gm("\\# 見出しでない\n"), "\\# 見出しでない\n");
  assert.equal(gm("\\- 項目でない\n"), "\\- 項目でない\n");
  assert.equal(gm("\\+ 項目でない\n"), "\\+ 項目でない\n");
  assert.equal(gm("= 等号\n"), "\\= 等号\n");
  assert.equal(gm("@mention です\n"), "\\@mention です\n");
  assert.equal(gm("| 縦棒で始まる\n"), "\\| 縦棒で始まる\n");
  assert.equal(gm("番号は ##1 と書く\n"), "番号は \\##1 と書く\n");
});

test("links keep their text; an image alone on a line becomes @figure", () => {
  assert.equal(gm("[Golem](https://example.com) を見る\n"), "Golem を見る\n");
  assert.equal(gm('![灯台の絵](images/lighthouse.png "t")\n'), '@figure images/lighthouse.png alt="灯台の絵"\n');
});

test("quotes lose the mark; rules become a blank line; tables and code blocks stay", () => {
  assert.equal(gm("> 引用\n> 続き\n\n---\n\n後\n"), "引用\n続き\n\n後\n");
  assert.equal(gm("| a | b |\n|---|---|\n| 1 | 2 |\n"), "| a | b |\n|---|---|\n| 1 | 2 |\n");
  assert.equal(gm("```gm\n[ruby: x|y] **z** %%\n```\n"), "```gm\n[ruby: x|y] **z** %%\n```\n");
});

test("two trailing spaces become a forced break", () => {
  assert.equal(gm("一行目  \n二行目\n"), "一行目\\\n二行目\n");
});

test("paragraphs: kept as lines in the blank-line style, joined into one line in the line style", () => {
  const md = "一行目\n二行目\n\n次の段落\n";
  assert.equal(gm(md, "blank-line"), "一行目\n二行目\n\n次の段落\n");
  assert.equal(gm(md, "line"), "一行目二行目\n\n次の段落\n");
  assert.equal(gm("一  \n二\n三\n", "line"), "一\\\n二三\n");
});

const golem = spawnSync("golem", ["--version"]).status === 0;

test("the result passes golem check", { skip: !golem && "golem is not installed" }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aleph-mdgm-"));
  assert.equal(spawnSync("golem", ["new", "p", "--no-fonts"], { cwd: d }).status, 0);
  const md = "# 霧笛\n\n**強い a]b|c** と *斜め* と `co|de`。\n50%% と ##1 と a\\[0\\]。\n\n= 等号\n\n- 一\n  - 二\n1. 三\n\n> 引用\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nコード\n```\n\n最後  \nの行\n";
  fs.writeFileSync(path.join(d, "p/chapters/01.gm"), mdToGm(md, "blank-line"));
  const r = spawnSync("golem", ["check", "--format", "json"], { cwd: path.join(d, "p"), encoding: "utf8" });
  // only the converted chapter's errors: the project made with --no-fonts lacks its font
  const errors = (JSON.parse(r.stderr.trim() || "[]") as { severity: string; message: string; span?: { file: string } }[]).filter((x) => x.severity === "error" && x.span?.file === "chapters/01.gm");
  assert.deepEqual(errors, []);
});

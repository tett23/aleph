// The glossary's invariants (docs/adr/0082): the names of docs/glossary.md against the UI
// strings of app/, the specification, and the code of app/ and src-tauri/src.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { codeNames, cssSelectors, parseTable, quoted, stripComments, uiStrings, usesOf } from "./glossary-check.ts";

const root = new URL("../", import.meta.url).pathname;
const read = (p: string) => readFileSync(root + p, "utf8");
const ADR = "docs/adr/0082-ui-names-and-glossary.md";
const ADR_0087 = "docs/adr/0087-preview-in-a-tab.md";
/** The one module that may hold the old names: the table that reads them as the new ones. */
const LEGACY = "app/legacy-names.ts";

const glossary = () => parseTable(read("docs/glossary.md"));

const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(root + dir).flatMap((f) => {
    const p = `${dir}/${f}`;
    if (statSync(root + p).isDirectory()) return f === "fixtures" ? [] : files(p, ext);
    return ext.test(p) && !/\.test\.ts$/.test(p) ? [p] : [];
  });

/** The UI strings of every source of app/, with the file each came from. */
const appStrings = () => files("app", /\.ts$/).flatMap((p) => uiStrings(read(p)).map((s) => ({ p, s })));

// ---- the extractor

test("ADR 0082 I1, I2: titles, labels and placeholders are UI strings, with their template parts dropped", () => {
  const src = 'const a = `<span class="iconbtn ${on ? "on" : ""}" data-tb="right" title="右サイドバー">${icon("x")}</span>`;\n' +
    'add({ id: "view.bottomPanel", label: "下部パネル" });\n' +
    "add({ label: `右サイドバー：${label}` });\n" +
    '<input placeholder="検索">';
  assert.deepEqual(uiStrings(src).sort(), ["右サイドバー", "下部パネル", "右サイドバー：", "検索"].sort());
});

test("ADR 0082 I1, I2: the text outside the tags of an HTML template is a UI string", () => {
  assert.deepEqual(uiStrings('h(`<div class="phead2"><span class="tab" data-tab="problems">問題</span><span>通知${badge}</span></div>`)'), ["問題", "通知"]);
});

test("ADR 0082 I2: comments are not UI strings", () => {
  const src = '// the 問題のパネル\n/* 右のパネル */\nconst x = 1; // label: "問題のパネル"\nh(`<!-- 右のパネル --><b>本文</b>`)';
  assert.deepEqual(uiStrings(src), ["本文"]);
});

test("ADR 0082 I2: class names and attribute names are not UI strings", () => {
  const src = '`<div class="問題のパネル" data-右のパネル="1" aria-label="x"><span>文</span></div>`';
  assert.deepEqual(uiStrings(src), ["文"]);
});

test("ADR 0082 I2: a URL in a string is not taken for a comment", () => {
  assert.deepEqual(uiStrings('const u = "https://example.com"; add({ label: "開く" })'), ["開く"]);
});

// ---- the tables

test("ADR 0087 I7: the glossary's names are ADR 0082's table without the preview area, with the preview tab and the followed tab", () => {
  const adr = parseTable(read(ADR), "決める名前").map((r) => r["正式な名前"]);
  const added = parseTable(read(ADR_0087), "テストと文書");
  assert.deepEqual(added.map((r) => r["正式な名前"]), ["プレビューのタブ", "映すタブ"]);
  const at = adr.indexOf("プレビューの領域");
  assert.ok(at >= 0);
  const want = [...adr.slice(0, at), ...added.map((r) => r["正式な名前"]), ...adr.slice(at + 1)];
  assert.deepEqual(glossary().map((r) => r["正式な名前"]), want);
  // the two rows are the ADR's, cell by cell (the glossary's columns in the same order)
  const rows = glossary().filter((r) => added.some((x) => x["正式な名前"] === r["正式な名前"]));
  assert.deepEqual(rows.map((r) => Object.values(r)), added.map((r) => Object.values(r)));
});

test("ADR 0082 I1: every UI wording of the glossary appears among the UI strings of app/", () => {
  const strings = appStrings().map((x) => x.s);
  const missing = glossary().flatMap((r) => quoted(r["画面の文言"]).filter((w) => !strings.some((s) => s.includes(w))));
  assert.deepEqual(missing, []);
});

test("ADR 0082 I1: the bottom panel's wording appears in app/problemsmount.ts", () => {
  assert.ok(uiStrings(read("app/problemsmount.ts")).some((s) => s.includes("下部パネル")));
});

test("ADR 0082 I2: no name the glossary rejects appears among the UI strings of app/", () => {
  const strings = appStrings();
  const banned = glossary().flatMap((r) => quoted(r["使わない名前"]));
  assert.ok(banned.length > 0);
  assert.deepEqual(strings.filter((x) => banned.some((b) => x.s.includes(b))), []);
});

test("ADR 0082 I2, A2: no name the glossary rejects appears in the specification", () => {
  const spec = read("docs/specifications.md");
  const banned = glossary().flatMap((r) => quoted(r["使わない名前"]));
  assert.deepEqual(banned.filter((b) => spec.includes(b)), []);
});

test("ADR 0082 I3: the official names differ from each other, and so do the English names", () => {
  const rows = glossary();
  const dup = (xs: string[]) => xs.filter((x, k) => xs.indexOf(x) !== k);
  assert.deepEqual(dup(rows.map((r) => r["正式な名前"])), []);
  assert.deepEqual(dup(rows.map((r) => r["英語の名前"])), []);
});

test("ADR 0082 I3: a repeated name is found", () => {
  const md = "| 正式な名前 | 英語の名前 |\n| --- | --- |\n| パネル | Panel |\n| パネル | Panel |\n";
  const names = parseTable(md).map((r) => r["正式な名前"]);
  assert.notEqual(new Set(names).size, names.length);
});

// ---- the old code names

/** The old names: the glossary's column and the ADR's renaming table. */
const oldNames = () => [
  ...glossary().flatMap((r) => codeNames(r["今のコードの名前"])),
  ...parseTable(read(ADR), "コードの名前を直す").flatMap((r) => codeNames(r["今の名前"])),
];

test("ADR 0082 I4: the old names are read from both tables", () => {
  const names = oldNames();
  for (const n of ["ctx.left", ".problems-panel", "LeftPanel", "showLeft", "view.problems", "view.right.<パネル>", "notes"]) assert.ok(names.includes(n), n);
});

test("ADR 0082 I4: no old name is used in app/ or src-tauri/src outside the module that reads them", () => {
  const names = oldNames();
  assert.ok(existsSync(root + LEGACY));
  const sources = [
    ...files("app", /\.ts$/).filter((p) => p !== LEGACY && p !== "app/glossary-check.ts").map((p) => ({ p, kind: "ts" as const, src: read(p) })),
    { p: "app/style.css", kind: "css" as const, src: read("app/style.css") },
    { p: "index.html", kind: "ts" as const, src: read("index.html") },
    // Rust: the code before its tests
    ...files("src-tauri/src", /\.rs$/).map((p) => ({ p, kind: "rs" as const, src: read(p).split("#[cfg(test)]")[0] })),
  ];
  const left = sources.flatMap(({ p, kind, src }) => names.flatMap((n) => usesOf(n, src, kind).map((u) => `${p}: ${n}: ${u}`)));
  assert.deepEqual(left, []);
});

test("ADR 0082 I4: old names are found in classes, selectors, ctx keys, types and command ids", () => {
  assert.ok(usesOf(".problems-panel", '`<div class="problems-panel" hidden></div>`', "ts").length);
  assert.ok(usesOf(".side", 'root.querySelector(".side")', "ts").length);
  assert.ok(usesOf(".side", ".side.hidden, .x { color: red }", "css").length);
  assert.ok(usesOf("ctx.left", "ctx.left.files = {}", "ts").length);
  assert.ok(usesOf("LeftPanel", "type X = LeftPanel;", "ts").length);
  assert.ok(usesOf("view.right.<パネル>", "id: `view.right.${panel}`", "ts").length);
  assert.ok(usesOf("view.problems", 'id: "view.problems"', "ts").length);
  assert.ok(usesOf("data-tb=\"more\"", 't.dataset.tb === "more"', "ts").length);
  assert.ok(usesOf("left", 'dispatch({ type: "left", panel })', "ts").length);
  assert.ok(usesOf("notes", '<span data-tab="notes">', "ts").length);
});

test("ADR 0082 I4: new names and look-alikes are not taken for old names", () => {
  assert.deepEqual(usesOf(".side", '`<div class="sidebar">` .sidebar el.style.side', "ts"), []);
  assert.deepEqual(usesOf(".right", "rect.right; style.right = 0", "ts"), []);
  assert.deepEqual(usesOf(".status", "ctx.status.push(f)", "ts"), []);
  assert.deepEqual(usesOf(".tree", ".file-tree .r { padding: 0.5px }", "css"), []);
  assert.deepEqual(usesOf("openSettings", "openSettingsDialog(ctx)", "ts"), []);
  assert.deepEqual(usesOf("view.problems", "ctx.view.bottomPanel", "ts"), []);
  assert.deepEqual(usesOf("ctx.left", "// ctx.left was the old name", "ts"), []);
  assert.deepEqual(usesOf("left", "el.style.left = 0; text-align: left", "ts"), []);
  assert.deepEqual(usesOf("ctx.left", "const r = { left: c.left, top: c.top };", "ts"), []);
  assert.deepEqual(usesOf(".status", "Command::new(x)\n    .status()", "rs"), []);
  assert.ok(usesOf(".status", 'format!("<div class=\"status\">")', "rs").length);
});

test("ADR 0082 I4: a style sheet's selectors are read without its blocks and comments", () => {
  assert.equal(cssSelectors("/* .x */ .a { color: red } @media (x) { .b { y: 0 } }").replace(/\s+/g, " ").trim(), ".a ; @media (x) ;");
  assert.equal(stripComments("a // b\nc"), "a \nc");
});

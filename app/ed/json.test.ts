import { test } from "node:test";
import assert from "node:assert/strict";
import { checkJson, formatJson, formatThenSave, isJsonKind } from "./json.ts";

const errors = (text: string, flavor: Parameters<typeof checkJson>[1] = "json") => checkJson(text, flavor).filter((d) => d.severity === "error");
const warnings = (text: string, flavor: Parameters<typeof checkJson>[1] = "json") => checkJson(text, flavor).filter((d) => d.severity === "warning");
const firstError = (text: string, flavor: Parameters<typeof checkJson>[1] = "json") => {
  const e = errors(text, flavor);
  return e.length ? { from: e[0].from, message: e[0].message } : null;
};

test("the four kinds are JSON kinds", () => {
  for (const k of ["json", "jsonc", "json5", "jsonl"]) assert.equal(isJsonKind(k), true, k);
  assert.equal(isJsonKind("toml"), false);
});

// ---- JSON (RFC 8259); cases after JSONTestSuite's y_ and n_ files ----

test("JSON: valid documents give no diagnostics", () => {
  for (const t of [
    `{"a": [1, -2.5e+3, true, false, null], "b": {"c": ""}}`,
    `"just a string"`,
    `0`,
    `-0.0e-0`,
    `[]`,
    `{}`,
    ` \t\r\n[ ]\n`,
    `"😀 \\uD83D\\uDE00 \\" \\\\ \\/ \\b \\f \\n \\r \\t"`,
    `[[[[[]]]]]`,
  ])
    assert.deepEqual(checkJson(t, "json"), [], t);
});

test("JSON: each error at its place, in UTF-16 offsets", () => {
  assert.deepEqual(firstError(`{"a": "b`), { from: 6, message: "閉じていない文字列" });
  assert.deepEqual(firstError(`[1, 2,]`), { from: 5, message: "末尾のカンマ" });
  assert.deepEqual(firstError(`{"a" 1}`), { from: 5, message: "コロンがない" });
  assert.deepEqual(firstError(`["\\x41"]`), { from: 2, message: "使えないエスケープ" });
  assert.deepEqual(firstError(`["a\tb"]`), { from: 3, message: "文字列の中の制御文字" });
  assert.deepEqual(firstError(`[01]`), { from: 1, message: "先頭に 0 が続く数" });
  assert.deepEqual(firstError(`{} []`), { from: 3, message: "値の後に余計な文字がある" });
  assert.deepEqual(firstError(``), { from: 0, message: "空の文書" });
  assert.deepEqual(firstError(`   `), { from: 3, message: "空の文書" });
  assert.deepEqual(firstError(`[1 2]`), { from: 3, message: "カンマか閉じ括弧がない" });
  assert.deepEqual(firstError(`{"a": 1`), { from: 7, message: "閉じていない括弧" });
  assert.deepEqual(firstError(`{a: 1}`), { from: 1, message: "キーが文字列でない" });
  assert.deepEqual(firstError(`[tru]`), { from: 1, message: "使えない文字" });
  assert.deepEqual(firstError(`[1.]`), { from: 1, message: "数の書き方の誤り" });
  assert.deepEqual(firstError(`// c\n1`), { from: 0, message: "コメントは JSON では使えない" });
  assert.deepEqual(firstError(`["😀", x]`), { from: 7, message: "使えない文字" });
});

test("a repeated key is a warning at the second key, in every kind", () => {
  for (const k of ["json", "jsonc", "json5"] as const) {
    const w = warnings(`{"a": 1, "a": 2}`, k);
    assert.deepEqual(w.map((d) => [d.from, d.message]), [[9, "キーが重なっている"]], k);
  }
  // the same key in different objects is fine; escapes are decoded before comparing
  assert.deepEqual(warnings(`[{"a": 1}, {"a": 2}]`), []);
  assert.deepEqual(warnings(`{"a": 1, "\\u0061": 2}`).length, 1);
  assert.deepEqual(warnings(`{"a": 1}\n{"a": 1, "a": 2}\n`, "jsonl").map((d) => d.from), [18]);
});

// ---- JSONC ----

test("JSONC: comments are allowed, a trailing comma is a warning, an open block comment an error", () => {
  assert.deepEqual(checkJson(`// head\n{"a": 1, /* x */ "b": [2] // tail\n}`, "jsonc"), []);
  assert.deepEqual(warnings(`{"a": [1,],}`, "jsonc").map((d) => [d.from, d.message]), [
    [8, "末尾のカンマ"],
    [10, "末尾のカンマ"],
  ]);
  assert.deepEqual(errors(`{"a": [1,],}`, "jsonc"), []);
  assert.deepEqual(firstError(`{"a": 1} /* never closed`, "jsonc"), { from: 9, message: "閉じていないコメント" });
});

// ---- JSON5 1.0.0; cases after json5-tests ----

test("JSON5: its additions are accepted", () => {
  for (const t of [
    `{unquoted: 'single', $id: "x", _a1: 1, trailing: [1, 2,],}`,
    `// comment\n{/* block */ a: 0x1F, b: .5, c: 5., d: +1, e: -Infinity, f: NaN, g: +NaN, h: 1e3}`,
    `'line \\\ncontinued'`,
    `'\\x41 \\v \\0 \\q \\u3042'`,
    `{ひらがな: 1}`,
    ` [ ]﻿`,
  ])
    assert.deepEqual(checkJson(t, "json5"), [], t);
});

test("JSON5: what it still refuses", () => {
  assert.deepEqual(firstError(`{a: 1,,}`, "json5"), { from: 6, message: "値がない" });
  assert.deepEqual(firstError(`['a\nb']`, "json5"), { from: 1, message: "閉じていない文字列" });
  assert.deepEqual(firstError(`[\\1]`, "json5"), { from: 1, message: "使えない文字" });
  assert.deepEqual(firstError(`['\\1']`, "json5"), { from: 2, message: "使えないエスケープ" });
  assert.deepEqual(firstError(`[0x]`, "json5"), { from: 1, message: "数の書き方の誤り" });
  assert.deepEqual(firstError(`[01]`, "json5"), { from: 1, message: "先頭に 0 が続く数" });
  assert.deepEqual(firstError(`{1: 2}`, "json5"), { from: 1, message: "キーが文字列か名前でない" });
  assert.deepEqual(firstError(`{a: undefined}`, "json5"), { from: 4, message: "使えない文字" });
});

// ---- JSON Lines ----

test("JSON Lines: one value per line, a final line break allowed, each line checked on its own", () => {
  assert.deepEqual(checkJson(`{"a": 1}\n[2]\n"s"\n`, "jsonl"), []);
  assert.deepEqual(checkJson(`{"a": 1}\r\n[2]`, "jsonl"), []);
  const e = errors(`{"a": 1}\n\n[2,]\n{"b"}\n`, "jsonl");
  assert.deepEqual(e.map((d) => [d.from, d.message]), [
    [9, "空の行"],
    [12, "末尾のカンマ"],
    [19, "コロンがない"],
  ]);
  assert.deepEqual(firstError(``, "jsonl"), null);
});

// ---- formatting ----

test("JSON: formatted with two spaces, literals and key order kept, idempotent, with a final newline", () => {
  const src = `{"b":1.0,"a":[1,2,{"x":"\\u3042"}],"e":{},"f":[],"g":12345678901234567890}`;
  const out = `{
  "b": 1.0,
  "a": [
    1,
    2,
    {
      "x": "\\u3042"
    }
  ],
  "e": {},
  "f": [],
  "g": 12345678901234567890
}
`;
  assert.equal(formatJson(src, "json"), out);
  assert.equal(formatJson(out, "json"), out);
  assert.equal(formatJson(`  "s"  `, "json"), `"s"\n`);
});

test("formatting refuses a document with an error", () => {
  assert.equal(formatJson(`{"a": 1,}`, "json"), null);
  assert.equal(formatJson(``, "json"), null);
});

test("JSONC: comments stay on their own line or after their token; blank lines between members stay as one", () => {
  const src = `// settings
{"a":1, // after a


  /* own line */
  "b":[2,], "c": {} }`;
  const out = `// settings
{
  "a": 1, // after a

  /* own line */
  "b": [
    2,
  ],
  "c": {}
}
`;
  assert.equal(formatJson(src, "jsonc"), out);
  assert.equal(formatJson(out, "jsonc"), out);
});

test("JSON5: quotes, bare keys, trailing commas and continued strings are kept as written", () => {
  const src = `{a:'x',"b":0x1F,c:'one \\\ntwo',}`;
  const out = `{
  a: 'x',
  "b": 0x1F,
  c: 'one \\\ntwo',
}
`;
  assert.equal(formatJson(src, "json5"), out);
  assert.equal(formatJson(out, "json5"), out);
});

test("JSON Lines: each line made into one readable line, the lines kept in order", () => {
  assert.equal(formatJson(`{"a":1,"b":[1,2]}\n  [ ]\n"s"`, "jsonl"), `{"a": 1, "b": [1, 2]}\n[]\n"s"\n`);
  assert.equal(formatJson(`{"a":1}\n\n[2]`, "jsonl"), null);
});

// ---- ⌘S ----

test("⌘S formats first when the setting is on, and saves either way", async () => {
  const run = async (formatOnSave: boolean, result: "changed" | "same" | "error") => {
    const log: string[] = [];
    await formatThenSave({
      formatOnSave,
      format: () => (log.push("format"), result),
      save: async () => void log.push("save"),
      notify: (m) => void log.push(m),
    });
    return log;
  };
  assert.deepEqual(await run(true, "changed"), ["format", "整形しました", "save"]);
  assert.deepEqual(await run(true, "same"), ["format", "変更はありません", "save"]);
  assert.deepEqual(await run(true, "error"), ["format", "JSON に誤りがあるため整形しません", "save"]);
  assert.deepEqual(await run(false, "changed"), ["save"]);
});

test("a save that was not asked for (autosave) does not format (docs/adr/0021)", async () => {
  const steps: string[] = [];
  await formatThenSave({ formatOnSave: true, explicit: false, format: () => (steps.push("format"), "changed"), save: async () => void steps.push("save"), notify: () => {} });
  assert.deepEqual(steps, ["save"]);
});

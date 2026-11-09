import { test } from "node:test";
import assert from "node:assert/strict";
import { checkText, defaultProofread, englishWords, segments, spellDiags, toAsk, type ProofreadConfig } from "./proofread.ts";

const texts = (kind: string, src: string) => segments(kind, src).map((s) => src.slice(s.from, s.to));
const all = defaultProofread();
const only = (rule: keyof ProofreadConfig["rules"]): ProofreadConfig => ({
  ...all,
  rules: Object.fromEntries(Object.keys(all.rules).map((k) => [k, k === rule])) as ProofreadConfig["rules"],
});
const found = (kind: string, src: string, rule: keyof ProofreadConfig["rules"]) => checkText(kind, src, only(rule)).map((d) => src.slice(d.from, d.to));

test(".gm: commands, expressions, comments, escapes and code are left out; prose slots, text and headings stay", () => {
  assert.deepEqual(texts("gm", "[ruby: 霧笛|むてき]は[= x]鳴る"), [" 霧笛", "むてき", "は", "鳴る"]);
  assert.deepEqual(texts("gm", "# 見出し"), [" 見出し"]);
  assert.deepEqual(texts("gm", "```\n見れる\n```\n本文"), ["本文"]);
});

test(".md: code, URLs and wikilink targets are left out", () => {
  assert.deepEqual(texts("md", "a `見れる` b [文](http://x.y) [[人物|父]]"), ["a ", " b [文", " [[", "|父]]"]);
  assert.deepEqual(texts("md", "```\n見れる\n```\n本文"), ["本文"]);
});

test("rules do not cross a left-out range, and positions are the document's (UTF-16)", () => {
  assert.deepEqual(found("gm", "、[= x]、", "punctuation"), []);
  const src = "𠮷、、";
  assert.deepEqual(checkText("txt", src, only("punctuation")).map((d) => [d.from, d.to]), [[2, 4]]);
});

test("ら抜き言葉: listed verbs with their endings; not the right form, nor other verbs", () => {
  assert.deepEqual(found("txt", "見れる。来れない。食べれます。出れた。寝れて", "raNuki"), ["見れる", "来れな", "食べれま", "出れた", "寝れて"].map((s) => s));
  assert.deepEqual(found("txt", "見られる。入れる。晴れる。見れば", "raNuki"), []);
  assert.match(checkText("txt", "見れる", only("raNuki"))[0].message, /見れる → 見られる/);
});

test("表記ゆれ: listed pairs and katakana long vowels, the fewer form marked", () => {
  const src = "できる。できる。出来る。サーバー。サーバー。サーバ。";
  assert.deepEqual(found("txt", src, "variants"), ["出来る", "サーバ"]);
  assert.match(checkText("txt", src, only("variants"))[0].message, /できる が 2 回/);
  assert.deepEqual(found("txt", "できる。できる。", "variants"), []);
  // as many of each: the one that came later
  assert.deepEqual(found("txt", "下さい。ください。", "variants"), ["ください"]);
});

test("punctuation runs, full-width letters, half-width katakana", () => {
  assert.deepEqual(found("txt", "あ、、い。。う、。え，，お", "punctuation"), ["、、", "。。", "、。", "，，"]);
  assert.deepEqual(found("txt", "あ、い。", "punctuation"), []);
  assert.deepEqual(found("txt", "ＡＢＣと１２３とabc", "fullwidth"), ["ＡＢＣ", "１２３"]);
  assert.deepEqual(found("txt", "ｶﾀｶﾅとカタカナとｶﾞ", "halfwidthKana"), ["ｶﾀｶﾅ", "ｶﾞ"]);
});

test("everything off, or one rule off", () => {
  const src = "見れる、、ＡＢ";
  assert.equal(checkText("txt", src, { ...all, enabled: false }).length, 0);
  assert.equal(checkText("txt", src, { ...all, rules: { ...all.rules, punctuation: false } }).some((d) => d.source === "punctuation"), false);
  assert.equal(checkText("txt", src, all).length, 3);
});

test("English words: two or more Latin letters, apostrophes inside; ignored words; the misspelled marked", () => {
  const src = "Hello, wrold! it's a [= x] teh";
  const ws = englishWords(segments("gm", src), src);
  assert.deepEqual(ws.map((w) => w.word), ["Hello", "wrold", "it's", "teh"]);
  const d = spellDiags(ws, new Set(["wrold", "teh"]), ["teh"]);
  assert.deepEqual(d.map((x) => src.slice(x.from, x.to)), ["wrold"]);
  assert.equal(d[0].source, "spelling");
});

test("image URLs in .md are left out; only words not asked yet are asked (docs/adr/0030)", () => {
  assert.deepEqual(texts("md", "見て ![図](images/見れる.png) です"), ["見て ![図", " です"]);
  const known = new Map([["hello", false]]);
  assert.deepEqual(toAsk(["hello", "wrold", "wrold"], known), ["wrold"]);
});

// docs/adr/0057: a vertical sheet writes letters and digits in full width
test("a vertical sheet gets no full-width letters and digits check", () => {
  const src = "一般寮とＳ４専用寮";
  assert.deepEqual(checkText("gm", src, only("fullwidth"), { vertical: true }), []);
  assert.deepEqual(checkText("gm", src, only("fullwidth")).map((d) => src.slice(d.from, d.to)), ["Ｓ４"]);
  assert.deepEqual(checkText("gm", src, only("fullwidth"), { vertical: false }).map((d) => src.slice(d.from, d.to)), ["Ｓ４"]);
});

test("a vertical sheet keeps the other checks", () => {
  const all = { ...only("punctuation"), rules: { ...only("punctuation").rules, halfwidthKana: true } };
  const src = "書く、、ｶﾅ";
  assert.deepEqual(
    checkText("txt", src, all, { vertical: true }).map((d) => d.source),
    ["punctuation", "halfwidthKana"],
  );
});

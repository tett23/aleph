import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTo, DEFAULT_COMPOSITION, parseKinsoku, resolveComposition, styleOf, targetOf } from "./composition.ts";

const ok = (kinsoku: string, hanging: boolean) => ({
  code: 0,
  stdout: `${JSON.stringify({ schema: 1, project: "/p", composition: { kinsoku, hangingPunctuation: hanging } })}\n`,
  stderr: "",
});

test("ADR 0090 I1: the values golem kinsoku printed are read", () => {
  assert.deepEqual(parseKinsoku(ok("loose", true)), { ok: { kinsoku: "loose", hanging: true } });
  assert.deepEqual(parseKinsoku(ok("strict", false)), { ok: { kinsoku: "strict", hanging: false } });
});

test("ADR 0090 I1: an error of style.toml, an old golem and a broken output are errors", () => {
  assert.deepEqual(parseKinsoku({ code: 1, stdout: "", stderr: "style.toml:2:1: error[G03021]: …\n" }), { error: "style.toml:2:1: error[G03021]: …" });
  assert.ok("error" in parseKinsoku({ code: 2, stdout: "", stderr: "未知の引数です: kinsoku\n" }));
  assert.ok("error" in parseKinsoku({ code: 0, stdout: "not json", stderr: "" }));
  assert.ok("error" in parseKinsoku({ code: 0, stdout: JSON.stringify({ schema: 2, composition: { kinsoku: "strict", hangingPunctuation: false } }), stderr: "" }));
  assert.ok("error" in parseKinsoku(ok("medium", false)));
});

test("ADR 0090 I1: the value is the latest one read, the default before any", () => {
  const strict = { kinsoku: "strict", hanging: false } as const;
  const loose = { kinsoku: "loose", hanging: true } as const;
  assert.deepEqual(resolveComposition(undefined, { ok: loose }), loose);
  assert.deepEqual(resolveComposition(strict, { ok: loose }), loose);
  assert.deepEqual(resolveComposition(loose, { error: "bad" }), loose);
  assert.deepEqual(resolveComposition(undefined, { error: "bad" }), DEFAULT_COMPOSITION);
  assert.deepEqual(DEFAULT_COMPOSITION, strict);
});

test("ADR 0090 I1: a project's .gm takes the project's values, other prose the default, code none", () => {
  assert.equal(targetOf("gm", "/w/p"), "project");
  assert.equal(targetOf("gm", null), "default");
  assert.equal(targetOf("md", "/w/p"), "default");
  assert.equal(targetOf("txt", null), "default");
  for (const k of ["toml", "json", "csv", "emet", "mermaid", "svg"]) assert.equal(targetOf(k, "/w/p"), null, k);
});

test("ADR 0090 I2, I3: strict wraps with WebKit's strict rules, hanging lets 。．、， hang at the line end", () => {
  assert.deepEqual(styleOf({ kinsoku: "strict", hanging: false }), { lineBreak: "strict", hangingPunctuation: "none" });
  assert.deepEqual(styleOf({ kinsoku: "strict", hanging: true }), { lineBreak: "strict", hangingPunctuation: "allow-end" });
  assert.deepEqual(styleOf(null), { lineBreak: "", hangingPunctuation: "" });
});

test("ADR 0090 I2: loose is WebKit's auto, which in lang=ja lets only ー and small kana start a line", () => {
  assert.deepEqual(styleOf({ kinsoku: "loose", hanging: false }), { lineBreak: "auto", hangingPunctuation: "none" });
  assert.deepEqual(styleOf({ kinsoku: "loose", hanging: true }), { lineBreak: "auto", hangingPunctuation: "allow-end" });
});

test("ADR 0090 I4: applying the values touches the view's style only, not the text, selection or history", () => {
  const calls: unknown[] = [];
  const core = new Proxy({}, { get: (_, k) => () => calls.push(`core.${String(k)}`) });
  const view = { setComposition: (c: unknown) => calls.push(c) };
  applyTo({ core, view } as never, { kinsoku: "strict", hanging: true });
  assert.deepEqual(calls, [{ kinsoku: "strict", hanging: true }]);
});

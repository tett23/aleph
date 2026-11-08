import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDiagnostics, sortDiagnostics, statusOf, type Diagnostic } from "./parse.ts";

const fixture = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

test("golem's recorded output: check, lint, preflight", () => {
  const c = parseDiagnostics(fixture("check-unknown-command.json"));
  assert.equal(c.raw, null);
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].code, "G02022");
  assert.equal(c.items[0].span?.line, 74);
  assert.deepEqual(parseDiagnostics(fixture("lint-clean.json")), { items: [], raw: null });
  const p = parseDiagnostics(fixture("preflight-no-intent.json"));
  assert.equal(p.items[0].severity, "error");
  assert.deepEqual(p.items[0].facts, { requirement: "出力インテント" });
});

test("output that is not a JSON array is kept as text", () => {
  assert.deepEqual(parseDiagnostics("golem: not found\n"), { items: [], raw: "golem: not found" });
  assert.deepEqual(parseDiagnostics('{"a":1}'), { items: [], raw: '{"a":1}' });
  assert.deepEqual(parseDiagnostics('[{"code":'), { items: [], raw: '[{"code":' });
  assert.deepEqual(parseDiagnostics(""), { items: [], raw: "" });
});

const d = (severity: Diagnostic["severity"], file?: string, line = 1): Diagnostic => ({ code: "G0", severity, message: "", span: file ? { file, line, column: 1 } : undefined });

test("sorted by severity, file, line", () => {
  const xs = [d("info", "b.gm", 1), d("warning", "b.gm", 9), d("error", "b.gm", 3), d("warning", "a.gm", 5), d("error", "b.gm", 2), d("notice")];
  assert.deepEqual(
    sortDiagnostics(xs).map((x) => [x.severity, x.span?.file ?? "", x.span?.line ?? 0]),
    [["error", "b.gm", 2], ["error", "b.gm", 3], ["warning", "a.gm", 5], ["warning", "b.gm", 9], ["notice", "", 0], ["info", "b.gm", 1]],
  );
});

test("the status bar's colour and count: info is not counted", () => {
  assert.deepEqual(statusOf({ items: [d("error"), d("warning"), d("info")], raw: null }), { cls: "ng", count: 2 });
  assert.deepEqual(statusOf({ items: [d("warning"), d("notice")], raw: null }), { cls: "warn", count: 2 });
  assert.deepEqual(statusOf({ items: [d("notice")], raw: null }), { cls: "notice", count: 1 });
  assert.deepEqual(statusOf({ items: [d("info")], raw: null }), { cls: "ok", count: 0 });
  assert.deepEqual(statusOf({ items: [], raw: null }), { cls: "ok", count: 0 });
  assert.deepEqual(statusOf({ items: [], raw: "golem: not found" }), { cls: "ng", count: 0 });
  assert.deepEqual(statusOf(null), { cls: "", count: 0 });
});

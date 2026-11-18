// Asking the assistant (docs/adr/0081): the prompt with its material within the limit (I9), and
// the golem check of an answer to a Golem file, asked again once when the errors increase.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_TOKENS, SEPARATOR } from "./material.ts";
import { commandList, messages, type Message } from "./prompt.ts";
import { addedErrors, askChecked, buildPrompt, checkedFile, errorsIn, retryRequest, type CheckRun } from "./request.ts";
import type { Diagnostic } from "../diag/parse.ts";

// One character is one token; the chat template adds nothing
const chars = { template: async (ms: Message[]) => ms.reduce((n, m) => n + [...m.content].length, 0), texts: async (ts: string[]) => ts.map((t) => [...t].length) };
const commands = [{ id: "settings.open", label: "設定" }];

const fixedOf = async (request: string, file: string, target: string) => chars.template(messages("", request, file, target));

test("ADR 0081 I9: the material is the command list then the ranked sections, within the limit counted from the fixed part", async () => {
  const sections = [
    { title: "前書き", text: "# 前書き\nなにもない" },
    { title: "行送り", text: "## 行送り\nline-pitch は行送り" },
  ];
  const request = "行送りを広げて";
  const target = 'line-pitch = "18H"\n';
  const fixed = await fixedOf(request, "style.toml", target);
  const list = commandList(commands);
  // room for the command list and the line-pitch section, not for the other
  const context = fixed + ANSWER_TOKENS + [...(list + SEPARATOR)].length + [...(sections[1].text + SEPARATOR)].length;
  const p = await buildPrompt({ commands, sections, request, file: "style.toml", target, context, count: chars });
  assert.equal(p.fixed, fixed);
  assert.equal(p.limit, context - fixed - ANSWER_TOKENS);
  assert.equal(p.material, list + SEPARATOR + sections[1].text + SEPARATOR);
  assert.deepEqual(p.messages, messages(p.material, request, "style.toml", target));
});

test("ADR 0081 I9: with no room, the material is empty", async () => {
  const p = await buildPrompt({ commands, sections: [{ title: "a", text: "# a" }], request: "頼み", file: "a.gm", target: "本文", context: 10, count: chars });
  assert.equal(p.limit, 0);
  assert.equal(p.material, "");
});

test("ADR 0081 I9: no sections give the command list alone", async () => {
  const fixed = await fixedOf("頼み", "a.csv", "x");
  const p = await buildPrompt({ commands, sections: [], request: "頼み", file: "a.csv", target: "x", context: fixed + ANSWER_TOKENS + 1000, count: chars });
  assert.equal(p.material, commandList(commands) + SEPARATOR);
});

test("ADR 0081: golem check runs for a project's .gm, style.toml and manifest.toml, not for .md or a sheet outside a project", () => {
  assert.equal(checkedFile({ path: "/w/p/chapters/01.gm", kind: "gm", project: "/w/p" }), "chapters/01.gm");
  assert.equal(checkedFile({ path: "/w/p/style.toml", kind: "toml", project: "/w/p" }), "style.toml");
  assert.equal(checkedFile({ path: "/w/p/manifest.toml", kind: "toml", project: "/w/p" }), "manifest.toml");
  assert.equal(checkedFile({ path: "/w/p/notes.md", kind: "md", project: "/w/p" }), null);
  assert.equal(checkedFile({ path: "/w/p/other.toml", kind: "toml", project: "/w/p" }), null);
  assert.equal(checkedFile({ path: "/w/a.gm", kind: "gm", project: null }), null);
});

const err = (file: string, code: string, message = code): Diagnostic => ({ code, severity: "error", message, span: { file, line: 1, column: 1 } });
const warn = (file: string, code: string): Diagnostic => ({ code, severity: "warning", message: code, span: { file, line: 1, column: 1 } });

test("ADR 0081: the errors counted are the target file's errors alone", () => {
  assert.equal(errorsIn([err("style.toml", "a"), err("manifest.toml", "b"), warn("style.toml", "c")], "style.toml").length, 1);
});

test("ADR 0081: the added errors are those after the edit that were not there before, each counted", () => {
  const before = [err("style.toml", "a")];
  const after = [err("style.toml", "a"), err("style.toml", "a"), err("style.toml", "b"), err("other.toml", "c")];
  assert.deepEqual(
    addedErrors(before, after, "style.toml").map((d) => d.code),
    ["a", "b"],
  );
  assert.deepEqual(addedErrors(after, before, "style.toml"), []);
});

test("ADR 0081: asking again adds the added diagnostics to the request", () => {
  const r = retryRequest("行送りを広げて", [{ ...err("style.toml", "E1", "値が正しくありません"), span: { file: "style.toml", line: 3, column: 1 } }]);
  assert.match(r, /^行送りを広げて/);
  assert.match(r, /golem check/);
  assert.match(r, /3 行/);
  assert.match(r, /値が正しくありません/);
});

const answer = (edits: { find: string; replace: string }[]) => ({ answer: JSON.stringify({ explanation: "直します。", edits }) });
const sheet = 'line-pitch = "18H"\n';
const target = { path: "/w/p/style.toml", scope: { kind: "sheet" as const }, from: 0, to: sheet.length };

// golem check that reports one error for each "BAD" in the text
const checkByBad: CheckRun = async (texts) => texts.map((t) => Array.from({ length: t.split("BAD").length - 1 }, () => err("style.toml", "bad")));

test("ADR 0081: an answer that keeps the errors is shown after one check, not asked again", async () => {
  const asked: string[] = [];
  const o = await askChecked({
    ask: async (r) => (asked.push(r), answer([{ find: '"18H"', replace: '"20H"' }])),
    request: "広げて",
    sheet,
    target,
    file: "style.toml",
    check: checkByBad,
  });
  assert.deepEqual(asked, ["広げて"]);
  assert.equal(o.after, 'line-pitch = "20H"\n');
  assert.deepEqual(o.check, { before: 0, after: 0, added: [], retried: false });
});

test("ADR 0081: when the errors increase, the request is asked again once with the added diagnostics", async () => {
  const asked: string[] = [];
  const replies = [answer([{ find: '"18H"', replace: "BAD" }]), answer([{ find: '"18H"', replace: '"20H"' }])];
  const o = await askChecked({ ask: async (r) => (asked.push(r), replies[asked.length - 1]), request: "広げて", sheet, target, file: "style.toml", check: checkByBad });
  assert.equal(asked.length, 2);
  assert.match(asked[1], /bad/);
  assert.equal(o.after, 'line-pitch = "20H"\n');
  assert.deepEqual(o.check, { before: 0, after: 0, added: [], retried: true });
});

test("ADR 0081: when the errors still increase after asking again, the answer is shown with the diagnostics", async () => {
  const asked: string[] = [];
  const o = await askChecked({
    ask: async (r) => (asked.push(r), answer([{ find: '"18H"', replace: "BAD BAD" }])),
    request: "広げて",
    sheet,
    target,
    file: "style.toml",
    check: checkByBad,
  });
  assert.equal(asked.length, 2);
  assert.ok(o.check && "added" in o.check);
  assert.equal(o.check && "after" in o.check ? o.check.after : -1, 2);
  assert.equal(o.check && "added" in o.check ? o.check.added.length : -1, 2);
  assert.equal(o.check && "retried" in o.check ? o.check.retried : false, true);
});

test("ADR 0081: when asking again gives nothing that applies, the first answer is shown with its diagnostics", async () => {
  const replies = [answer([{ find: '"18H"', replace: "BAD" }]), { answer: "not json" }];
  let n = 0;
  const o = await askChecked({ ask: async () => replies[n++], request: "広げて", sheet, target, file: "style.toml", check: checkByBad });
  assert.equal(n, 2);
  assert.equal(o.after, "line-pitch = BAD\n");
  assert.deepEqual(o.check && "added" in o.check ? o.check.added.map((d) => d.code) : null, ["bad"]);
});

test("ADR 0081: no check for a file outside the check, an answer without edits, or one that does not apply", async () => {
  let checked = 0;
  const check: CheckRun = async (ts) => (checked++, ts.map(() => []));
  const base = { request: "r", sheet, target, check };
  const a = await askChecked({ ...base, ask: async () => answer([{ find: '"18H"', replace: '"20H"' }]), file: null });
  assert.equal(a.check, null);
  const b = await askChecked({ ...base, ask: async () => answer([]), file: "style.toml" });
  assert.equal(b.check, null);
  assert.equal(b.after, null);
  const c = await askChecked({ ...base, ask: async () => answer([{ find: "nothing", replace: "x" }]), file: "style.toml" });
  assert.equal(c.check, null);
  assert.match(c.reason ?? "", /見つかりません/);
  assert.equal(checked, 0);
});

test("ADR 0081: when golem check cannot run, the answer is shown and the check says why", async () => {
  const o = await askChecked({ ask: async () => answer([{ find: '"18H"', replace: '"20H"' }]), request: "r", sheet, target, file: "style.toml", check: async (ts) => ts.map(() => null) });
  assert.equal(o.after, 'line-pitch = "20H"\n');
  assert.ok(o.check && "failed" in o.check);
});

test("ADR 0081 I4: asking and checking never touch the sheet's text", async () => {
  const o = await askChecked({ ask: async () => answer([{ find: '"18H"', replace: "BAD" }]), request: "r", sheet, target, file: "style.toml", check: checkByBad });
  assert.equal(sheet, 'line-pitch = "18H"\n');
  assert.notEqual(o.after, sheet);
});

test("ADR 0081: the edits of a selection apply inside the selection", async () => {
  const text = "a = 1\na = 1\n";
  const t = { path: "/w/p/style.toml", scope: { kind: "selection" as const, text: "a = 1\n" + "a" }, from: 0, to: 7 };
  const o = await askChecked({ ask: async () => answer([{ find: "a = 1", replace: "a = 2" }]), request: "r", sheet: text, target: t, file: null, check: checkByBad });
  assert.equal(o.after, "a = 2\na = 1\n");
});

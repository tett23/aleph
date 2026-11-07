import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { API_VERSION, createHost } from "./host.ts";

const src = (n: string) => ({ name: n, source: readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8") });
const importer = (source: string) => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const cur = { path: "/w/p/chapters/01.gm", kind: "gm", text: "短い。これは少し長い文です。", project: "/w/p" };
type Rec = { version: number; saves: string[]; command?: string };
const g = globalThis as unknown as { recorded: Rec };

test("a plugin's command, status and save handler are called with the open sheet", async () => {
  const toasts: string[] = [];
  const host = createHost((m) => toasts.push(m));
  const r = await host.load([src("records.js")], [], importer);
  assert.deepEqual(r, [{ name: "records.js", state: "ok" }]);
  assert.equal(g.recorded.version, API_VERSION);
  assert.deepEqual(host.commands().map((c) => c.label), ["記録"]);
  await host.commands()[0].run(cur);
  assert.equal(g.recorded.command, cur.path);
  assert.deepEqual(host.status(cur), ["記録 gm"]);
  host.saved(cur);
  assert.deepEqual(g.recorded.saves, [cur.path]);
});

test("the sample plugin: the longest sentence", async () => {
  const toasts: string[] = [];
  const host = createHost((m) => toasts.push(m));
  await host.load([src("longest-sentence.js")], [], importer);
  assert.deepEqual(host.status(cur), ["最長の文 10 字"]);
  await host.commands()[0].run(cur);
  assert.deepEqual(toasts, ["最長の文：これは少し長い文です"]);
});

test("failing plugins are turned off alone, with the reason; the others work", async () => {
  const toasts: string[] = [];
  const host = createHost((m) => toasts.push(m));
  const r = await host.load([src("throws.js"), src("no-activate.js"), src("syntax-error.js"), src("records.js")], [], importer);
  assert.deepEqual(r.map((x) => x.state), ["failed", "failed", "failed", "ok"]);
  assert.match(r[0].error!, /壊れています/);
  assert.match(r[1].error!, /activate/);
  assert.ok(r[2].error);
  // what the failed plugin registered before throwing is gone
  assert.deepEqual(host.status(cur), ["記録 gm"]);
  assert.equal(toasts.length, 3);
});

test("a disabled plugin is not loaded", async () => {
  const host = createHost(() => {});
  const r = await host.load([src("records.js")], ["records.js"], importer);
  assert.deepEqual(r, [{ name: "records.js", state: "disabled" }]);
  assert.deepEqual(host.commands(), []);
});

test("a handler that throws does not break the status bar or the app", async () => {
  const toasts: string[] = [];
  const host = createHost((m) => toasts.push(m));
  await host.load([src("bad-handlers.js"), src("longest-sentence.js")], [], importer);
  assert.deepEqual(host.status(cur), ["最長の文 10 字"]);
  await host.commands()[0].run(cur);
  assert.match(toasts[0], /bad-handlers\.js.*command/);
});

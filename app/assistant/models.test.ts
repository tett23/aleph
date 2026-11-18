// The 「アシスタント」 section of the settings (docs/adr/0081, モデルの管理).
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelsHtml, sizeLabel, type ModelInfo } from "./models.ts";

const m = (id: string, o: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id.toUpperCase(),
  size: 1_000_000,
  license: "Apache-2.0",
  default: false,
  installed: false,
  inUse: false,
  downloading: false,
  ...o,
});

const list = [
  m("small"),
  m("mid", { installed: true }),
  m("load", { downloading: true }),
  m("big", { default: true, installed: true, inUse: true }),
];

test("ADR 0081 I10: the settings offer no way to delete the default model", () => {
  const html = modelsHtml(list);
  assert.doesNotMatch(html, /data-delete="big"/);
  assert.doesNotMatch(html, /data-download="big"/);
  assert.match(html, /同梱/);
});

test("ADR 0081: a model not installed can be downloaded, an installed one deleted", () => {
  const idle = modelsHtml(list.filter((x) => !x.downloading));
  assert.match(idle, /data-download="small"/);
  assert.doesNotMatch(idle, /data-delete="small"/);
  assert.match(idle, /data-delete="mid"/);
  assert.doesNotMatch(idle, /data-download="mid"/);
  // one download at a time: none offered while one runs
  const html = modelsHtml(list);
  assert.doesNotMatch(html, /data-download=/);
  assert.match(html, /data-delete="mid"/);
  assert.match(html, /ダウンロード中/);
});

test("ADR 0081 I10: the model to use is chosen from the installed ones, the one in use selected", () => {
  const html = modelsHtml(list);
  const select = /<select[^>]*data-model[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
  const options = [...select.matchAll(/<option value="([^"]+)"( selected)?/g)].map((x) => [x[1], Boolean(x[2])]);
  assert.deepEqual(options, [["mid", false], ["big", true]]);
});

test("ADR 0081: names and errors are escaped", () => {
  const html = modelsHtml([m("x", { name: "<b>", default: true, installed: true, inUse: true })], "<失敗>");
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /&lt;失敗&gt;/);
  assert.doesNotMatch(html, /<b>/);
});

test("sizes are shown in MB or GB", () => {
  assert.equal(sizeLabel(396_705_472), "397 MB");
  assert.equal(sizeLabel(2_740_937_888), "2.7 GB");
});

// The 「アシスタント」 section of the settings (docs/adr/0081, モデルの管理).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConnectorInfo } from "../api.ts";
import { connectorRow, connectorRowHtml, modelsHtml, sizeLabel, type ModelInfo } from "./models.ts";

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

// ---- the connector rows (docs/adr/0089)

const c = (found: boolean, approved: boolean): ConnectorInfo => ({ id: "claude", name: "Claude Code", found, approved });

test("ADR 0089 I5: found and approved: 「承認しています」, with the button", () => {
  assert.deepEqual(connectorRow(c(true, true)), { state: "承認しています", revocable: true });
  const html = connectorRowHtml(c(true, true));
  assert.match(html, /Claude Code/);
  assert.match(html, /承認しています/);
  assert.match(html, /<span class="btn" data-revoke="claude">承認を取り消す<\/span>/);
});

test("ADR 0089 I5: found and not approved: 「承認していません」, without the button", () => {
  assert.deepEqual(connectorRow(c(true, false)), { state: "承認していません", revocable: false });
  const html = connectorRowHtml(c(true, false));
  assert.match(html, /承認していません/);
  assert.doesNotMatch(html, /data-revoke/);
});

test("ADR 0089 I5: not found and approved: 「見つかりません (承認しています)」, with the button", () => {
  assert.deepEqual(connectorRow(c(false, true)), { state: "見つかりません (承認しています)", revocable: true });
  const html = connectorRowHtml(c(false, true));
  assert.match(html, /見つかりません \(承認しています\)/);
  assert.match(html, /data-revoke="claude"/);
});

test("ADR 0089 I5: not found and not approved: 「見つかりません」, without the button", () => {
  assert.deepEqual(connectorRow(c(false, false)), { state: "見つかりません", revocable: false });
  const html = connectorRowHtml(c(false, false));
  assert.match(html, /見つかりません/);
  assert.doesNotMatch(html, /承認/);
  assert.doesNotMatch(html, /data-revoke/);
});

test("ADR 0089: the section shows the rows of Claude Code and Codex after the models, without the local connector", () => {
  const connectors: ConnectorInfo[] = [
    { id: "local", name: "ローカル", found: true, approved: true },
    { id: "claude", name: "Claude Code", found: true, approved: true },
    { id: "codex", name: "Codex", found: false, approved: false },
  ];
  const html = modelsHtml(list, "", connectors);
  assert.doesNotMatch(html, /ローカル<\/div>/);
  assert.ok(html.indexOf("Claude Code") > html.indexOf("BIG"));
  assert.ok(html.indexOf("Codex") > html.indexOf("Claude Code"));
  assert.match(html, /data-revoke="claude"/);
  assert.doesNotMatch(html, /data-revoke="codex"/);
});

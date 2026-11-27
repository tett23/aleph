import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createHost } from "./host.ts";

const runtime = readFileSync(new URL("./frame.js", import.meta.url), "utf8");
const sandboxSource = readFileSync(new URL("./sandbox.ts", import.meta.url), "utf8");

test("ADR 0115 I3: the sandbox CSP hash matches its inline runtime", () => {
  const hash = createHash("sha256").update(runtime).digest("base64");
  assert.match(sandboxSource, new RegExp(`sha256-${hash.replace(/[+/=]/g, "\\$&")}`));
  assert.doesNotMatch(runtime, /<\/script/i);
});
const boot = (parent: object, tauri = false) => {
  let start: (event: unknown) => void = () => {};
  const window = {
    parent,
    addEventListener: (_name: string, handler: (event: unknown) => void) => { start = handler; },
    removeEventListener: () => {},
  };
  runInNewContext(runtime, { window, ...(tauri ? { __TAURI_INTERNALS__: {} } : {}) });
  const messages: unknown[] = [];
  start({ source: parent, data: { type: "init", source: "export function activate() {}" }, ports: [{ postMessage: (message: unknown) => messages.push(message) }] });
  return JSON.parse(JSON.stringify(messages));
};

test("ADR 0115 I3: the plugin frame rejects inherited Tauri IPC", () => {
  assert.deepEqual(boot({}, true), [{ type: "failed", error: "隔離したフレームから Tauri IPC に届きます" }]);
});

test("ADR 0115 I3: the plugin frame rejects accessible parent DOM", () => {
  assert.deepEqual(boot({ document: {} }), [{ type: "failed", error: "親画面の DOM に届きます" }]);
});

test("ADR 0115 I3, ADR 0120 I2: a plugin receives only the host's message port", async (t) => {
  const ports: MessagePort[] = [];
  const requests: string[] = [];
  const host = createHost(() => {}, () => {}, async (_source, receive) => {
    const channel = new MessageChannel();
    ports.push(channel.port2);
    channel.port1.onmessage = ({ data }) => receive(data);
    channel.port2.postMessage({ type: "ready" });
    return { port: channel.port1, close: () => channel.port1.close() };
  }, {
    authorize: async (_channel, path) => { requests.push(path); return false; },
    close: async () => {},
  });
  t.after(() => {
    host.close();
    ports.forEach((port) => port.close());
  });
  const result = await host.load([{ name: "one.js", open: async () => ({ channel: "one", source: "ignored" }) }], []);
  assert.equal(result[0].state, "ok");
  assert.equal(ports.length, 1);
  ports[0].postMessage({ type: "invoke", command: "read_text", path: "/private" });
  ports[0].postMessage({ type: "register-command", id: 1, label: "late" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(host.commands(), []);
  assert.deepEqual(requests, []);
});

test("ADR 0115 I3: the plugin bootstrap hash in both Tauri CSPs matches the script", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const runtime = readFileSync(new URL("./frame.js", import.meta.url));
  const hash = "'sha256-" + createHash("sha256").update(runtime).digest("base64") + "'";
  const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const sandbox = readFileSync(new URL("./sandbox.ts", import.meta.url), "utf8");
  assert.ok(sandbox.includes(hash));
  for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
    assert.ok(policy.split(";").some((entry: string) => entry.trim().startsWith("script-src ") && entry.includes(hash)));
  }
});

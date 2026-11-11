import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("ADR 0073 invariant 2: settings remove, restore and directly re-add Escape without losing other shortcuts", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  const previous = globalThis.window;
  const previousDocument = globalThis.document;
  const dim = { remove() {}, addEventListener(_name: string, callback: (e: unknown) => void) {
    queueMicrotask(() => callback({ button: 0, target: { closest: (s: string) => s === "[data-i]" ? { dataset: { i: "0" } } : null } }));
  } };
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), { setTimeout }),
    document: Object.assign(new EventTarget(), { createElement: () => ({ content: { firstElementChild: dim } }), body: { append() {} } }),
  });
  try {
    const { mountKeybind, cleanKeyBindings } = await server.ssrLoadModule("/app/keybind.ts");
    const { normalize } = await server.ssrLoadModule("/app/config.ts");
    const id = "editor.dismissCompletion";
    const command = { id, label: "サジェストを閉じる", scope: "editor", keyContexts: ["completionVisible"], keys: ["Escape", "Ctrl-e"] };
    const ctx = { settings: [], status: [], commands: [command], store: { get: () => ({}) }, editors: new Map(), config: normalize({}), saveConfig: async () => {} };
    mountKeybind(ctx);
    type Section = { render: (c: unknown) => string; onClick: (t: unknown, c: unknown) => Promise<boolean> };
    const section = ctx.settings[0] as Section;
    const reload = () => {
      ctx.config = normalize(JSON.parse(JSON.stringify(ctx.config)));
      cleanKeyBindings(ctx);
      return ctx.config.keyBindings[id] ?? command.keys;
    };
    const click = (dataset: Record<string, string>) =>
      section.onClick({ closest: () => ({ dataset }) }, ctx);
    await click({ kbRm: id, kbI: "1" });
    assert.deepEqual(reload(), ["Escape"]);
    await click({ kbReset: id });
    const recording = click({ kbAdd: id });
    for (const key of ["F8", "Enter"]) window.dispatchEvent(Object.assign(new Event("keydown"), { key, code: key }));
    await recording;
    assert.deepEqual(reload(), ["Escape", "Ctrl-e", "F8"]);
    await click({ kbRm: id, kbI: "0" });
    assert.deepEqual(reload(), ["Ctrl-e", "F8"]);
    assert.match(section.render(ctx), /Esc を追加/);
    assert.doesNotMatch(section.render(ctx), /value="completionHidden"/);
    await click({ kbEscape: id });
    assert.deepEqual(reload(), ["Ctrl-e", "F8", "Escape"]);
    for (let i = 0; i < 3; i++) await click({ kbRm: id, kbI: "0" });
    assert.deepEqual(reload(), []);
    await click({ kbReset: id });
    assert.deepEqual(reload(), ["Escape", "Ctrl-e"]);
  } finally {
    Object.assign(globalThis, { window: previous, document: previousDocument });
    await server.close();
  }
});

test("ADR 0073 invariants 2 and 6: broadening a shortcut asks before replacing an overlapping mapping; cancel keeps both", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false } });
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  let prompts = 0;
  const dialog = {
    remove() {},
    addEventListener(_name: string, callback: (e: unknown) => void) {
      queueMicrotask(() => callback({ target: { closest: (s: string) => s === "[data-x]" } }));
    },
  };
  Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), {
      createElement: () => ({ content: { firstElementChild: dialog } }),
      body: { append: () => { prompts++; } },
    }),
  });
  try {
    const { mountKeybind } = await server.ssrLoadModule("/app/keybind.ts");
    const { normalize } = await server.ssrLoadModule("/app/config.ts");
    const visible = { key: "F8", context: "completionVisible" };
    const hidden = { key: "F8", context: "completionHidden" };
    const ctx = { settings: [], status: [], commands: [{ id: "one" }, { id: "two" }],
      config: normalize({ keyBindings: { one: [visible], two: ["F9", hidden] } }), saveConfig: async () => {} };
    mountKeybind(ctx);
    const section = ctx.settings[0] as { onChange: (el: unknown, c: unknown) => Promise<boolean> };
    const change = (value: string) => section.onChange({ dataset: { kbContext: "two", kbI: "1" }, value }, ctx);
    await change("completionHidden");
    assert.equal(prompts, 0);
    await change("editor");
    assert.equal(prompts, 1);
    assert.deepEqual(ctx.config.keyBindings, { one: [visible], two: ["F9", hidden] });
  } finally {
    Object.assign(globalThis, { window: oldWindow, document: oldDocument });
    await server.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import type { Command } from "./commands.ts";

test("ADR 0073 invariants 1, 3, 5: a visible suggestion consumes Ctrl+E once; the next press moves to line end", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { dispatchKey } = await server.ssrLoadModule("/app/keybind.ts");
    let visible = true;
    const ran: string[] = [];
    const edit = {
      completionVisible: () => visible,
      hasCommand: () => true,
      command: (id: string) => {
        ran.push(id);
        if (id === "editor.dismissCompletion") visible = false;
        return true;
      },
      view: { focus: () => {} },
    };
    const ctx = {
      commands: [
        { id: "editor.dismissCompletion", keys: ["Escape", "Ctrl-e"], keyContexts: ["completionVisible"], scope: "editor", when: () => true, run: () => edit.command("editor.dismissCompletion") },
        { id: "editor.moveToLineEnd", keys: [{ key: "Ctrl-e", context: "completionHidden" }], keyContexts: ["editor"], scope: "editor", when: () => true, run: () => edit.command("editor.moveToLineEnd") },
      ],
      config: { keyBindings: {}, leaderKey: "Mod-;", keySequenceTimeout: 1000 },
      store: { get: () => ({ open: [{ path: "/w/a.md" }], focus: 0 }) },
      editors: new Map([["/w/a.md", { edit }]]),
      refresh: () => {},
    };
    const ctrlE = () => ({ key: "e", code: "KeyE", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0 });
    assert.equal(dispatchKey(ctx, ctrlE(), true), true);
    assert.deepEqual(ran, ["editor.dismissCompletion"]);
    assert.equal(dispatchKey(ctx, ctrlE(), true), true);
    assert.deepEqual(ran, ["editor.dismissCompletion", "editor.moveToLineEnd"]);
    assert.equal(dispatchKey(ctx, ctrlE(), false), false);
  } finally {
    await server.close();
  }
});

test("ADR 0073 invariants 1 and 5: the actual command registry has two context-specific shortcuts", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { mountCommands } = await server.ssrLoadModule("/app/palette.ts");
    const ctx = { commands: [] as Command[], settings: [], store: { get: () => ({ open: [] }) }, editors: new Map() };
    mountCommands(ctx);
    const dismissal = ctx.commands.find((command: { id: string }) => command.id === "editor.dismissCompletion");
    const movement = ctx.commands.find((command: { id: string }) => command.id === "editor.moveToLineEnd");
    assert.deepEqual(dismissal?.keys, ["Escape", "Ctrl-e"]);
    assert.deepEqual(dismissal?.keyContexts, ["completionVisible"]);
    assert.deepEqual(movement?.keys, [{ key: "Ctrl-e", context: "completionHidden" }]);
    assert.deepEqual(movement?.keyContexts, ["editor"]);
  } finally {
    await server.close();
  }
});

test("ADR 0073 invariant 6: a waiting sequence loses old candidates without gaining a new context's candidates", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout } });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { dispatchKey, keyContextChanged } = await server.ssrLoadModule("/app/keybind.ts");
    let visible = true;
    const ran: string[] = [];
    const commands = [
      { id: "editor.visible", keys: [{ key: "Ctrl-j g", context: "completionVisible" }], scope: "editor", when: () => true, run: () => ran.push("visible") },
      { id: "editor.hidden", keys: [{ key: "Ctrl-j g", context: "completionHidden" }], scope: "editor", when: () => true, run: () => ran.push("hidden") },
      { id: "editor.shared", keys: [{ key: "Ctrl-j h", context: "editor" }], scope: "editor", when: () => true, run: () => ran.push("shared") },
    ];
    const ctx = {
      commands,
      config: { keyBindings: {}, leaderKey: "Mod-;", keySequenceTimeout: 1000 },
      store: { get: () => ({ open: [{ path: "/w/a.md" }], focus: 0 }) },
      editors: new Map([["/w/a.md", { edit: { completionVisible: () => visible } }]]),
      refresh: () => {},
    };
    const event = (key: string) => ({ key, code: `Key${key.toUpperCase()}`, ctrlKey: key === "j", metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0 });
    assert.equal(dispatchKey(ctx, event("j"), true), true);
    visible = false;
    keyContextChanged(ctx, true);
    assert.equal(dispatchKey(ctx, event("g"), true), false);
    assert.deepEqual(ran, []);
    visible = true;
    assert.equal(dispatchKey(ctx, event("j"), true), true);
    visible = false;
    keyContextChanged(ctx, true);
    assert.equal(dispatchKey(ctx, event("h"), true), true);
    assert.deepEqual(ran, ["shared"]);
  } finally {
    await server.close();
  }
});

test("ADR 0073 invariants 1 and 3: compositionstart cancels a waiting sequence and IME keys cannot expire it", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel" } });
  const oldWindow = globalThis.window;
  const oldPerformance = globalThis.performance;
  const listeners = new Map<string, ((event: Event) => void)[]>();
  let now = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: () => 1,
      addEventListener: (type: string, listener: (event: Event) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    },
  });
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => now } });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { dispatchKey, mountKeybind } = await server.ssrLoadModule("/app/keybind.ts");
    const ran: string[] = [];
    const ctx = {
      commands: [
        { id: "short", keys: ["Ctrl-j"], scope: "global", when: () => true, run: () => ran.push("short") },
        { id: "long", keys: ["Ctrl-j g"], scope: "global", when: () => true, run: () => ran.push("long") },
      ],
      config: { keyBindings: {}, leaderKey: "Mod-;", keySequenceTimeout: 1000 },
      store: { get: () => ({ open: [] }) },
      editors: new Map(),
      refresh: () => {},
      status: [] as (() => string)[],
      settings: [],
    };
    mountKeybind(ctx);
    const prefix = () => ({ key: "j", code: "KeyJ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0 });
    const imeKey = () => ({ key: "Enter", code: "Enter", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: true, keyCode: 229 });

    assert.equal(dispatchKey(ctx, prefix(), false), true);
    assert.match(ctx.status[0](), /keyseq/);
    assert.equal(listeners.get("compositionstart")?.length, 1);
    listeners.get("compositionstart")?.[0](new Event("compositionstart"));
    assert.equal(ctx.status[0](), "");
    now = 1001;
    assert.equal(dispatchKey(ctx, imeKey(), false), false);
    assert.deepEqual(ran, []);

    now = 2000;
    assert.equal(dispatchKey(ctx, prefix(), false), true);
    now = 3001;
    assert.equal(dispatchKey(ctx, imeKey(), false), false);
    assert.equal(ctx.status[0](), "");
    assert.deepEqual(ran, []);
  } finally {
    await server.close();
    Object.defineProperty(globalThis, "window", { configurable: true, value: oldWindow });
    Object.defineProperty(globalThis, "performance", { configurable: true, value: oldPerformance });
  }
});

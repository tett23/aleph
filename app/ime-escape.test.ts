import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

type Listener = (e: KeyboardEvent) => void;

test("ADR 0092 I1, I2, I3: composing Escape leaves the new sheet question and background keys alone", async () => {
  const captures = new EventTarget();
  const bubbles = new EventTarget();
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const dialogs = new Set<EventTarget>();

  const inputDialog = () => {
    const input = Object.assign(new EventTarget(), { focus() {}, select() {}, value: "" });
    const dialog = Object.assign(new EventTarget(), {
      querySelector: () => input,
      remove: () => dialogs.delete(dialog),
    });
    return { input, dialog };
  };
  let current = inputDialog();
  Object.assign(globalThis, {
    window: {
      addEventListener: (name: string, listener: Listener, capture?: boolean) =>
        (capture ? captures : bubbles).addEventListener(name, listener as EventListener),
    },
    document: {
      createElement: () => ({ content: { firstElementChild: current.dialog } }),
      body: { append: (dialog: EventTarget) => dialogs.add(dialog) },
    },
  });

  // Node's EventTarget doesn't implement DOM ancestry or phases. Send the
  // event along the three relevant steps of the window → field → window path.
  const emit = (target: EventTarget, type: string, keyCode = 27, isComposing = false) => {
    let stopped = false;
    const e = Object.assign(new Event(type, { cancelable: true }), {
      key: "Escape", code: "Escape", keyCode, isComposing,
      stopImmediatePropagation: () => { stopped = true; },
    });
    Object.defineProperty(e, "target", { value: target });
    captures.dispatchEvent(e);
    if (!stopped) target.dispatchEvent(e);
    if (!stopped) bubbles.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: "custom" });
  try {
    const { ask } = await server.ssrLoadModule("/app/ui/dom.ts");
    const { mountKeybind } = await server.ssrLoadModule("/app/keybind.ts");
    mountKeybind({
      commands: [], status: [], settings: [], editors: new Map(),
      config: { keyBindings: {}, leaderKey: "Mod-;", keySequenceTimeout: 1000 },
      store: { get: () => ({ modal: true, open: [] }) },
      refresh: () => {},
    });
    let backgroundKeys = 0;
    bubbles.addEventListener("keydown", () => backgroundKeys++);
    let resolved = false;
    const result = ask("新しいシートの名前").then((value: string | null) => {
      resolved = true;
      return value;
    });

    emit(current.input, "compositionstart");
    assert.equal(emit(current.input, "keydown"), false);
    assert.equal(emit(current.input, "keydown", 27, true), false);
    emit(current.input, "compositionend");
    assert.equal(emit(current.input, "keydown", 229), false);
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.equal(dialogs.has(current.dialog), true);
    assert.equal(backgroundKeys, 0);

    emit(current.input, "keydown");
    assert.equal(await result, null);
    assert.equal(dialogs.size, 0);
    assert.equal(backgroundKeys, 1);

    current = inputDialog();
    const abandoned = current;
    const first = ask("新しいシートの名前");
    emit(abandoned.input, "compositionstart");
    emit(abandoned.input, "blur");
    emit(new EventTarget(), "focus");
    emit(abandoned.input, "focus");
    emit(abandoned.input, "keydown");
    assert.equal(await first, null);

    current = inputDialog();
    void ask("名前を変える");
    emit(current.input, "compositionstart");
    current.dialog.remove();
    current = inputDialog();
    const second = ask("新しいシートの名前");
    emit(current.input, "keydown");
    assert.equal(await second, null);
    assert.equal(dialogs.size, 0);
  } finally {
    Object.assign(globalThis, { window: oldWindow, document: oldDocument });
    await server.close();
  }
});

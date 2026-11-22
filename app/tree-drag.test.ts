import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import type { Ctx } from "./ctx.ts";

test("ADR 0103 I1, I5, ADR 0100 I6: one preview and at most one outcome per press", async () => {
  const server = await createServer({
    configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false },
    plugins: [{
      name: "tree-drag-test",
      enforce: "pre",
      resolveId(source, importer) {
        if (!importer?.endsWith("/dragout.ts")) return;
        if (source === "./tree-move-flow.ts") return "virtual:tree-drag-move";
        if (source === "./ui/tree.ts") return "virtual:tree-drag-tree";
      },
      load(id) {
        if (id === "virtual:tree-drag-move") return "export const moveTreeItem = (...a) => globalThis.testTreeMove(...a);";
        if (id === "virtual:tree-drag-tree") return "export const handedOverFrom = (_c,p) => [p]; export const reloadTree = () => {}; export const treeEntries = () => [];";
      },
    }],
  });
  const globals = globalThis as typeof globalThis & { testTreeMove?: (...a: unknown[]) => void };
  const previous = { document: globals.document, window: globals.window, innerWidth: globals.innerWidth, innerHeight: globals.innerHeight };
  const calls: unknown[][] = [];
  const from = "/w/source/a.gm";
  const to = "/w/target";
  const tree = { classList: { add() {}, remove() {} } };
  const source = { dataset: { file: from }, closest: () => source, querySelector: () => null };
  const previews = new Set<object>();
  const createElement = () => {
    const el = {
      style: {}, setAttribute() {}, append() {}, classList: { toggle() {} },
      remove: () => previews.delete(el), getBoundingClientRect: () => ({ width: 30, height: 20 }),
    };
    return el;
  };
  const count = () => previews.size;
  let workspace = "/w";
  let workspaceChanged = () => {};
  const store = {
    get: () => ({ workspace, workspaces: ["/w", "/other"] }),
    subscribe: (listener: (s: { workspace: string }) => void) => {
      workspaceChanged = () => listener({ workspace });
      return () => { workspaceChanged = () => {}; };
    },
  };
  const notifications: unknown[] = [];
  let nativeFails = false;
  const dir = {
    dataset: { dir: to }, classList: tree.classList,
    closest: (selector: string) => selector === ".file-tree" ? tree : dir,
  };
  let overTree = true;
  const doc = Object.assign(new EventTarget(), { elementFromPoint: () => overTree ? dir : null,
    createElement, body: { classList: tree.classList, append: (...elements: object[]) => elements.forEach((el) => previews.add(el)) } });
  const wind = new EventTarget();
  Object.assign(globals, { document: doc, window: wind, innerWidth: 100, innerHeight: 100 });
  globals.testTreeMove = (_ctx, file, folder) => {
    assert.equal(count(), 0, "preview is gone before a move can show a confirmation");
    calls.push(["move", file, folder]);
    return new Promise(() => {});
  };
  const mouse = (type: string, x: number, pointerId?: number) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: x, clientY: 10 });
    if (pointerId !== undefined) Object.assign(event, { pointerId, pointerType: "mouse", buttons: 0 });
    Object.defineProperty(event, "target", { value: source });
    doc.dispatchEvent(event);
  };
  const click = (detail: number) => {
    const event = Object.assign(new Event("click", { cancelable: true }), { detail });
    doc.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    api.dragOut = async (paths: string[]) => {
      assert.equal(count(), 0, "preview is gone before native handoff");
      calls.push(["native", ...paths]);
      if (nativeFails) throw new Error("native start failed");
    };
    const { mountDragOut } = await server.ssrLoadModule("/app/dragout.ts");
    mountDragOut({ store, projects: [], notify: (notification: unknown) => notifications.push(notification) } as unknown as Ctx);
    mouse("mousedown", 5);
    mouse("mouseup", 5);
    assert.equal(count(), 0);
    assert.equal(click(1), false);
    mouse("mousedown", 5);
    mouse("mousemove", 8);
    assert.equal(count(), 0);
    mouse("mousemove", 9);
    assert.equal(count(), 1);
    mouse("mousemove", 12);
    assert.equal(count(), 1);
    mouse("mouseup", 12);
    assert.equal(count(), 0);
    assert.equal(click(0), false);
    assert.equal(click(1), true);
    calls.length = 0;
    mouse("mousedown", 5);
    mouse("mousemove", 50);
    mouse("mouseup", 50);
    mouse("mouseup", 50);
    mouse("mousemove", 120);
    assert.deepEqual(calls, [["move", from, to]]);
    nativeFails = true;
    mouse("mousedown", 5);
    mouse("mousemove", 50);
    assert.equal(count(), 1);
    mouse("mousemove", 120);
    assert.equal(count(), 0);
    await Promise.resolve();
    assert.equal(notifications.length, 1);
    mouse("mousemove", 50);
    mouse("mouseup", 50);
    assert.equal(count(), 0);
    assert.deepEqual(calls, [["move", from, to], ["native", from]]);
    mouse("mousedown", 5);
    mouse("mousemove", 50);
    doc.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));
    mouse("mouseup", 50);
    assert.equal(click(1), true);
    mouse("mousedown", 5);
    overTree = false;
    mouse("mousemove", 50);
    mouse("mouseup", 50);
    assert.deepEqual(calls, [["move", from, to], ["native", from]]);
    overTree = true;
    mouse("pointerdown", 5, 7);
    mouse("mousedown", 5);
    mouse("pointermove", 50, 8);
    mouse("pointerup", 50, 8);
    mouse("pointermove", 50, 7);
    assert.equal(count(), 1);
    mouse("mousemove", 50);
    assert.equal(count(), 1);
    mouse("pointerup", 50, 7);
    assert.equal(count(), 0);
    mouse("mouseup", 50);
    mouse("mousedown", 5);
    mouse("pointerdown", 5, 9);
    mouse("pointermove", 50, 9);
    mouse("pointerup", 50, 9);
    for (const stop of [
      () => mouse("pointercancel", 50, 10),
      () => wind.dispatchEvent(new Event("blur")),
      () => { workspace = "/other"; workspaceChanged(); workspace = "/w"; workspaceChanged(); },
    ]) {
      mouse("pointerdown", 5, 10);
      mouse("mousedown", 5);
      mouse("pointermove", 50, 10);
      assert.equal(count(), 1);
      stop();
      assert.equal(count(), 0);
      mouse("pointermove", 60, 10);
      mouse("pointerup", 60, 10);
      mouse("mouseup", 60);
      assert.equal(count(), 0);
    }
    assert.deepEqual(calls, [["move", from, to], ["native", from], ["move", from, to], ["move", from, to]]);
  } finally {
    await server.close();
    Object.assign(globals, previous);
    delete globals.testTreeMove;
  }
});

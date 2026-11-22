import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import type { Ctx } from "./ctx.ts";

test("ADR 0100 I6: each pointer press finishes as either one internal move or one native handoff", async () => {
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
  const source = { dataset: { file: from }, closest: () => source };
  const dir = {
    dataset: { dir: to }, classList: tree.classList,
    closest: (selector: string) => selector === ".file-tree" ? tree : dir,
  };
  let overTree = true;
  const doc = Object.assign(new EventTarget(), { elementFromPoint: () => overTree ? dir : null });
  const wind = new EventTarget();
  Object.assign(globals, { document: doc, window: wind, innerWidth: 100, innerHeight: 100 });
  globals.testTreeMove = (_ctx, file, folder) => calls.push(["move", file, folder]);
  const mouse = (type: string, x: number, pointerId?: number) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: x, clientY: 10 });
    if (pointerId !== undefined) Object.assign(event, { pointerId, pointerType: "mouse", buttons: 0 });
    Object.defineProperty(event, "target", { value: source });
    doc.dispatchEvent(event);
  };
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    api.dragOut = async (paths: string[]) => { calls.push(["native", ...paths]); };
    const { mountDragOut } = await server.ssrLoadModule("/app/dragout.ts");
    mountDragOut({ store: { get: () => ({ workspace: "/w", workspaces: ["/w"] }) }, projects: [] } as unknown as Ctx);
    mouse("mousedown", 5);
    mouse("mousemove", 50);
    mouse("mouseup", 50);
    mouse("mouseup", 50);
    mouse("mousemove", 120);
    assert.deepEqual(calls, [["move", from, to]]);
    mouse("mousedown", 5);
    mouse("mousemove", 120);
    mouse("mousemove", 50);
    mouse("mouseup", 50);
    assert.deepEqual(calls, [["move", from, to], ["native", from]]);
    mouse("mousedown", 5);
    mouse("mousemove", 50);
    doc.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" }));
    mouse("mouseup", 50);
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
    mouse("pointerup", 50, 7);
    mouse("mouseup", 50);
    mouse("mousedown", 5);
    mouse("pointerdown", 5, 9);
    mouse("pointermove", 50, 9);
    mouse("pointerup", 50, 9);
    assert.deepEqual(calls, [["move", from, to], ["native", from], ["move", from, to], ["move", from, to]]);
  } finally {
    await server.close();
    Object.assign(globals, previous);
    delete globals.testTreeMove;
  }
});

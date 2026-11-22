import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import type { Ctx } from "./ctx.ts";

test("ADR 0100 I5, I7: a stale note editor and its pending timer cannot overwrite moved metadata", async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false } });
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: globalThis });
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    const { forgetMeta, mountAttach } = await server.ssrLoadModule("/app/attach.ts");
    const { createStore, initialState } = await server.ssrLoadModule("/app/store.ts");
    const { normalize } = await server.ssrLoadModule("/app/config.ts");
    const root = "/workspace";
    const store = createStore({ ...initialState(), workspace: root, workspaces: [root] });
    store.dispatch({ type: "open", docs: [{ path: root + "/source.md", workspace: root, project: null, text: "", saved: "", kind: "md", grid: { chars: 40, lines: 16, vertical: false } }] });
    let disk = '{"source.md":{"note":"before","done":[]},"keep.md":{"note":"another sheet","done":[]}}';
    api.readText = async () => disk;
    api.makeDir = async () => {};
    api.writeText = async (_path: string, text: string) => { disk = text; };
    const ctx = {
      store, config: normalize({}), projects: [], beforeRename: [], onRename: [],
      rightSidebar: {}, status: [], decor: [], settings: [], editors: new Map(), toast() {}, refresh() {},
    } as unknown as Ctx;
    mountAttach(ctx);
    const panel = { innerHTML: "", oninput: (_: unknown) => {} };
    await ctx.rightSidebar.attach!.render(panel as unknown as HTMLElement, ctx);
    panel.oninput({ target: { dataset: { note: "" }, value: "pending" } });
    const after = '{"dest/source.md":{"note":"pending","done":[]},"keep.md":{"note":"another sheet","done":[]}}';
    disk = after;
    forgetMeta(root);
    panel.oninput({ target: { dataset: { note: "" }, value: "stale editor" } });
    await new Promise((resolve) => setTimeout(resolve, 460));
    assert.equal(disk, after);
  } finally {
    await server.close();
    Object.assign(globalThis, { window: previousWindow });
  }
});

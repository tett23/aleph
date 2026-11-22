import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import type { EditorPlugin } from "../ed/editor.ts";
import { createCore } from "../ed/core.ts";
import { createStore, initialState, type Doc } from "../store.ts";
import { uriOf } from "./protocol.ts";

test("ADR 0101 I5: an attached standalone editor gains LSP features when its workspace becomes a project", async () => {
  const sent: { method: string; params: unknown }[] = [];
  const starts: string[] = [];
  let emitDiagnostics!: (uri: string, list: unknown[]) => void;
  const old = globalThis as typeof globalThis & { __alephLspFixture?: object };
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { addEventListener() {}, setTimeout } });
  old.__alephLspFixture = {
    start: (root: string, handlers: { onDiagnostics: typeof emitDiagnostics }) => {
      starts.push(root);
      emitDiagnostics = handlers.onDiagnostics;
    },
    notify: (method: string, params: unknown) => sent.push({ method, params }),
  };
  const server = await createServer({
    configFile: false, server: { middlewareMode: true, ws: false }, appType: "custom",
    plugins: [{
      name: "workspace-lsp-test", enforce: "pre",
      resolveId: (source, importer) => source === "./client.ts" && importer?.endsWith("/lsp/mount.ts") ? "virtual:workspace-lsp-test" : null,
      load: (id) => id === "virtual:workspace-lsp-test" ? `
        export const startClient = (root, handlers) => {
          const fixture = globalThis.__alephLspFixture;
          fixture.start(root, handlers);
          let state = "starting";
          return {
            ready: Promise.resolve().then(() => { state = "ready"; return true; }), state: () => state,
            legend: () => ({ tokenTypes: ["function"], tokenModifiers: [] }),
            notify: fixture.notify,
            request: async (method) => ({
              "textDocument/hover": { contents: "hovered" },
              "textDocument/completion": [{ label: "candidate" }],
              "textDocument/semanticTokens/full": { data: [0, 0, 1, 0, 0] },
            })[method],
          };
        }; ` : null,
    }],
  });
  try {
    const { mountLsp } = await server.ssrLoadModule("/app/lsp/mount.ts");
    const root = "/w/book";
    const path = root + "/draft.gm";
    const original = "@ab";
    const store = createStore({ ...initialState(), workspace: root, workspaces: [root] });
    const grid = { chars: 40, lines: 20, vertical: false };
    const doc: Doc = { path, workspace: root, project: null, kind: "gm", text: original, saved: original, grid };
    const core = createCore(original);
    const painted: string[] = [];
    const ctx = {
      store, editorPlugins: [] as ((doc: Doc, ctx: unknown) => EditorPlugin | null)[],
      refresh() {}, onRename: [], status: [], settings: [], titles: new Map(),
    };
    store.dispatch({ type: "open", docs: [doc] });
    mountLsp(ctx);
    const plugin = ctx.editorPlugins[0](doc, ctx);
    assert.ok(plugin, "the standalone sheet has a dormant LSP plugin");
    const detach = plugin.attach?.({
      core,
      setLayer: (source: string) => painted.push(source),
      setFallbackColors: (enabled: boolean) => painted.push(String(enabled)),
      setDiagnostics: (diags: { message: string }[]) => painted.push(...diags.map((d) => d.message)),
    } as unknown as Parameters<NonNullable<EditorPlugin["attach"]>>[0]);
    assert.deepEqual(starts, []);
    assert.deepEqual(plugin.keys, []);
    core.apply([{ from: original.length, insert: "c" }], "input.type");
    core.select({ anchor: 2, head: 4 });
    store.dispatch({ type: "edit", path, text: core.text() });

    store.dispatch({ type: "projectInitialized", root, grid });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(starts, [root]);
    assert.ok(sent.some(({ method, params }) => method === "textDocument/didOpen" && JSON.stringify(params).includes(core.text())));
    emitDiagnostics(uriOf(path), [{ message: "diagnostic", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]);
    assert.ok(painted.includes("st") && painted.includes("false") && painted.includes("diagnostic"));
    assert.equal(await plugin.hover?.(2), "hovered");
    assert.equal((await plugin.complete?.(4, true))?.items[0].label, "candidate");
    assert.ok(plugin.keys?.some(({ id }) => id === "editor.format"));
    assert.deepEqual(core.sel(), { anchor: 2, head: 4 });
    core.undo();
    assert.equal(core.text(), original);
    detach?.();
  } finally {
    Object.assign(globalThis, { window: previousWindow });
    delete old.__alephLspFixture;
    await server.close();
  }
});

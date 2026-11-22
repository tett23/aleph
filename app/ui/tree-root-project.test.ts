import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import type { Ctx } from "../ctx.ts";
import type { Doc } from "../store.ts";
import { normalize } from "../config.ts";

test("ADR 0101 I3, I5: the current root uses one initialization and the existing tab keeps its edit", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: "custom" });
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    const { createStore, initialState } = await server.ssrLoadModule("/app/store.ts");
    const { runTreeAct, workspaceProjectItem } = await server.ssrLoadModule("/app/ui/tree.ts");
    const { mountCommands } = await server.ssrLoadModule("/app/palette.ts");
    const root = "/w/book";
    const previous = root + "/draft.gm";
    const store = createStore({ ...initialState(), workspace: root, workspaces: [root, "/w/other"] });
    const notifications: string[] = [];
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const calls: string[] = [];
    let initialized = false;
    api.initializeWorkspaceProject = async (target: string) => {
      calls.push(target);
      await completion;
      initialized = true;
    };
    api.listTree = async (path: string) => initialized && path === root
      ? [{ path: root + "/manifest.toml", name: "manifest.toml", dir: false, children: [] }]
      : [];
    api.readText = async (path: string) => {
      if (path.endsWith("/style.toml")) return '[page]\nwriting-mode = "vertical"\n[page.grid]\ncharacters = 24\n';
      if (path.endsWith("/manifest.toml")) return 'chapters = ["chapters/01.gm"]\n';
      throw new Error("an open sheet was read from disk");
    };
    const ctx = {
      store, config: normalize({}), projects: [], titles: new Map(),
      commands: [], settings: [], editors: new Map(),
      onNewProject: [(path: string) => { assert.equal(path, root); }],
      open: () => { throw new Error("an existing editor was replaced"); },
      notify: (notice: { message: string }) => notifications.push(notice.message),
      refresh() {},
    } as unknown as Ctx;
    const doc: Doc = { path: previous, workspace: root, project: null, kind: "gm", text: "draft", saved: "draft", grid: { chars: 40, lines: 16, vertical: false } };
    store.dispatch({ type: "open", docs: [doc] });
    store.dispatch({ type: "edit", path: previous, text: "unwritten edit" });
    const tab = store.get().panes[0].tabs[0].id;

    mountCommands(ctx);
    const command = ctx.commands.find((c) => c.id === "file.initializeWorkspaceProject");
    assert.ok(command);
    assert.equal(command.when(store.get()), true);
    assert.equal(command.when({ ...store.get(), workspace: null }), false);
    assert.equal(workspaceProjectItem(ctx, "/w/other"), null);
    assert.equal(workspaceProjectItem(ctx, root)?.label, "Golem プロジェクトに初期化");
    const first = command.run(ctx);
    await runTreeAct(ctx, "init-project");
    assert.deepEqual(calls, [root]);
    finish();
    await first;
    assert.deepEqual(ctx.projects, [root]);
    assert.equal(store.get().panes[0].tabs[0].id, tab);
    assert.deepEqual(store.get().open[0], { ...doc, text: "unwritten edit", project: root, grid: { chars: 24, lines: 16, vertical: true } });
    assert.ok(notifications.some((s) => s.includes("初期化しました")));
    await runTreeAct(ctx, "init-project");
    assert.deepEqual(calls, [root]);
    assert.ok(notifications.some((s) => s.includes("すでに")));
  } finally {
    await server.close();
  }
});

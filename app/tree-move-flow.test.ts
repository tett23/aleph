import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import type { Ctx } from "./ctx.ts";
import type { TreeMoveDiskPlan } from "./api.ts";
import type { MoveRequest, MoveResponse } from "./lsp/file-move.ts";
import type { Doc, Store } from "./store.ts";

test("ADR 0100 I2, I4, I5, I7: complete cross-project move, cancellation and failed-plan rollback", async () => {
  const server = await createServer({
    configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false },
    plugins: [{
      name: "move-flow-test",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.endsWith("/tree-move-flow.ts") && source === "./lsp/client.ts") return "virtual:move-flow-lsp";
        if (importer?.endsWith("/tree-move-flow.ts") && source === "./ui/dom.ts") return "virtual:move-flow-dialog";
      },
      load(id) {
        if (id === "virtual:move-flow-lsp") return "export const startClient = () => globalThis.moveFlowClient;";
        if (id === "virtual:move-flow-dialog") return "export const confirmDialog = async () => globalThis.moveFlowConfirmed;";
      },
    }],
  });
  const globals = globalThis as typeof globalThis & { moveFlowConfirmed?: boolean; moveFlowClient?: unknown };
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    const { createCore } = await server.ssrLoadModule("/app/ed/core.ts");
    const { moveTreeItem } = await server.ssrLoadModule("/app/tree-move-flow.ts");
    const { createStore, initialState } = await server.ssrLoadModule("/app/store.ts");
    const { uriOf } = await server.ssrLoadModule("/app/lsp/protocol.ts");
    const root = "/w";
    const from = "/w/a/draft";
    const to = "/w/b/draft";
    const source = from + "/one.gm";
    const destination = to + "/one.gm";
    const index = "/w/index.md";
    const a = "/w/a/manifest.toml";
    const b = "/w/b/manifest.toml";
    const workspace = [root];
    const disk = new Map([
      [a, 'chapters = [["draft/one.gm"]]\n'], [b, 'chapters = ["keep.gm"]\n'],
      [source, "old chapter"], [index, "[[a/draft/one.gm]]"],
      ["/w/a/.aleph/notes.json", '{"draft/one.gm":{"note":"keep","goal":12}}'],
    ]);
    let beforeInventory = () => {};
    api.treeMoveInventory = async () => {
      beforeInventory();
      return {
        projects: ["/w/a", "/w/b"],
        entries: [{ path: index, name: "index.md", children: [], dir: false }],
      };
    };
    api.readText = async (path: string) => disk.get(path) ?? "";
    api.treeMoveRead = async (_root: string, path: string) => disk.get(path) ?? null;
    api.exists = async (path: string) => disk.has(path);
    const errors: string[] = [];
    let expected = "ok";
    let chapterText = "saved chapter";
    let plans: TreeMoveDiskPlan[] = [];
    api.treeMoveApply = async (plan: TreeMoveDiskPlan) => {
      plans.push(plan);
      if (expected === "rollback") return { moved: false, error: "metadata commit failed: /w/b/.aleph/notes.json", remainingWrites: [] };
      if (expected === "leftover") return { moved: true, error: "path rollback failed: /w/a/draft", remainingWrites: [] };
      return { moved: true, error: null, remainingWrites: [] };
    };
    const changedIndex = "[[b/draft/one.gm]]\nunsaved text";
    globals.moveFlowClient = {
      ready: Promise.resolve(true), supportsFileMove: () => true, stop() {},
      request: async (_method: string, req: MoveRequest): Promise<MoveResponse> => {
        assert.deepEqual([req.oldUri, req.newUri], [uriOf(from), uriOf(to)]);
        assert.equal(req.documents.find((d) => d.uri === uriOf(source))?.text, chapterText);
        if (expected === "server") throw { message: "Reference refused", data: { issues: [{ uri: uriOf(source), targetUri: uriOf(index), reason: "outside project" }] } };
        const documents = [...req.documents, ...[a, b].map((path) => ({ uri: uriOf(path), text: disk.get(path)!, version: null }))];
        const edit = (path: string, newText: string) => {
          const doc = documents.find((d) => d.uri === uriOf(path))!;
          const lines = doc.text.split("\n");
          return {
            textDocument: { uri: doc.uri, version: doc.version },
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, newText }],
          };
        };
        return {
          complete: true,
          groups: [
            { projectUri: uriOf("/w/a"), edits: [edit(a, "chapters = []\n")] },
            { projectUri: uriOf("/w/b"), edits: [edit(b, 'chapters = ["keep.gm", ["draft/one.gm"]]\n')] },
            { projectUri: null, edits: [edit(index, changedIndex)] },
          ],
          snapshot: { documents, projects: req.projects, wikiSheets: req.wikiSheets, directories: [] },
          chapters: [{ oldUri: uriOf(source), newUri: uriOf(destination), sourceProjectUri: uriOf("/w/a"), destinationProjectUri: uriOf("/w/b"), sourceIndices: [0, 0] }],
        };
      },
    };

    const run = async (scenario: string) => {
      expected = scenario;
      chapterText = "saved chapter";
      disk.set(source, "old chapter");
      globals.moveFlowConfirmed = scenario !== "cancel";
      plans = [];
      const store: Store = createStore({ ...initialState(), workspace: root, workspaces: workspace });
      const grid = { chars: 40, lines: 16, vertical: false };
      const chapter: Doc = { path: source, text: "saved chapter", saved: "old chapter", project: "/w/a", workspace: root, kind: "gm", grid };
      const wiki: Doc = { path: index, text: "[[a/draft/one.gm]]\nunsaved text", saved: "[[a/draft/one.gm]]", project: null, workspace: root, kind: "md", grid };
      store.dispatch({ type: "open", docs: [chapter, wiki] });
      const editors = new Map([chapter, wiki].map((doc) => {
        const core = createCore(doc.text);
        return [doc.path, { edit: { core, view: { composing: () => false },
          apply: (edits: { from: number; to: number; insert: string }[]) => {
            if (core.apply(edits, "move")) store.dispatch({ type: "edit", path: doc.path, text: core.text() });
          },
        }, text: core.text }] as const;
      }));
      let inventories = 0;
      beforeInventory = () => {
        if (++inventories !== 2 || scenario !== "late") return;
        const ed = editors.get(source)!;
        ed.edit.apply([{ from: 0, to: ed.text().length, insert: "late chapter edit" }]);
        chapterText = ed.text();
      };
      const original = store.get().panes[0].tabs[0].id;
      store.subscribe((state) => {
        if (state.open.some((d) => d.path === destination) && editors.has(source)) {
          const editor = editors.get(source)!;
          editors.delete(source);
          editors.set(destination, editor);
        }
      });
      const ctx = {
        store, editors, projects: ["/w/a", "/w/b"], beforeRename: [], onRename: [], refresh() {},
        toast() {}, notify: (notice: { message: string }) => errors.push(notice.message),
        save: async (paths: string[]) => {
          if (scenario === "save") return new Set();
          assert.deepEqual(paths, [source]);
          store.dispatch({ type: "saved", path: source, text: chapterText });
          disk.set(source, chapterText);
          return new Set(paths);
        },
      } as unknown as Ctx;
      const moved = await moveTreeItem(ctx, from, "/w/b", async () => {});
      assert.equal(moved, scenario === "ok" || scenario === "late" || scenario === "leftover", `moved ${scenario}`);
      assert.equal(store.get().panes[0].tabs[0].id, original);
      if (scenario === "ok" || scenario === "late" || scenario === "leftover") {
        const updated = store.get().open.find((d) => d.path === destination);
        assert.equal(updated?.project, "/w/b");
        assert.equal(updated?.text, chapterText);
        assert.equal(editors.get(index)?.text(), scenario === "leftover" ? wiki.text : changedIndex);
        assert.deepEqual(plans[0].writes.map(({ path }) => path), [a, b, "/w/a/.aleph/notes.json", "/w/b/.aleph/notes.json"]);
        assert.match(plans[0].writes[3].after, /draft\/one\.gm/);
      } else {
        assert.ok(store.get().open.some((d) => d.path === source));
        assert.equal(editors.get(index)?.text(), wiki.text);
        assert.equal(plans.length, scenario === "rollback" ? 1 : 0);
      }
    };
    for (const scenario of ["save", "cancel", "server", "rollback", "leftover", "ok", "late"]) await run(scenario);
    assert.ok(errors.some((e) => e.includes("outside project")));
    assert.ok(errors.some((e) => e.includes("metadata commit failed")));
    assert.ok(errors.some((e) => e.includes("path rollback failed")));
  } finally {
    await server.close();
    delete globals.moveFlowClient;
    delete globals.moveFlowConfirmed;
  }
});

// Compose the Golem plan, notes changes, disk transaction and receipt (ADR 0100).
import { api, type TreeMoveDiskPlan } from "./api.ts";
import { forgetMeta, freezeMetaForMove } from "./attach.ts";
import type { Ctx } from "./ctx.ts";
import { forgetGrid, gridOf } from "./docs.ts";
import { startClient } from "./lsp/client.ts";
import { applyFileRenamePlans } from "./lsp/file-rename.ts";
import { movePathOf, type MoveRequest, type MoveResponse } from "./lsp/file-move.ts";
import { allowedEdits, collectInventory, describe, liveDocuments, sameInventory } from "./move-plan.ts";
import { uriOf } from "./lsp/protocol.ts";
import { moveMetadataRoots, planMoveMetadata } from "./notes-move.ts";
import { forgetManifest, loadManifest } from "./separator.ts";
import { allDocs, type Doc, type Grid } from "./store.ts";
import { movedPath, treeDrop, withinMove } from "./tree-move.ts";
import { confirmDialog } from "./ui/dom.ts";
import { projectOf } from "./workspace.ts";

const active = new Set<string>();

type Follow = (ctx: Ctx) => Promise<void>;

export const moveTreeItem = async (ctx: Ctx, from: string, dir: string, refreshTree: Follow) => {
  const initial = ctx.store.get();
  const workspace = initial.workspace;
  if (!workspace) return;
  const target = treeDrop(from, dir, workspace, initial.workspaces, ctx.projects);
  if (target.kind === "noop") return;
  if (target.kind === "invalid") return ctx.notify({ message: target.reason, level: "warning" });
  if (active.size) return ctx.notify({ message: `${workspace} で移動を実行中です`, level: "warning" });
  active.add(workspace);
  const { to } = target;
  try {
    const tree = await api.treeMoveInventory(workspace);
    const current = treeDrop(from, dir, workspace, ctx.store.get().workspaces, tree.projects);
    if (current.kind !== "move") {
      if (current.kind === "invalid") throw new Error(current.reason);
      return;
    }
    if (await api.exists(to)) throw new Error(`同じ名前の項目があります：${to}`);
    const save = allDocs(ctx.store.get()).filter((d) => withinMove(d.path, from));
    if (save.some((d) => ctx.editors.get(d.path)?.edit?.view.composing()))
      throw new Error("日本語の変換を確定してから移動してください");
    const dirty = (d: Doc) => (ctx.editors.get(d.path)?.text() ?? d.text) !== d.saved;
    const changed = save.filter(dirty).map((d) => d.path);
    if (changed.length) {
      const written = await ctx.save(changed, { explicit: true });
      if (changed.some((p) => !written.has(p)) || allDocs(ctx.store.get()).some((d) => withinMove(d.path, from) && dirty(d))) return;
    }
    for (const before of ctx.beforeRename) await before(from, to, ctx);

    const client = startClient(workspace, { onDiagnostics() {}, onExit() {} }, undefined, workspace);
    try {
      if (!(await client.ready) || !client.supportsFileMove())
        throw new Error("Golem LSP が移動計画の契約版 1 に対応していません");
      for (let attempt = 0; attempt < 3; attempt++) {
        const updated = allDocs(ctx.store.get()).filter((d) => withinMove(d.path, from) && dirty(d));
        if (updated.length) {
          if (updated.some((d) => ctx.editors.get(d.path)?.edit?.view.composing()))
            throw new Error("日本語の変換を確定してから移動してください");
          const written = await ctx.save(updated.map((d) => d.path), { explicit: true });
          if (updated.some((d) => !written.has(d.path))) return;
        }
        const freshTree = await api.treeMoveInventory(workspace);
        const inventory = await collectInventory(workspace, freshTree);
        const live = liveDocuments(ctx, workspace);
        if ([...live].some(([path, doc]) => withinMove(path, from) && doc.text !== doc.doc.saved)) continue;
        const request: MoveRequest = {
          ...inventory, workspaceUri: uriOf(workspace), oldUri: uriOf(from), newUri: uriOf(to), inventoryComplete: true,
          documents: [...live].map(([path, { text, version }]) => ({ uri: uriOf(path), text, version })),
        };
        const response = await client.request<MoveResponse>("golem/planFileMove", request);
        const edits = allowedEdits(workspace, response);
        if (!sameInventory(inventory, response.snapshot)) throw new Error("Golem LSP の検査対象が一致しません");
        const disk: TreeMoveDiskPlan = { workspace, from, to, documents: [], directories: [], writes: [] };
        const latest = () => liveDocuments(ctx, workspace);
        const stable = () => {
          const now = latest();
          return now.size === live.size && [...live].every(([path, old]) => {
            const next = now.get(path);
            return next && next.text === old.text && next.identity === old.identity && next.version === old.version;
          });
        };
        if (!stable()) continue;
        let stale = false;
        for (const { uri, text, version } of response.snapshot.documents) {
          const path = movePathOf(workspace, uri);
          const old = live.get(path);
          if (old ? version !== old.version || text !== old.text : version !== null) {
            stale = true;
            break;
          }
          // The server can plan against a dirty buffer. Separately ensure that
          // the disk hasn't changed since the saved version of that buffer.
          disk.documents.push({ path, text: old?.doc.saved ?? text });
        }
        if (stale) continue;
        disk.directories = response.snapshot.directories.map(({ uri, entries }) => ({
          path: movePathOf(workspace, uri),
          entries: entries.map(({ uri, kind }) => ({ path: movePathOf(workspace, uri), kind })),
        }));
        const oldProjects = freshTree.projects;
        const fromProject = projectOf(from, oldProjects);
        const toProject = projectOf(to, oldProjects);
        for (const edit of edits) {
          const old = live.get(edit.path);
          if (old && old.doc.saved !== edit.before) {
            if (edit.path.endsWith("/manifest.toml")) throw new Error(`章登録を更新する前に保存してください：${edit.path}`);
          } else disk.writes.push({ path: edit.path, before: edit.before, after: edit.after });
        }
        const roots = moveMetadataRoots(workspace, from, to, oldProjects);
        const carriedProjects = oldProjects.filter((p) => withinMove(p, from));
        const metaRoots = [...new Set([...roots, ...carriedProjects, ...carriedProjects.map((p) => movedPath(p, from, to))])];
        const unfreeze = await freezeMetaForMove(metaRoots);
        try {
          const notes = new Map(await Promise.all(roots.map(async (root) => [root, await api.treeMoveRead(workspace, root + "/.aleph/notes.json")] as const)));
          disk.writes.push(...planMoveMetadata(workspace, from, to, oldProjects, notes));

          const projects = oldProjects.map((p) => movedPath(p, from, to));
          const movedProjects = oldProjects.filter((p) => withinMove(p, from));
          if (fromProject !== toProject && !movedProjects.includes(from)) {
            const chapters = response.chapters.map((chapter) => `・${movePathOf(workspace, chapter.oldUri)} → ${chapter.destinationProjectUri ? movePathOf(workspace, chapter.destinationProjectUri) : "章の登録を解除"}`);
            const message = [
              `${from} → ${to}`,
              `${fromProject ?? "プロジェクト外"} → ${toProject ?? "プロジェクト外"}`,
              ...(chapters.length ? ["章の登録を変更します。", ...chapters] : ["章の登録は変わりません。"]),
              "移動先のスタイルが適用され、原稿の見た目が変わる場合があります。",
            ].join("\n");
            if (!(await confirmDialog(message, "移動"))) return;
          }

          if (ctx.store.get().workspace !== workspace) return;
          if (!stable() || !sameInventory(inventory, await collectInventory(workspace, await api.treeMoveInventory(workspace))) || !stable()) continue;
          if ([...live.values()].some(({ edit }) => edit?.view.composing())) throw new Error("日本語の変換を確定してから移動してください");

          const locked = new Set([...edits, ...disk.writes].map((edit) => edit.path));
          ctx.moveLocked = (path) => withinMove(path, from) || withinMove(path, to) || locked.has(path);
          try {
            const editedOpen = edits.filter((edit) => live.has(edit.path));
            const undoText = await applyFileRenamePlans(editedOpen, {
              read: async (path) => ctx.editors.get(path)?.edit?.core.text() ?? allDocs(ctx.store.get()).find((d) => d.path === path)?.text ?? "",
              write: async (path, text, edit) => {
                const editor = ctx.editors.get(path)?.edit;
                if (!editor || editor.view.composing()) throw new Error(`開いている参照元を編集できません：${path}`);
                if (text === edit.after) editor.apply(edit.changes, "move-links");
                else editor.apply([{ from: 0, to: edit.after.length, insert: text }], "move-links");
              },
            });
            let receipt;
            try {
              receipt = await api.treeMoveApply(disk);
            } catch (error) {
              try { await undoText(); }
              catch (undo) { throw new Error(`${describe(error)}\n${describe(undo)}`); }
              if (describe(error).includes("計画取得後")) continue;
              throw error;
            }
            let rollbackError = "";
            if (receipt.error) {
              try { await undoText(new Set(receipt.remainingWrites)); }
              catch (undo) { rollbackError = `\n${describe(undo)}`; }
            }
            if (receipt.moved) {
              // Rebind immediately when the path moved, even if reconciliation
              // later fails or disk rollback left a partial operation.
              const grids: Record<string, Grid> = {};
              for (const root of projects) {
                forgetGrid(root);
                forgetManifest(root);
              }
              const newProjectList = [...ctx.projects.filter((p) => !oldProjects.includes(p)), ...projects];
              const previous = ctx.renameReferencesHandled;
              ctx.renameReferencesHandled = true;
              ctx.moveMetadataHandled = true;
              try {
                for (const root of metaRoots) forgetMeta(root);
                ctx.resetLspAfterMove?.([...oldProjects, ...projects]);
                ctx.store.dispatch({ type: "move", from, to, projects, grids });
                const failures: string[] = [];
                if (!receipt.error) for (const edit of editedOpen) {
                  if (disk.writes.some((write) => write.path === edit.path))
                    ctx.store.dispatch({ type: "saved", path: movedPath(edit.path, from, to), text: edit.after });
                }
                for (const follow of ctx.onRename) {
                  try { await follow(from, to, ctx); }
                  catch (error) { failures.push(describe(error)); }
                }
                ctx.projects = newProjectList;
                // Resolve new grids and re-read manifest-dependent previews after
                // all paths have already been moved in the store.
                await Promise.all(projects.map(async (root) => { grids[root] = await gridOf(root); await loadManifest(root); }));
                ctx.store.dispatch({ type: "moveGrids", grids });
                await refreshTree(ctx);
                ctx.refresh(["sidebar", "rightSidebar", "status", "previewTab"]);
                if (failures.length) ctx.notify({ message: failures.join("\n"), level: "warning", sticky: true });
              } finally {
                ctx.renameReferencesHandled = previous;
                ctx.moveMetadataHandled = false;
              }
            }
            if (receipt.error) throw new Error(receipt.error + rollbackError);
            ctx.toast(`${to} に移動しました`);
            return;
          } finally {
            delete ctx.moveLocked;
          }
        } finally {
          unfreeze();
        }
      }
      throw new Error("検査対象の変更が続いたため移動できませんでした");
    } finally {
      client.stop();
    }
  } catch (error) {
    ctx.notify({ message: `移動を完了できませんでした\n${describe(error)}`, level: "error", sticky: true });
  } finally {
    active.delete(workspace);
  }
};

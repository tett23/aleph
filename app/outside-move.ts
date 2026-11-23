// Moves made outside Aleph (docs/adr/0108): the open sheets, the metadata and the Golem LSP index follow a
// move that Rust paired from two renames, and the references are updated when the writer chooses.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { fingerprintOf, forgetGrid, gridOf, moveShown, shownOf } from "./docs.ts";
import type { Client } from "./lsp/client.ts";
import { applyFileRenamePlans, type FileEditPlan } from "./lsp/file-rename.ts";
import { movePathOf, type MoveInventory, type MoveResponse } from "./lsp/file-move.ts";
import { uriOf } from "./lsp/protocol.ts";
import { allowedEdits, collectInventory, describe, liveDocuments, sameInventory } from "./move-plan.ts";
import { moveMetadataRoots, planMoveMetadata, type MoveMetadata } from "./notes-move.ts";
import { forgetManifest, loadManifest } from "./separator.ts";
import { allDocs, type Grid } from "./store.ts";
import { movedPath, withinMove } from "./tree-move.ts";
import { projectOf, TEXT_KINDS, workspaceOf } from "./workspace.ts";

export type Move = { from: string; to: string };
export type PlanClient = Pick<Client, "ready" | "supportsMovedReferences" | "request" | "stop">;
/** What the flow uses that needs the screen or a process; the mount gives the real ones, tests give fakes. */
export type OutsideDeps = {
  client: (workspace: string) => PlanClient;
  freezeMeta: (roots: string[]) => Promise<() => void>;
  forgetMeta: (root: string) => void;
  clearStopped: (path: string) => void;
};

const related = (a: string, b: string) => withinMove(a, b) || withinMove(b, a);

/** I2: the moves that Aleph's own tree move is not making. */
export const unlocked = (moves: Move[], locked?: (path: string) => boolean) =>
  locked ? moves.filter((m) => !locked(m.from) && !locked(m.to)) : moves;

/** I10: no path of one move is, holds or lies in a path of another (no chain, no nesting). */
export const independent = (moves: Move[]) =>
  moves.every((m, i) => moves.every((n, j) => i === j || [m.from, m.to].every((p) => [n.from, n.to].every((q) => !related(p, q)))));

/** Whether a changed path is one of the moves', and so not followed as a change. */
export const consumed = (moves: Move[], path: string) => moves.some((m) => withinMove(path, m.from) || withinMove(path, m.to));

/** The moves of each workspace, in order. */
export const byWorkspace = (moves: Move[], workspaces: string[]) => {
  const out = new Map<string, Move[]>();
  for (const m of moves) {
    const w = workspaceOf(m.from, workspaces);
    if (w && w === workspaceOf(m.to, workspaces)) out.set(w, [...(out.get(w) ?? []), m]);
  }
  return out;
};

/** The notice that asks whether to update the references. */
export const askText = (moves: Move[], files: number) =>
  moves.length === 1
    ? `${moves[0].from} を ${moves[0].to} に移したことを検出しました。${files} 件のファイルの参照を新しい場所に更新しますか。`
    : `${moves.length} 件の移動を検出しました。${files} 件のファイルの参照を新しい場所に更新しますか。`;

const NOTES = "/.aleph/notes.json";
/** The words of an error, without the "Error:" of a plain one. */
const why = (error: unknown) => (error instanceof Error && !(error instanceof AggregateError) ? error.message : describe(error));

/** The notes and goals carried by the moves, from the plan only (I9); none move when one cannot. */
const moveMetadata = async (ctx: Ctx, deps: OutsideDeps, workspace: string, moves: Move[], oldProjects: string[]) => {
  const roots = [...new Set(moves.flatMap((m) => moveMetadataRoots(workspace, m.from, m.to, oldProjects)))];
  const unfreeze = await deps.freezeMeta(roots);
  try {
    let stores = new Map(await Promise.all(roots.map(async (r) => [r, await api.treeMoveRead(workspace, r + NOTES)] as const)));
    const writes = new Map<string, MoveMetadata>();
    for (const m of moves) {
      for (const w of planMoveMetadata(workspace, m.from, m.to, oldProjects, stores)) {
        writes.set(w.path, { path: w.path, before: writes.get(w.path)?.before ?? w.before, after: w.after });
        stores = new Map(stores).set(w.path.slice(0, -NOTES.length), w.after);
      }
    }
    if (!writes.size) return;
    const out = await api.treeMoveWrite({ workspace, documents: [], writes: [...writes.values()] });
    if (out.error) throw new Error(out.error);
  } catch (error) {
    ctx.notify({ level: "warning", sticky: true, message: `移したシートのノートと目標を移せませんでした。一件も移していません。\n${why(error)}` });
  } finally {
    unfreeze();
    roots.forEach(deps.forgetMeta);
  }
};

/**
 * The open sheets follow the moves (I4): a sheet whose file at the new path has its saved text, or for a PDF
 * or an image the bytes it shows, is rebound there with its unsaved edits, the rest stay and are returned to be followed as changes. The rest of the
 * rebinding, the metadata and the Golem LSP index follow every move.
 */
export const followMoves = async (ctx: Ctx, deps: OutsideDeps, moves: Move[]): Promise<string[]> => {
  const oldProjects = ctx.projects;
  const kept: string[] = [];
  for (const m of moves) {
    const docs = allDocs(ctx.store.get()).filter((d) => withinMove(d.path, m.from));
    const keep: string[] = [];
    for (const d of docs) {
      const to = movedPath(d.path, m.from, m.to);
      if (!TEXT_KINDS.includes(d.kind)) {
        // a PDF or an image: the bytes it shows, by their SHA-256
        const now = await fingerprintOf(to);
        if (!now || now !== shownOf(d.path)) keep.push(d.path);
        continue;
      }
      const disk = (await api.exists(to)) ? await api.readText(to).catch(() => null) : null;
      if (disk !== d.saved) keep.push(d.path);
    }
    kept.push(...keep);
    const projects = ctx.projects.map((p) => movedPath(p, m.from, m.to));
    projects.forEach((root) => (forgetGrid(root), forgetManifest(root)));
    ctx.store.dispatch({ type: "move", from: m.from, to: m.to, projects, grids: {}, keep });
    for (const d of docs) {
      if (keep.includes(d.path)) continue;
      deps.clearStopped(d.path);
      if (!TEXT_KINDS.includes(d.kind)) moveShown(d.path, movedPath(d.path, m.from, m.to));
    }
    ctx.projects = projects;
  }
  const previous = ctx.renameReferencesHandled;
  // the references change only by the Golem plan (I8), the notes and goals only by the metadata plan (I9)
  ctx.renameReferencesHandled = true;
  ctx.moveMetadataHandled = true;
  const failures: string[] = [];
  try {
    for (const m of moves) {
      for (const follow of ctx.onRename) {
        try {
          await follow(m.from, m.to, ctx);
        } catch (error) {
          failures.push(why(error));
        }
      }
    }
  } finally {
    ctx.renameReferencesHandled = previous;
    ctx.moveMetadataHandled = false;
  }
  // I7: before any answer, each project's connection hears the moves once, or starts again
  try {
    await ctx.renamedOutside?.(moves, oldProjects, ctx.projects);
  } catch (error) {
    failures.push(why(error));
  }
  for (const [workspace, list] of byWorkspace(moves, ctx.store.get().workspaces)) await moveMetadata(ctx, deps, workspace, list, oldProjects);
  const grids: Record<string, Grid> = {};
  const touched = [...new Set(moves.map((m) => projectOf(m.to, ctx.projects)).filter((p): p is string => !!p))];
  await Promise.all(touched.map(async (root) => {
    grids[root] = await gridOf(root);
    await loadManifest(root);
  }));
  ctx.store.dispatch({ type: "moveGrids", grids });
  ctx.refresh(["sidebar", "rightSidebar", "status", "previewTab"]);
  if (failures.length) ctx.notify({ message: failures.join("\n"), level: "warning", sticky: true });
  return kept;
};

type Planned = {
  inventory: MoveInventory;
  live: ReturnType<typeof liveDocuments>;
  response: MoveResponse;
  edits: FileEditPlan[];
};

const plan = async (ctx: Ctx, client: PlanClient, workspace: string, moves: Move[]): Promise<Planned> => {
  const inventory = await collectInventory(workspace, await api.treeMoveInventory(workspace));
  const live = liveDocuments(ctx, workspace);
  const response = await client.request<MoveResponse>("golem/planMovedReferences", {
    ...inventory,
    workspaceUri: uriOf(workspace),
    moves: moves.map((m) => ({ oldUri: uriOf(m.from), newUri: uriOf(m.to) })),
    documents: [...live].map(([path, { text, version }]) => ({ uri: uriOf(path), text, version })),
    inventoryComplete: true,
  });
  const edits = allowedEdits(workspace, response);
  if (!sameInventory(inventory, response.snapshot)) throw new Error("Golem LSP の検査対象が一致しません");
  return { inventory, live, response, edits };
};

/** Whether the plan still holds: the same inventory, open sheets and snapshot texts. */
const current = async (ctx: Ctx, workspace: string, p: Planned) => {
  if (!sameInventory(p.inventory, await collectInventory(workspace, await api.treeMoveInventory(workspace)))) return false;
  const now = liveDocuments(ctx, workspace);
  if (now.size !== p.live.size || [...p.live].some(([path, old]) => {
    const next = now.get(path);
    return !next || next.text !== old.text || next.version !== old.version || next.identity !== old.identity;
  })) return false;
  return p.response.snapshot.documents.every(({ uri, text, version }) => {
    const old = p.live.get(movePathOf(workspace, uri));
    return old ? version === old.version && text === old.text : version === null;
  });
};

/** Applies a plan that holds: the open sheets in their editors, the closed ones on the disk; "stale" if the disk moved on. */
const apply = async (ctx: Ctx, workspace: string, p: Planned): Promise<"done" | "stale"> => {
  const open = p.edits.filter((e) => p.live.has(e.path));
  const closed = p.edits.filter((e) => !p.live.has(e.path));
  if (open.some((e) => ctx.editors.get(e.path)?.edit?.view.composing())) throw new Error("日本語の変換を確定してから更新してください");
  const documents = p.response.snapshot.documents
    .map(({ uri, text }) => ({ path: movePathOf(workspace, uri), text }))
    .filter((d) => !p.live.has(d.path));
  const locked = new Set(p.edits.map((e) => e.path));
  const was = ctx.moveLocked;
  ctx.moveLocked = (path) => locked.has(path) || !!was?.(path);
  try {
    const undo = await applyFileRenamePlans(open, {
      read: async (path) => ctx.editors.get(path)?.edit?.core.text() ?? "",
      write: async (path, text, edit) => {
        const editor = ctx.editors.get(path)?.edit;
        if (!editor || editor.view.composing()) throw new Error(`開いている参照元を編集できません：${path}`);
        if (text === edit.after) editor.apply(edit.changes, "move-links");
        else editor.apply([{ from: 0, to: edit.after.length, insert: text }], "move-links");
      },
    });
    let out;
    try {
      out = await api.treeMoveWrite({ workspace, documents, writes: closed.map(({ path, before, after }) => ({ path, before, after })) });
    } catch (error) {
      await undo();
      if (describe(error).includes("計画取得後")) return "stale";
      throw error;
    }
    if (out.error) {
      let rollback = "";
      try {
        await undo();
      } catch (error) {
        rollback = `\n${describe(error)}`;
      }
      const left = out.remainingWrites.length ? `\n戻せなかったファイル：${out.remainingWrites.join("、")}` : "";
      throw new Error(out.error + left + rollback);
    }
    return "done";
  } finally {
    ctx.moveLocked = was;
  }
};

/** Re-plans up to three times while the plan no longer holds, then applies it (I5: only after the answer). */
const update = async (ctx: Ctx, deps: OutsideDeps, workspace: string, moves: Move[], first: Planned) => {
  let client: PlanClient | null = null;
  try {
    let p = first;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0 || !(await current(ctx, workspace, p))) {
        client ??= deps.client(workspace);
        if (!(await client.ready) || !client.supportsMovedReferences()) throw new Error("Golem LSP が移動後の参照の更新に対応していません");
        p = await plan(ctx, client, workspace, moves);
        if (!(await current(ctx, workspace, p))) continue;
      }
      if ((await apply(ctx, workspace, p)) === "done") {
        ctx.toast(`${new Set(p.edits.map((e) => e.path)).size} 件のファイルの参照を更新しました`);
        return;
      }
    }
    ctx.notify({ level: "warning", sticky: true, message: "参照の更新の対象が変わり続けたため、更新できませんでした" });
  } catch (error) {
    ctx.notify({ level: "error", sticky: true, message: `参照を更新できませんでした\n${why(error)}` });
  } finally {
    client?.stop();
  }
};

const unsupported = new Set<string>();
let answers: Promise<void> = Promise.resolve();
/** The answers given so far, done in the order given. */
export const answered = () => answers;

/** Plans the references of one workspace's moves at once (I10) and asks before changing them (I5). */
export const offerReferences = async (ctx: Ctx, deps: OutsideDeps, workspace: string, moves: Move[]) => {
  if (!independent(moves)) {
    ctx.notify({ level: "warning", message: `${moves.length} 件の移動は、参照を更新できない組み合わせです` });
    return;
  }
  const client = deps.client(workspace);
  try {
    if (!(await client.ready) || !client.supportsMovedReferences()) {
      const key = JSON.stringify([workspace, ctx.config.golemPath ?? ""]);
      if (!unsupported.has(key)) {
        unsupported.add(key);
        ctx.notify({ level: "warning", message: "Golem LSP が移動後の参照の更新に対応していません" });
      }
      return;
    }
    const first = await plan(ctx, client, workspace, moves);
    const files = new Set(first.edits.map((e) => e.path)).size;
    if (!first.response.groups.length || !files) return;
    ctx.notify({
      sticky: true,
      message: askText(moves, files),
      actions: [
        { label: "更新する", primary: true, run: () => void (answers = answers.then(() => update(ctx, deps, workspace, moves, first))) },
        { label: "更新しない", run: () => {} },
      ],
    });
  } catch (error) {
    ctx.notify({ level: "error", sticky: true, message: `移動後の参照の更新を計画できませんでした\n${why(error)}` });
  } finally {
    client.stop();
  }
};

/** A batch's moves: those Aleph is not making follow, then each workspace's references are offered. Returns the moves and the sheets left to follow as changes. */
export const followBatch = async (ctx: Ctx, deps: OutsideDeps, raw: Move[]) => {
  const moves = unlocked(raw, ctx.moveLocked);
  if (!moves.length) return { moves, kept: [] as string[] };
  const kept = await followMoves(ctx, deps, moves);
  const offers = [...byWorkspace(moves, ctx.store.get().workspaces)].map(([w, list]) => offerReferences(ctx, deps, w, list));
  return { moves, kept, offers: Promise.all(offers) };
};

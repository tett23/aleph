// The tree's "切り取り" and "貼り付け" wired to Tauri (docs/adr/0109): the one clip of the
// window, a paste's move through the drag's move, and a paste's copy with a drop's progress.
import { listen } from "@tauri-apps/api/event";
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { copyWithProgress, type Progress } from "./dropin.ts";
import { basename, rel } from "./path.ts";
import { createClip, type ClipDeps } from "./tree-clip.ts";
import { moveTreeItem } from "./tree-move-flow.ts";

/** The window's cut; it lives only while the app runs. */
export const clip = createClip();

/** The copies running, by id; ids start far above a drop's, so the two never meet. */
const copies = new Map<number, (p: Progress) => void>();
let seq = 2 ** 30;
let hearing: Promise<unknown> | null = null;
const hearProgress = () =>
  (hearing ??= listen<Progress & { id: number }>("aleph:copy-progress", (e) => copies.get(e.payload.id)?.(e.payload)).catch(() => {}));

const copyInto = async (ctx: Ctx, dir: string) => {
  await hearProgress();
  const id = ++seq;
  await copyWithProgress({
    clock: { now: () => Date.now(), set: (fn, ms) => window.setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
    notify: ctx.notify,
    key: `paste-copy-${id}`,
    target: rel(ctx.store.get().workspace ?? "", dir) || basename(dir),
    run: (onProgress) => {
      copies.set(id, onProgress);
      return api.pasteFiles(id, dir).finally(() => copies.delete(id));
    },
  }).catch(() => {});
};

const deps = (ctx: Ctx, refreshTree: (ctx: Ctx) => Promise<void>): ClipDeps => ({
  board: () => api.pasteboardState(),
  exists: (path) => api.exists(path),
  move: (from, dir) => moveTreeItem(ctx, from, dir, refreshTree),
  copy: (dir) => copyInto(ctx, dir),
  notify: (message) => ctx.notify({ message, level: "warning" }),
});

export const cutItem = (ctx: Ctx, path: string, refreshTree: (ctx: Ctx) => Promise<void>) =>
  clip.cut(path, deps(ctx, refreshTree)).catch((error) => ctx.notify({ message: `切り取れませんでした：${String(error)}`, level: "error" }));

export const pasteInto = async (ctx: Ctx, dir: string, refreshTree: (ctx: Ctx) => Promise<void>) => {
  try {
    await clip.paste(dir, deps(ctx, refreshTree));
  } catch (error) {
    ctx.notify({ message: `貼り付けられませんでした：${String(error)}`, level: "error" });
  }
  await refreshTree(ctx);
  ctx.store.dispatch({ type: "expand", path: dir, on: true });
  ctx.refresh(["sidebar"]);
};

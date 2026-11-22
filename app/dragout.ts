// One tree-row press can move an item, insert an image, or begin a native drag.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { outsideWindow } from "./handover.ts";
import { imageTargetAt, insertTreeImage, mountImageDropLine } from "./imagedrag.ts";
import { FIGURE_KINDS } from "./library.ts";
import { dirname } from "./path.ts";
import { mountTreeDragPreview } from "./tree-drag-preview.ts";
import { treeDrop } from "./tree-move.ts";
import { moveTreeItem } from "./tree-move-flow.ts";
import { handedOverFrom, reloadTree, treeEntries } from "./ui/tree.ts";
import { flatten } from "./workspace.ts";

export const mountDragOut = (ctx: Ctx) => {
  let running = false;
  let seenPointer = false;
  let suppressClick = false;
  const start = (down: MouseEvent) => {
    if (down.button !== 0 || running) return;
    suppressClick = false;
    const row = (down.target as Element).closest<HTMLElement>(".file-tree [data-file], .file-tree [data-dir]");
    const pressed = row?.dataset.file ?? row?.dataset.dir;
    const workspace = ctx.store.get().workspace;
    if (!row || !pressed || !workspace) return;
    const image = row.dataset.file && !row.dataset.plot && FIGURE_KINDS.test(pressed);
    // A delivered pointerdown owns the sequence, including the later
    // compatibility mouse events. The pointer's buttons bit is not its lifetime.
    const pointer = "pointerId" in down ? (down as PointerEvent).pointerId : null;
    const motion = pointer === null ? "mousemove" : "pointermove";
    const release = pointer === null ? "mouseup" : "pointerup";
    const own = (e: MouseEvent) => pointer === null || (e as PointerEvent).pointerId === pointer;
    const viewport = window.visualViewport;
    running = true;
    let point = { x: down.clientX, y: down.clientY };
    let preview: ReturnType<typeof mountTreeDragPreview> | undefined;
    let mark: HTMLElement | null = null;
    let line: HTMLElement | null = null;
    const clearMarks = () => {
      mark?.classList.remove("tree-move-target", "tree-move-refuse");
      mark = null;
      line?.remove();
      line = null;
    };
    const targetAt = ({ x, y }: typeof point) => {
      const hit = document.elementFromPoint(x, y);
      const tree = hit?.closest<HTMLElement>(".file-tree");
      if (!tree) return { image: image ? imageTargetAt(ctx, hit, x, y) : null };
      const target = hit?.closest<HTMLElement>("[data-file], [data-dir]");
      const dir = target?.dataset.dir ?? (target?.dataset.file ? dirname(target.dataset.file) : workspace);
      const result = treeDrop(pressed, dir, workspace, ctx.store.get().workspaces, ctx.projects);
      const collision = result.kind === "move" && flatten(treeEntries()).some((entry) => entry.path === result.to);
      return { tree: { dir, target: target ?? tree, result, collision } };
    };
    const update = () => {
      if (!preview) return;
      clearMarks();
      const destination = targetAt(point);
      if (destination.tree) {
        const { target, result, collision } = destination.tree;
        const forbidden = result.kind === "invalid" || collision;
        if (result.kind !== "noop") {
          mark = target;
          mark.classList.add(forbidden ? "tree-move-refuse" : "tree-move-target");
        }
        preview.place(point, forbidden);
      } else {
        const target = destination.image;
        const insert = target && "path" in target ? target : null;
        if (insert?.bar) line = mountImageDropLine(insert.bar);
        preview.place(point, !insert);
      }
    };
    const end = () => {
      running = false;
      document.removeEventListener(motion, move, true);
      document.removeEventListener(release, up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("blur", end);
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      unsubscribe();
      clearMarks();
      if (preview) {
        preview.remove();
        preview = undefined;
        suppressClick = true;
      }
    };
    const move = (e: MouseEvent) => {
      if (!own(e)) return;
      if (pointer === null && (e.buttons & 1) === 0) return end();
      point = { x: e.clientX, y: e.clientY };
      if (!preview && Math.hypot(point.x - down.clientX, point.y - down.clientY) < 4) return;
      e.preventDefault();
      if (outsideWindow(point.x, point.y, innerWidth, innerHeight)) {
        end();
        suppressClick = true;
        void api.dragOut(handedOverFrom(ctx, pressed)).catch((error) => {
          ctx.notify({ message: `ドラッグを始められませんでした: ${String(error)}`, level: "error", sticky: true });
        });
        return;
      }
      preview ??= mountTreeDragPreview(row, pressed);
      update();
    };
    const up = (e: MouseEvent) => {
      if (!own(e)) return;
      const dragging = Boolean(preview);
      end();
      if (!dragging) return;
      e.preventDefault();
      const destination = targetAt({ x: e.clientX, y: e.clientY });
      if (destination.tree) {
        const { dir, result, collision } = destination.tree;
        if (collision) ctx.notify({ message: "同じ名前の項目があります", level: "warning" });
        else if (result.kind === "invalid") ctx.notify({ message: result.reason, level: "warning" });
        else if (result.kind === "move") void moveTreeItem(ctx, pressed, dir, reloadTree);
      } else if (destination.image) {
        const target = destination.image;
        if ("refuse" in target) ctx.toast(target.refuse);
        else void insertTreeImage(ctx, pressed, target.path, target.line).catch((error) => {
          ctx.notify({ message: `図版を差し込めませんでした: ${String(error)}`, level: "error", sticky: true });
        });
      }
    };
    const cancel = (e: PointerEvent) => { if (own(e)) end(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (preview) e.preventDefault();
      end();
    };
    const unsubscribe = ctx.store.subscribe((s) => { if (s.workspace !== workspace) end(); });
    document.addEventListener(motion, move, true);
    document.addEventListener(release, up, true);
    if (pointer !== null) document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", update, true);
    window.addEventListener("blur", end);
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
  };
  document.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary && e.pointerType !== "mouse") return;
    seenPointer = true;
    start(e);
  }, true);
  document.addEventListener("mousedown", (e) => { if (!seenPointer) start(e); }, true);
  document.addEventListener("click", (e) => {
    if (!suppressClick || (e as MouseEvent).detail === 0) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
};

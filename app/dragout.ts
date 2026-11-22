// A tree-row press becomes an internal move or a native handoff (ADR 0077, ADR 0100).
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { outsideWindow } from "./handover.ts";
import { dirname } from "./path.ts";
import { treeDrop } from "./tree-move.ts";
import { moveTreeItem } from "./tree-move-flow.ts";
import { notifyError } from "./ui/notices.ts";
import { handedOverFrom, reloadTree, treeEntries } from "./ui/tree.ts";
import { flatten } from "./workspace.ts";

/** Swallows the click that a drag ends with, until the next press. */
const swallowNextClick = () => {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener("click", swallow, { capture: true, once: true });
  document.addEventListener("mousedown", () => document.removeEventListener("click", swallow, true), { capture: true, once: true });
};

export const mountDragOut = (ctx: Ctx) => {
  let running = false;
  let seenPointer = false;
  const start = (down: MouseEvent) => {
    if (down.button !== 0 || running) return;
    const row = (down.target as HTMLElement).closest<HTMLElement>(".file-tree [data-file], .file-tree [data-dir]");
    const pressed = row?.dataset.file ?? row?.dataset.dir;
    const workspace = ctx.store.get().workspace;
    if (!pressed || !workspace) return;
    // Prefer the pointer sequence when WebKit provides it. Its compatibility
    // mousedown may arrive later, and belongs to the same press.
    const pointer = "pointerId" in down ? (down as PointerEvent).pointerId : null;
    const motion = pointer === null ? "mousemove" : "pointermove";
    const release = pointer === null ? "mouseup" : "pointerup";
    const own = (e: MouseEvent) => pointer === null || (e as PointerEvent).pointerId === pointer;
    running = true;
    let dragging = false;
    let mark: HTMLElement | null = null;
    const markOff = () => {
      mark?.classList.remove("tree-move-target", "tree-move-refuse");
      mark = null;
    };
    const targetAt = (e: MouseEvent) => {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const tree = hit?.closest<HTMLElement>(".file-tree");
      if (!tree || ctx.store.get().workspace !== workspace) return null;
      const target = hit?.closest<HTMLElement>("[data-file], [data-dir]");
      const dir = target?.dataset.dir ?? (target?.dataset.file ? dirname(target.dataset.file) : workspace);
      const result = treeDrop(pressed, dir, workspace, ctx.store.get().workspaces, ctx.projects);
      const collision = result.kind === "move" && flatten(treeEntries()).some((entry) => entry.path === result.to);
      return { dir, target: target ?? tree, result, collision };
    };
    const end = () => {
      running = false;
      document.removeEventListener(motion, move, true);
      document.removeEventListener(release, up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", end);
      markOff();
    };
    const move = (e: MouseEvent) => {
      if (!own(e)) return;
      // A delivered pointerdown owns the sequence until pointerup,
      // pointercancel or blur. The drag's buttons bit is not its lifetime.
      if (pointer === null && (e.buttons & 1) === 0) return end();
      if (!dragging && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 4) return;
      dragging = true;
      if (outsideWindow(e.clientX, e.clientY, innerWidth, innerHeight)) {
        end();
        swallowNextClick();
        void api.dragOut(handedOverFrom(ctx, pressed)).catch((error) => notifyError(`ドラッグを始められませんでした: ${String(error)}`));
        return;
      }
      markOff();
      const hit = targetAt(e);
      if (!hit || hit.result.kind === "noop") return;
      e.preventDefault();
      mark = hit.target;
      mark.classList.add(hit.result.kind === "move" && !hit.collision ? "tree-move-target" : "tree-move-refuse");
    };
    const up = (e: MouseEvent) => {
      if (!own(e)) return;
      end();
      if (!dragging) return;
      swallowNextClick();
      const hit = targetAt(e);
      if (!hit || row?.dataset.plot) return;
      e.preventDefault();
      if (hit.collision) return ctx.notify({ message: "同じ名前の項目があります", level: "warning" });
      return void moveTreeItem(ctx, pressed, hit.dir, reloadTree);
    };
    const cancel = (e: PointerEvent) => { if (own(e)) end(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !dragging) return;
      e.preventDefault();
      end();
      swallowNextClick();
    };
    document.addEventListener(motion, move, true);
    document.addEventListener(release, up, true);
    if (pointer !== null) document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", end);
  };
  document.addEventListener("pointerdown", (e) => {
    if (!e.isPrimary && e.pointerType !== "mouse") return;
    seenPointer = true;
    start(e);
  }, true);
  document.addEventListener("mousedown", (e) => { if (!seenPointer) start(e); }, true);
};

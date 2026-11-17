// Dragging the tree's rows out of the window (docs/adr/0077): while a row is pressed, the pointer
// leaving the window starts macOS's drag session with the rows' files. Drags inside the window,
// such as an image onto a chapter (docs/adr/0018), are left as they are.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { outsideWindow } from "./handover.ts";
import { notifyError } from "./ui/notices.ts";
import { handedOverFrom } from "./ui/tree.ts";

/** Swallows the click that a press ends with, until the next press. */
const swallowNextClick = () => {
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener("click", swallow, { capture: true, once: true });
  document.addEventListener("mousedown", () => document.removeEventListener("click", swallow, true), { capture: true, once: true });
};

export const mountDragOut = (ctx: Ctx) => {
  document.addEventListener(
    "mousedown",
    (down) => {
      if (down.button !== 0) return;
      const row = (down.target as HTMLElement).closest<HTMLElement>(".file-tree [data-file], .file-tree [data-dir]");
      const pressed = row?.dataset.file ?? row?.dataset.dir;
      if (!pressed) return;
      const end = () => {
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", end, true);
      };
      const move = (e: MouseEvent) => {
        if ((e.buttons & 1) === 0) return end();
        if (!outsideWindow(e.clientX, e.clientY, innerWidth, innerHeight)) return;
        end();
        swallowNextClick();
        api.dragOut(handedOverFrom(ctx, pressed)).catch((error) => notifyError(`ドラッグを始められませんでした: ${String(error)}`));
      };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", end, true);
    },
    true,
  );
};

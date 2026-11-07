// Dragging an image from the tree onto a chapter (docs/adr/0018, docs/adr/0019): followed with
// mouse events, a line where @figure goes, inserted as one change on release.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { allDocs } from "./store.ts";
import { esc } from "./esc.ts";
import { h } from "./icons.ts";
import { figureInsert, figurePlan, freeName } from "./library.ts";
import { basename } from "./path.ts";
import { reloadTree } from "./ui/tree.ts";

const THRESHOLD = 4;

const fs = {
  exists: api.exists,
  readBytes: api.readBytes,
  readText: api.readText,
  writeText: api.writeText,
  copyFile: api.copyFile,
  listDir: api.listDir,
};

type Bar = { left: number; top: number; width: number; height: number };
type Target = { path: string; line: number; bar: Bar | null } | { refuse: string } | null;

/** What lies under the pointer: a .gm editor of a project and its line (in either writing mode), a reason not to drop, or nothing. */
const targetAt = (ctx: Ctx, x: number, y: number): Target => {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const editor = el?.closest<HTMLElement>(".ed");
  if (!editor) return null;
  const path = [...ctx.editors.entries()].find(([, e]) => e.edit?.view.root === editor)?.[0];
  const doc = allDocs(ctx.store.get()).find((d) => d.path === path);
  const t = path ? ctx.editors.get(path)?.edit : null;
  if (!path || !doc || !t) return null;
  if (doc.kind !== "gm") return { refuse: "図版を差し込めるのは .gm のシートです" };
  if (!doc.project) return { refuse: "Golem のプロジェクトの章に差し込めます" };
  const pos = t.view.posAtCoords(x, y) ?? t.core.doc().length;
  const line = t.core.doc().lineAt(pos).number;
  return { path, line, bar: t.view.lineEndBar(line) };
};

const drop = async (ctx: Ctx, image: string, path: string, line: number) => {
  const doc = allDocs(ctx.store.get()).find((d) => d.path === path);
  const t = ctx.editors.get(path)?.edit;
  if (!doc?.project || !t) return;
  const plan = figurePlan(image, doc.project, ctx.projects);
  if (!plan) return ctx.toast("@figure に使えるのは PNG、JPEG、SVG、PDF の画像です");
  let figure: string;
  if (plan.copy) {
    const name = await freeName(fs, `${doc.project}/images`, basename(image));
    await api.copyFile(image, `${doc.project}/images/${name}`);
    figure = `images/${name}`;
  } else figure = plan.path;
  const { at, insert } = figureInsert(t.core.text(), line, [figure]);
  t.apply([{ from: at, insert }], "input.drop");
  ctx.toast(plan.copy ? `images/ にコピーし、@figure を差し込みました` : `@figure ${figure} を差し込みました`);
  if (plan.copy) {
    await reloadTree(ctx);
    ctx.refresh(["left"]);
  }
};

export const mountImageDrag = (ctx: Ctx) => {
  let suppressClick = false;
  document.addEventListener(
    "mousedown",
    (down) => {
      if (down.button !== 0) return;
      const row = (down.target as HTMLElement).closest<HTMLElement>(".tree [data-file]");
      const image = row?.dataset.file;
      if (!image || row.dataset.plot || !/\.(png|jpe?g|svg|pdf)$/i.test(image)) return;
      let dragging = false;
      let ghost: HTMLElement | null = null;
      let mark: HTMLElement | null = null;
      let target: Target = null;
      const end = () => {
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", up, true);
        document.removeEventListener("keydown", key, true);
        ghost?.remove();
        mark?.remove();
        document.body.classList.remove("dragging-image");
      };
      const move = (e: MouseEvent) => {
        if (!dragging) {
          if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < THRESHOLD) return;
          dragging = true;
          document.body.classList.add("dragging-image");
          ghost = h(`<div class="drag-ghost">${esc(basename(image))}</div>`);
          mark = h(`<div class="drop-line" hidden></div>`);
          document.body.append(ghost, mark);
        }
        e.preventDefault();
        ghost!.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
        target = targetAt(ctx, e.clientX, e.clientY);
        const bar = target && "path" in target ? target.bar : null;
        mark!.hidden = !bar;
        if (bar) Object.assign(mark!.style, { top: `${bar.top}px`, left: `${bar.left}px`, width: `${bar.width}px`, height: `${bar.height}px` });
      };
      const up = (e: MouseEvent) => {
        end();
        if (!dragging) return; // a press without moving opens the image, as before
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 0);
        e.preventDefault();
        if (target && "refuse" in target) return ctx.toast(target.refuse);
        if (target) void drop(ctx, image, target.path, target.line);
      };
      const key = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        const wasDragging = dragging;
        end();
        // the release that follows a cancelled drag does not open the image either
        if (wasDragging)
          document.addEventListener(
            "mouseup",
            () => {
              suppressClick = true;
              setTimeout(() => (suppressClick = false), 0);
            },
            { capture: true, once: true },
          );
      };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", up, true);
      document.addEventListener("keydown", key, true);
    },
    true,
  );
  // the click that ends a drag does not open the image
  document.addEventListener(
    "click",
    (e) => {
      if (!suppressClick) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
};

// Dragging an image from the tree onto a chapter (docs/adr/0018): followed with
// mouse events, a line where @figure goes, inserted as one change on release.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
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

type Target = { path: string; line: number; y: number; left: number; width: number } | { refuse: string } | null;

/** What lies under the pointer: a horizontal .gm editor of a project and its line, a reason not to drop, or nothing. */
const targetAt = (ctx: Ctx, x: number, y: number): Target => {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (el?.closest(".vwrap")) return { refuse: "縦書きのエディタには差し込めません。横書きに切り替えてください" };
  const editor = el?.closest<HTMLElement>(".cm-editor");
  if (!editor) return null;
  const path = [...ctx.editors.entries()].find(([, e]) => e.view?.dom === editor)?.[0];
  const doc = ctx.store.get().open.find((d) => d.path === path);
  const view = path ? ctx.editors.get(path)?.view : null;
  if (!path || !doc || !view) return null;
  if (doc.kind !== "gm") return { refuse: "図版を差し込めるのは .gm のシートです" };
  if (!doc.project) return { refuse: "Golem のプロジェクトの章に差し込めます" };
  const pos = view.posAtCoords({ x, y }) ?? view.state.doc.length;
  const line = view.state.doc.lineAt(pos);
  const block = view.lineBlockAt(line.from);
  const content = view.contentDOM.getBoundingClientRect();
  return { path, line: line.number, y: content.top + block.bottom, left: content.left, width: content.width };
};

const drop = async (ctx: Ctx, image: string, path: string, line: number) => {
  const doc = ctx.store.get().open.find((d) => d.path === path);
  const view = ctx.editors.get(path)?.view;
  if (!doc?.project || !view) return;
  const plan = figurePlan(image, doc.project, ctx.projects);
  if (!plan) return ctx.toast("@figure に使えるのは PNG、JPEG、SVG、PDF の画像です");
  let figure: string;
  if (plan.copy) {
    const name = await freeName(fs, `${doc.project}/images`, basename(image));
    await api.copyFile(image, `${doc.project}/images/${name}`);
    figure = `images/${name}`;
  } else figure = plan.path;
  const { at, insert } = figureInsert(view.state.doc.toString(), line, [figure]);
  view.dispatch({ changes: { from: at, insert }, userEvent: "input.drop" });
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
        const t = target && "path" in target ? target : null;
        mark!.hidden = !t;
        if (t) Object.assign(mark!.style, { top: `${t.y}px`, left: `${t.left}px`, width: `${t.width}px` });
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

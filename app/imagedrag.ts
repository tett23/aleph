// Insertion of a tree image into a chapter (ADR 0018, ADR 0019, ADR 0103).
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { allDocs } from "./store.ts";
import { figureInsert, figurePlan, freeName } from "./library.ts";
import { basename } from "./path.ts";
import { reloadTree } from "./ui/tree.ts";

const fs = {
  exists: api.exists,
  readBytes: api.readBytes,
  readText: api.readText,
  writeText: api.writeText,
  copyFile: api.copyFile,
  listDir: api.listDir,
};

type Bar = { left: number; top: number; width: number; height: number };
type ImageTarget = { path: string; line: number; bar: Bar | null } | { refuse: string } | null;

/** What lies under the pointer: a .gm editor of a project and its line (in either writing mode), a reason not to drop, or nothing. */
export const imageTargetAt = (ctx: Ctx, el: Element | null, x: number, y: number): ImageTarget => {
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

export const insertTreeImage = async (ctx: Ctx, image: string, path: string, line: number) => {
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
    ctx.refresh(["sidebar"]);
  }
};

export const mountImageDropLine = (bar: Bar) => {
  const line = document.createElement("div");
  line.className = "drop-line";
  Object.assign(line.style, { top: `${bar.top}px`, left: `${bar.left}px`, width: `${bar.width}px`, height: `${bar.height}px` });
  document.body.append(line);
  return line;
};

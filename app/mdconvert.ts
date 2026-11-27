// "gm に変換" for a Markdown sheet (docs/adr/0016).
import { addCommands } from "./commands.ts";
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { runDiag, showDiag } from "./diag/mount.ts";
import { basename, rel } from "./path.ts";
import { allDocs, focused } from "./store.ts";
import { projectOf } from "./workspace.ts";
import { reloadTree, treeMenus } from "./ui/tree.ts";
import { icon } from "./icons.ts";
import { confirmDialog } from "./ui/dom.ts";

export const convertToGm = async (ctx: Ctx, sourcePath?: string) => {
  try {
    const path = sourcePath ?? focused(ctx.store.get())?.path;
    if (!path || !path.toLowerCase().endsWith(".md")) return;
    const d = allDocs(ctx.store.get()).find((doc) => doc.path === path);
    const projectHint = d?.project ?? projectOf(path, ctx.projects);
    const live = d ? ctx.editors.get(path)?.text() ?? d.text : null;
    const plan = await api.planMarkdownConversion(path, projectHint);
    if (plan.overwrite && !(await confirmDialog(`${basename(plan.destination)} はもうあります。上書きします`, "上書きする"))) return;
    const { destination: to, project, chapterRegistered } = await api.finishMarkdownConversion(path, projectHint, plan.revision, plan.overwrite, live);
    await reloadTree(ctx);
    await ctx.open([to]);
    ctx.toast(`${basename(to)} を作りました${chapterRegistered ? "（manifest.toml の chapters に足しました）" : ""}`);
    if (!project) return;
    const result = await runDiag(ctx, project, "check");
    if (result && (result.raw !== null || result.items.some((x) => x.severity === "error" && x.span?.file === rel(project, to)))) showDiag(ctx, project, "check");
  } catch (error) {
    ctx.notify({ message: String(error), level: "error", sticky: true });
  }
};
export const mountMdConvert = (ctx: Ctx) => {
  addCommands(ctx.commands, { id: "md.convertToGm", menu: true, label: "gm に変換", icon: "arrow-right-left", when: (s) => focused(s)?.kind === "md", run: (c) => convertToGm(c) });
  treeMenus.push((path, dir) => !dir && path.toLowerCase().endsWith(".md")
    ? [{ label: "gm に変換", icon: icon("arrow-right-left", 14), run: () => void convertToGm(ctx, path) }]
    : []);
};

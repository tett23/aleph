// "gm に変換" for a Markdown sheet (docs/adr/0016).
import { addCommands } from "./commands.ts";
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { runDiag, showDiag } from "./diag/mount.ts";
import { addChapter, manifestChapters, paragraphSeparator } from "./manifest.ts";
import { mdToGm } from "./mdgm.ts";
import { basename, dirname, rel, stem } from "./path.ts";
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
    const project = d?.project ?? projectOf(path, ctx.projects);
    const text = d ? (ctx.editors.get(path)?.text() ?? d.text) : await api.readText(path);
    const to = `${dirname(path)}/${stem(path)}.gm`;
    if ((await api.exists(to)) && !(await confirmDialog(`${basename(to)} はもうあります。上書きします`, "上書きする"))) return;
    const manifestPath = project ? `${project}/manifest.toml` : null;
    const manifest = manifestPath ? await api.readText(manifestPath) : "";
    const sep = project ? paragraphSeparator(manifest, rel(project, to), "") : "blank-line";
    await api.writeText(to, mdToGm(text, sep));
    if (project && manifestPath && !manifestChapters(manifest).includes(rel(project, to))) await api.writeText(manifestPath, addChapter(manifest, rel(project, to)));
    await reloadTree(ctx);
    await ctx.open([to]);
    ctx.toast(`${basename(to)} を作りました${project ? "（manifest.toml の chapters に足しました）" : ""}`);
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

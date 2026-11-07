// "gm に変換" for a Markdown sheet (docs/adr/0016).
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { runDiag, showDiag } from "./diag/mount.ts";
import { addChapter, manifestChapters, paragraphSeparator } from "./manifest.ts";
import { mdToGm } from "./mdgm.ts";
import { basename, dirname, rel, stem } from "./path.ts";
import { focused } from "./store.ts";
import { confirmDialog } from "./ui/dom.ts";
import { reloadTree } from "./ui/tree.ts";

export const convertToGm = async (ctx: Ctx) => {
  const d = focused(ctx.store.get());
  if (!d || d.kind !== "md") return;
  const to = `${dirname(d.path)}/${stem(d.path)}.gm`;
  if ((await api.exists(to)) && !(await confirmDialog(`${basename(to)} はもうあります。上書きします`, "上書きする"))) return;
  const project = d.project;
  const manifestPath = project ? `${project}/manifest.toml` : null;
  const manifest = manifestPath ? await api.readText(manifestPath).catch(() => "") : "";
  // the style of paragraphs the new file will be read in: its project's, blank-line outside projects
  const sep = project ? paragraphSeparator(manifest, rel(project, to), "") : "blank-line";
  await api.writeText(to, mdToGm(ctx.editors.get(d.path)?.text() ?? d.text, sep));
  if (project && manifestPath && !manifestChapters(manifest).includes(rel(project, to))) await api.writeText(manifestPath, addChapter(manifest, rel(project, to)));
  await reloadTree(ctx);
  await ctx.open([to]);
  ctx.toast(`${basename(to)} を作りました${project ? "（manifest.toml の chapters に足しました）" : ""}`);
  if (!project) return;
  const r = await runDiag(ctx, project, "check");
  if (r && (r.raw !== null || r.items.some((x) => x.severity === "error" && x.span?.file === rel(project, to)))) showDiag(ctx, project, "check");
};

export const mountMdConvert = (ctx: Ctx) =>
  ctx.commands.push({ label: "gm に変換", icon: "arrow-right-left", when: (s) => focused(s)?.kind === "md", run: convertToGm });

// "gm に変換" for a Markdown sheet (docs/adr/0016, docs/adr/0061).
import { addCommands } from "./commands.ts";
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { runDiag, showDiag } from "./diag/mount.ts";
import { convertFile, type ConvertIo } from "./mdconvertfile.ts";
import { basename, rel } from "./path.ts";
import { focused } from "./store.ts";
import { confirmDialog } from "./ui/dom.ts";
import { reloadTree } from "./ui/tree.ts";
import { resolveTarget } from "./wikilinkmount.ts";

export const convertToGm = async (ctx: Ctx) => {
  const d = focused(ctx.store.get());
  if (!d || d.kind !== "md") return;
  const io: ConvertIo = {
    exists: (p) => api.exists(p),
    readText: (p) => api.readText(p),
    writeText: (p, t) => api.writeText(p, t),
    confirm: (m) => confirmDialog(m, "上書きする"),
    resolve: (t) => resolveTarget(ctx, t, d.path),
  };
  const to = await convertFile(io, { path: d.path, text: ctx.editors.get(d.path)?.text() ?? d.text, project: d.project });
  if (!to) return;
  const project = d.project;
  await reloadTree(ctx);
  await ctx.open([to]);
  ctx.toast(`${basename(to)} を作りました${project ? "（manifest.toml の chapters に足しました）" : ""}`);
  if (!project) return;
  const r = await runDiag(ctx, project, "check");
  if (r && (r.raw !== null || r.items.some((x) => x.severity === "error" && x.span?.file === rel(project, to)))) showDiag(ctx, project, "check");
};

export const mountMdConvert = (ctx: Ctx) =>
  addCommands(ctx.commands, { id: "md.convertToGm", menu: true, label: "gm に変換", icon: "arrow-right-left", when: (s) => focused(s)?.kind === "md", run: convertToGm });

// Gives the prose editors the kinsoku and hanging of docs/adr/0090: a
// project's .gm takes what `golem kinsoku` resolved from the project's
// style.toml, read again when style.toml is saved; other .gm, .md and .txt
// take Golem's defaults. An error of style.toml is told and the last value
// stays. A golem without the command (0.1.0-rc4 and older) gives the defaults
// without a notice, since nothing the writer wrote is wrong.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import type { TextEditor } from "./ed/editor.ts";
import { applyTo, DEFAULT_COMPOSITION, parseKinsoku, resolveComposition, targetOf, type Composition } from "./composition.ts";
import { allDocs } from "./store.ts";

const last = new Map<string, Composition>();
const editors = new Set<{ t: TextEditor; project: string }>();

const read = async (ctx: Ctx, project: string): Promise<Composition> => {
  const out = await api.tool("golem", project, ["kinsoku", project]).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
  const r = parseKinsoku(out);
  if ("error" in r && out.code === 1) ctx.notify({ message: `禁則とぶら下げの設定を読めませんでした：${r.error}`, level: "error", key: `kinsoku:${project}` });
  const c = resolveComposition(last.get(project), r);
  last.set(project, c);
  return c;
};

const applyProject = (project: string, c: Composition) =>
  editors.forEach((e) => e.project === project && applyTo(e.t, c));

export const mountComposition = (ctx: Ctx) => {
  ctx.editorPlugins.push((doc, c) => {
    const target = targetOf(doc.kind, doc.project);
    if (!target) return null;
    return {
      attach: (t) => {
        if (target === "default" || !doc.project) {
          applyTo(t, DEFAULT_COMPOSITION);
          return;
        }
        const project = doc.project;
        const entry = { t, project };
        editors.add(entry);
        applyTo(t, last.get(project) ?? DEFAULT_COMPOSITION);
        void read(c, project).then((v) => editors.has(entry) && applyTo(t, v));
        return () => void editors.delete(entry);
      },
    };
  });

  // style.toml saved: its project's editors take the values Golem resolves now
  ctx.store.subscribe((s, prev) => {
    for (const d of allDocs(s)) {
      if (!d.project || d.path !== `${d.project}/style.toml`) continue;
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (!before || before.saved === d.saved) continue;
      const project = d.project;
      void read(ctx, project).then((v) => applyProject(project, v));
    }
  });
};

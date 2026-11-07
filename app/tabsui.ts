// The tabs kept between launches (docs/adr/0024): each workspace's panes and
// tabs in config.json's ui, written as they change and opened again at launch.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { loadDoc } from "./docs.ts";
import { dropMissing, readTabs, writeTabs, type TabsUi } from "./store.ts";
import { uiState } from "./uistate.ts";

const KEY = "tabs";
const all = () => uiState().get<Record<string, unknown>>(KEY, {});

export const keepTabs = (ctx: Ctx) => {
  ctx.store.subscribe((s, prev) => {
    if (!s.workspace || (s.panes === prev.panes && s.pane === prev.pane)) return;
    // only the shape counts: an edit changes the panes but not what is written
    const next = writeTabs(s);
    const was = all()[s.workspace];
    if (JSON.stringify(was) !== JSON.stringify(next)) uiState().set(KEY, { ...all(), [s.workspace]: next });
  });
};

/** Opens the workspace's tabs of the last launch; false when there were none to open. */
export const restoreTabs = async (ctx: Ctx): Promise<boolean> => {
  const s = ctx.store.get();
  if (!s.workspace || s.open.length || s.plot) return false;
  const kept: TabsUi | null = readTabs(all()[s.workspace]);
  if (!kept) return false;
  const paths = kept.panes.flatMap((p) => p.tabs.flatMap((t) => ("paths" in t ? t.paths : [])));
  const exists = new Set((await Promise.all(paths.map(async (p) => ((await api.exists(p)) ? p : null)))).filter((p): p is string => !!p));
  const t = dropMissing(kept, (p) => exists.has(p));
  const panes = await Promise.all(
    t.panes.map(async (p) => ({
      active: p.active,
      tabs: (
        await Promise.all(
          p.tabs.map(async (x) =>
            "plot" in x
              ? ctx.projects.includes(x.plot)
                ? [{ open: [], focus: 0, plot: x.plot }]
                : []
              : [{ open: await Promise.all(x.paths.map((path) => loadDoc(path, ctx))), focus: x.focus, plot: null }],
          ),
        )
      ).flat(),
    })),
  );
  if (!panes.some((p) => p.tabs.length)) return false;
  ctx.store.dispatch({ type: "restoreTabs", panes: panes.filter((p, k, a) => p.tabs.length || a.length === 1), pane: t.pane });
  return true;
};

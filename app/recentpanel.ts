// The recently opened sheets (docs/adr/0026): recorded when sheets are opened,
// listed under the bookmarks, used by the ⌘P box, and the last one opened again
// at launch.
import { api } from "./api.ts";
import { bookmarkClicks, bookmarkSections } from "./bookmarkpanel.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { basename, rel } from "./path.ts";
import { keepExisting, parseRecent, pushRecentSheets, renameRecent, type Recent } from "./recent.ts";
import { focused } from "./store.ts";
import { uiState } from "./uistate.ts";

const KEY = "recent";
const all = (): Recent => parseRecent(uiState().get<Record<string, unknown>>(KEY, {}));
const put = (r: Recent) => uiState().set(KEY, r);

/** The recent sheets of a workspace, newest first. */
export const recentSheets = (ws: string | null): string[] => (ws ? (all()[ws] ?? []) : []);

export const mountRecent = (ctx: Ctx) => {
  // opening sheets puts them first (the focused one before the others)
  ctx.store.subscribe((s, prev) => {
    const now = s.open.map((d) => d.path).join("\n");
    if (!s.workspace || !s.open.length || now === prev.open.map((d) => d.path).join("\n")) return;
    const f = focused(s);
    const opened = [...(f ? [f.path] : []), ...s.open.map((d) => d.path).filter((p) => p !== f?.path)];
    const r = all();
    const ws = s.workspace;
    const next = pushRecentSheets(r[ws] ?? [], opened);
    put({ ...r, [ws]: next });
    // the sheets gone from the disk drop out of the list written again (docs/adr/0026)
    void Promise.all(next.map(async (p) => ((await api.exists(p)) ? p : null))).then((ok) => {
      const kept = keepExisting(next, new Set(ok.filter((p): p is string => !!p)));
      if (kept.length !== next.length && all()[ws]?.join("\n") === next.join("\n")) put({ ...all(), [ws]: kept });
    });
    if (s.showLeft && s.left === "bookmarks") ctx.refresh(["left"]);
  });

  bookmarkSections.push(async (c, ws) => {
    const list = recentSheets(ws);
    const exists = await Promise.all(list.map((p) => api.exists(p)));
    const rows = list
      .filter((_, i) => exists[i])
      .map((p) => `<div class="rc" data-recent="${esc(p)}"><span class="ttl">${esc(c.titles.get(p) ?? basename(p))}<small>${esc(rel(ws, p))}</small></span></div>`)
      .join("");
    return `<div class="sec"><h5>最近開いたシート${list.length ? `<span class="btn" data-recent-clear>消去</span>` : ""}</h5>${rows || `<div class="empty">まだありません。</div>`}</div>`;
  });
  bookmarkClicks.push((t, c) => {
    const ws = c.store.get().workspace;
    if (t.closest("[data-recent-clear]") && ws) {
      put({ ...all(), [ws]: [] });
      c.refresh(["left"]);
      return true;
    }
    const p = t.closest<HTMLElement>("[data-recent]")?.dataset.recent;
    if (!p) return false;
    void c.open([p]);
    return true;
  });

  // a file or folder renamed in Aleph: the list follows
  ctx.onRename.push((from, to) => {
    const r = all();
    put(Object.fromEntries(Object.entries(r).map(([ws, list]) => [ws, renameRecent(list, from, to)])));
  });
};

/** At launch, with no sheet open: the newest recent sheet that still exists. */
export const reopenLast = async (ctx: Ctx) => {
  const s = ctx.store.get();
  if (s.open.length || s.plot) return;
  for (const p of recentSheets(s.workspace)) if (await api.exists(p)) return ctx.open([p]);
};

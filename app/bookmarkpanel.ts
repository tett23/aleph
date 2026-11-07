// Bookmarks in the left sidebar (docs/adr/0025): sheets and lines, kept in the
// workspace's .aleph/bookmarks.json, toggled with ⌘D and from the tree's menu.
// The recently opened sheets (docs/adr/0026) are drawn below them.
import { api } from "./api.ts";
import { moveBookmark, parseBookmarks, relocate, removeBookmark, renameBookmarks, toggleBookmark, writeBookmarks, type Bookmark } from "./bookmarks.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import { basename, rel } from "./path.ts";
import { allDocs, focused } from "./store.ts";
import { menu } from "./ui/dom.ts";

const cache = new Map<string, Bookmark[]>();
const fileOf = (ws: string) => `${ws}/.aleph/bookmarks.json`;

export const loadBookmarks = async (ws: string): Promise<Bookmark[]> => {
  const have = cache.get(ws);
  if (have) return have;
  const list = parseBookmarks(await api.readText(fileOf(ws)).catch(() => ""));
  cache.set(ws, list);
  return list;
};

const save = async (ctx: Ctx, ws: string, list: Bookmark[]) => {
  cache.set(ws, list);
  await api.writeText(fileOf(ws), writeBookmarks(list));
  ctx.refresh(["left"]);
};

/** A section drawn under the bookmarks (the recent sheets of docs/adr/0026). */
export const bookmarkSections: ((ctx: Ctx, ws: string) => Promise<string>)[] = [];
/** Presses inside those sections; return true when taken. */
export const bookmarkClicks: ((t: HTMLElement, ctx: Ctx) => boolean | Promise<boolean>)[] = [];

const nameOf = (ctx: Ctx, abs: string) => ctx.titles.get(abs) ?? basename(abs);

/** Opens a bookmark: the sheet, and for a line, the line found again by its text (its number kept up to date). */
const go = async (ctx: Ctx, ws: string, i: number) => {
  const list = await loadBookmarks(ws);
  const b = list[i];
  if (!b) return;
  const abs = `${ws}/${b.path}`;
  if (!(await api.exists(abs))) return ctx.toast(`${b.path} が見つかりません`);
  if (b.line === undefined) return ctx.open([abs]);
  const open = allDocs(ctx.store.get()).find((d) => d.path === abs);
  const text = ctx.editors.get(abs)?.text() ?? open?.text ?? (await api.readText(abs).catch(() => ""));
  const line = relocate(text.split("\n"), b.line, b.text ?? "");
  if (line !== b.line) await save(ctx, ws, list.map((x, k) => (k === i ? { ...x, line } : x)));
  await ctx.open([abs], { line });
  // an editor already open does not take pendingAt
  ctx.editors.get(abs)?.goto(line);
};

const draw = async (el: HTMLElement, ctx: Ctx) => {
  const ws = ctx.store.get().workspace;
  if (!ws) return void (el.innerHTML = `<div class="empty">ワークスペースを選んでください。</div>`);
  const list = await loadBookmarks(ws);
  const exists = await Promise.all(list.map((b) => api.exists(`${ws}/${b.path}`)));
  const rows = list
    .map((b, i) => {
      const abs = `${ws}/${b.path}`;
      const line = b.line !== undefined ? `<small>${b.line} 行　${esc((b.text ?? "").slice(0, 40))}</small>` : `<small>${esc(b.path)}</small>`;
      return `<div class="bm ${exists[i] ? "" : "missing"}" data-bm="${i}"><span class="grip" data-grip title="ドラッグして並べ替える">${icon("grip-vertical", 12)}</span><span class="ttl">${esc(
        nameOf(ctx, abs),
      )}${line}</span><span class="iconbtn" data-rm title="外す">${icon("x", 12)}</span></div>`;
    })
    .join("");
  const extra = (await Promise.all(bookmarkSections.map((f) => f(ctx, ws)))).join("");
  el.innerHTML = `<div class="bookmarks"><div class="sec"><h5>ブックマーク</h5>${rows || `<div class="empty">⌘D でカーソルの行を、ツリーの右クリックでシートをブックマークします。</div>`}</div>${extra}</div>`;
};

/** Drag to reorder, followed with mouse events like the plot's rows (docs/adr/0013). */
const startDrag = (ctx: Ctx, ws: string, el: HTMLElement, from: number, down: MouseEvent) => {
  const rows = [...el.querySelectorAll<HTMLElement>("[data-bm]")];
  let to = from;
  const move = (e: MouseEvent) => {
    to = rows.findIndex((r) => e.clientY < r.getBoundingClientRect().bottom);
    if (to < 0) to = rows.length - 1;
    rows.forEach((r, k) => r.classList.toggle("drop", k === to && k !== from));
  };
  const up = async () => {
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("mouseup", up, true);
    if (to !== from) await save(ctx, ws, moveBookmark(await loadBookmarks(ws), from, to));
    else ctx.refresh(["left"]);
  };
  down.preventDefault();
  document.addEventListener("mousemove", move, true);
  document.addEventListener("mouseup", up, true);
};

/** Toggles a bookmark of the focused sheet's caret line, or of a sheet. */
const toggle = async (ctx: Ctx, abs: string, line?: { n: number; text: string }) => {
  const ws = ctx.store.get().workspace;
  if (!ws || !abs.startsWith(ws + "/")) return ctx.toast("ワークスペースの中のシートをブックマークできます");
  const b: Bookmark = line ? { path: rel(ws, abs), line: line.n, text: line.text } : { path: rel(ws, abs) };
  const before = await loadBookmarks(ws);
  const after = toggleBookmark(before, b);
  await save(ctx, ws, after);
  ctx.toast(after.length > before.length ? (line ? `${line.n} 行をブックマークしました` : "シートをブックマークしました") : "ブックマークを外しました");
};

export const mountBookmarks = (ctx: Ctx) => {
  ctx.left.bookmarks = {
    icon: "map-pin",
    title: "ブックマーク",
    render: async (el) => {
      await draw(el, ctx);
      el.onmousedown = (e) => {
        const ws = ctx.store.get().workspace;
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-bm]");
        if (!ws || !row || !(e.target as HTMLElement).closest("[data-grip]")) return;
        startDrag(ctx, ws, el, Number(row.dataset.bm), e);
      };
      el.onclick = async (e) => {
        const ws = ctx.store.get().workspace;
        const t = e.target as HTMLElement;
        for (const f of bookmarkClicks) if (await f(t, ctx)) return;
        const row = t.closest<HTMLElement>("[data-bm]");
        if (!ws || !row || t.closest("[data-grip]")) return;
        const i = Number(row.dataset.bm);
        if (t.closest("[data-rm]")) return save(ctx, ws, removeBookmark(await loadBookmarks(ws), i));
        return go(ctx, ws, i);
      };
    },
  };

  ctx.commands.push(
    {
      id: "bookmark.toggle",
      label: "カーソルの行をブックマーク",
      icon: "map-pin",
      keys: ["Mod-d"],
      when: (s) => {
        const d = focused(s);
        return !!d && !!ctx.editors.get(d.path)?.edit;
      },
      run: (c) => {
        const d = focused(c.store.get());
        const t = d && c.editors.get(d.path)?.edit;
        if (!d || !t) return;
        const l = t.core.doc().lineAt(t.core.sel().head);
        return toggle(c, d.path, { n: l.number, text: l.text });
      },
    },
    {
      id: "bookmark.toggleSheet",
      label: "シートをブックマーク",
      icon: "map-pin",
      when: (s) => !!focused(s),
      run: (c) => toggle(c, focused(c.store.get())!.path),
    },
    {
      id: "view.left.bookmarks",
      label: "サイドバー：ブックマーク",
      icon: "map-pin",
      when: () => true,
      run: (c) => {
        const s = c.store.get();
        if (!(s.showLeft && s.left === "bookmarks")) c.store.dispatch({ type: "left", panel: "bookmarks" });
      },
    },
  );

  // the tree's row menu (right click): bookmark the sheet
  document.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree [data-file]");
    const abs = row?.dataset.file;
    if (!row || !abs) return;
    e.preventDefault();
    const ws = ctx.store.get().workspace;
    const on = !!ws && (cache.get(ws) ?? []).some((b) => b.line === undefined && b.path === rel(ws, abs));
    menu(row, [{ label: on ? "ブックマークを外す" : "ブックマークに足す", icon: icon("map-pin", 14), run: () => void toggle(ctx, abs) }]);
  });

  // a file or folder renamed in Aleph: its bookmarks follow
  ctx.onRename.push(async (from, to, c) => {
    const ws = c.store.get().workspace;
    if (!ws || !from.startsWith(ws + "/")) return;
    const list = await loadBookmarks(ws);
    const next = renameBookmarks(list, rel(ws, from), rel(ws, to));
    if (JSON.stringify(next) !== JSON.stringify(list)) await save(c, ws, next);
  });
};

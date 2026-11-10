// The trash (docs/adr/0033): moving sheets and folders out of the workspace
// into the app's config directory with what is needed to put them back (their
// chapters in manifest.toml, their notes), a panel to restore or delete them
// for good, and entries removed after 30 days. The records are in trash.ts.
import { addCommands } from "./commands.ts";
import { api } from "./api.ts";
import { loadMeta, putMeta } from "./attach.ts";
import type { Ctx } from "./ctx.ts";
import { closeTab } from "./editor/panes.ts";
import { esc } from "./esc.ts";
import { h, icon } from "./icons.ts";
import { freeName } from "./library.ts";
import { removeChapters, restoreChapters } from "./manifest.ts";
import { basename, dirname, rel, underRoot } from "./path.ts";
import { entryId, expired, parseEntry, removeNotes, restoreNotes, type Entry } from "./trash.ts";
import { confirmDialog } from "./ui/dom.ts";
import { reloadTree, treeEntries, treeMenus } from "./ui/tree.ts";
import { flatten, projectOf, workspaceOf } from "./workspace.ts";

const fs = { exists: api.exists, readBytes: api.readBytes, readText: api.readText, writeText: api.writeText, copyFile: api.copyFile, listDir: api.listDir };
let seq = 0;

const under = (p: string, root: string) => p === root || p.startsWith(root + "/");

/** The tree's entry of a path. */
const entryOf = (path: string, list = treeEntries()): { dir: boolean; children: typeof list } | null => {
  for (const e of list) {
    if (e.path === path) return e;
    if (e.dir && path.startsWith(e.path + "/")) return entryOf(path, e.children);
  }
  return null;
};

/** The files of the tree at or under a path. */
const filesUnder = (path: string) => flatten(treeEntries()).filter((e) => under(e.path, path)).map((e) => e.path);

const listEntries = async (): Promise<Entry[]> => {
  const dir = await api.trashDir();
  const ids = await api.listDir(dir);
  const all = await Promise.all(ids.map(async (d) => parseEntry(await api.readText(`${d}/entry.json`).catch(() => ""))));
  return all.filter((e): e is Entry => !!e).sort((a, b) => b.deletedAt - a.deletedAt);
};

/** A toast with a button (the plain toast has none). */
const toastWith = (msg: string, label: string, run: () => void) => {
  const t = h(`<div class="toast">${esc(msg)} <span class="btn small">${esc(label)}</span></div>`);
  t.querySelector(".btn")!.addEventListener("click", () => (t.remove(), run()));
  document.body.append(t);
  setTimeout(() => t.remove(), 6000);
};

/** Moves a sheet or a folder to the trash, after asking for a folder; false when not moved. */
export const moveToTrash = async (ctx: Ctx, path: string): Promise<boolean> => {
  const s = ctx.store.get();
  const ws = workspaceOf(path, s.workspaces);
  if (!ws || s.workspaces.includes(path) || path.endsWith("/plot.csv")) return ctx.toast("ワークスペースとプロットはゴミ箱に移せません"), false;
  const isDir = !!entryOf(path)?.dir;
  const files = isDir ? filesUnder(path) : [path];
  const isProject = isDir && ctx.projects.includes(path);
  if (isProject && !(await confirmDialog(`プロジェクト「${basename(path)}」（${files.length} ファイル）をゴミ箱に移しますか`, "移す"))) return false;
  if (isDir && !isProject && !(await confirmDialog(`フォルダ「${basename(path)}」の ${files.length} ファイルをゴミ箱に移しますか`, "移す"))) return false;
  // open sheets inside: saved, then their tabs closed
  for (;;) {
    const st = ctx.store.get();
    const at = st.panes.flatMap((p, pi) => p.tabs.flatMap((t, ti) => (t.open.some((d) => under(d.path, path)) ? [{ pi, ti }] : [])))[0];
    if (!at) break;
    await closeTab(ctx, at.pi, at.ti);
  }
  const entry: Entry = { id: entryId(new Date(), ++seq), original: path, deletedAt: Date.now(), workspace: ws, kind: isProject ? "project" : isDir ? "folder" : "sheet", chapters: null, notes: null };
  // the chapters it holds, out of its project's manifest (not for a whole project)
  const project = projectOf(path, ctx.projects);
  if (project && project !== path) {
    const mf = `${project}/manifest.toml`;
    const src = await api.readText(mf).catch(() => null);
    if (src !== null) {
      const r = removeChapters(src, files.map((f) => rel(project, f)));
      if (r.removed.length) {
        await api.writeText(mf, r.src);
        entry.chapters = { project, removed: r.removed };
      }
    }
  }
  // the notes of its sheets
  const root = project && project !== path ? project : ws;
  const meta = await loadMeta(root);
  const r = removeNotes(meta, files.map((f) => rel(root, f)));
  if (Object.keys(r.removed).length) {
    await putMeta(root, r.meta);
    entry.notes = { root, removed: r.removed };
  }
  const dir = `${await api.trashDir()}/${entry.id}`;
  await api.movePath(path, `${dir}/${basename(path)}`);
  await api.writeText(`${dir}/entry.json`, JSON.stringify(entry, null, 2) + "\n");
  await reloadTree(ctx);
  ctx.refresh(["left"]);
  toastWith("ゴミ箱に移しました", "戻す", () => void restore(ctx, entry));
  return true;
};

/** Puts an entry back where it was (beside it with -2 when the place is taken), with its chapters and notes. */
export const restore = async (ctx: Ctx, entry: Entry) => {
  // only back into a registered workspace, never out of it (docs/adr/0048)
  const ws = ctx.store.get().workspaces.find((w) => w === entry.workspace);
  if (!ws || !underRoot(ws, rel(ws, entry.original)) || !entry.original.startsWith(`${ws}/`)) return void ctx.notify({ message: `元の場所がワークスペースの外なので戻せません：${entry.original}`, level: "error", sticky: true });
  const dir = `${await api.trashDir()}/${entry.id}`;
  const parent = dirname(entry.original);
  const name = await freeName(fs, parent, basename(entry.original));
  const to = `${parent}/${name}`;
  await api.movePath(`${dir}/${basename(entry.original)}`, to);
  const moved = (p: string) => (to === entry.original ? p : to + p.slice(entry.original.length));
  if (entry.chapters) {
    const mf = `${entry.chapters.project}/manifest.toml`;
    const src = await api.readText(mf).catch(() => null);
    if (src !== null) {
      const project = entry.chapters.project;
      const renamed = to === entry.original ? undefined : { from: rel(project, entry.original), to: rel(project, to) };
      // a renamed folder: each chapter under it gets its new path
      let next = src;
      for (const r of entry.chapters.removed) {
        const text = renamed ? r.text.split(`"${renamed.from}`).join(`"${renamed.to}`) : r.text;
        next = restoreChapters(next, [{ ...r, text }]);
      }
      await api.writeText(mf, next);
    }
  }
  if (entry.notes) {
    const root = entry.notes.root;
    await putMeta(root, restoreNotes(await loadMeta(root), entry.notes.removed, (k) => rel(root, moved(`${root}/${k}`))));
  }
  await api.removePath(dir).catch(() => {});
  if (to !== entry.original) ctx.toast(`同じ名前があったので ${name} として戻しました`);
  await reloadTree(ctx);
  ctx.refresh(["left"]);
};

const purge = async (entry: Entry) => api.removePath(`${await api.trashDir()}/${entry.id}`);

const KIND = { sheet: "シート", folder: "フォルダ", project: "プロジェクト" };

const draw = async (el: HTMLElement, ctx: Ctx) => {
  const list = await listEntries();
  const ws = ctx.store.get().workspaces;
  const where = (p: string) => {
    const w = workspaceOf(p, ws);
    return w ? rel(w, p) : p;
  };
  el.innerHTML = `<div class="trash"><div class="sec"><h5>ゴミ箱${list.length ? `<span class="btn small" data-trash-empty>空にする</span>` : ""}</h5>${
    list
      .map(
        (e) =>
          `<div class="te" data-te="${esc(e.id)}"><span class="ttl">${esc(basename(e.original))}<small>${KIND[e.kind]}・${esc(where(e.original))}・${new Date(e.deletedAt).toLocaleString("ja-JP")}</small></span><span class="iconbtn" data-te-restore title="戻す">${icon(
            "undo-2",
            13,
          )}</span><span class="iconbtn" data-te-purge title="完全に消す">${icon("x", 13)}</span></div>`,
      )
      .join("") || `<div class="empty">ゴミ箱は空です。ツリーの右クリックか ⌘⌫ で、シートやフォルダを移します。消してから 30 日で消えます。</div>`
  }</div></div>`;
};

/** Whether the keys belong to the tree (not to an editor or a field, where ⌘⌫ edits). */
const outsideText = () => {
  const a = document.activeElement;
  return !a?.closest(".ed, input, textarea, [contenteditable]") || !!a.closest(".palette");
};

export const mountTrash = (ctx: Ctx) => {
  ctx.left.trash = {
    icon: "trash-2",
    title: "ゴミ箱",
    render: async (el) => {
      await draw(el, ctx);
      el.onclick = async (e) => {
        const t = e.target as HTMLElement;
        const list = await listEntries();
        if (t.closest("[data-trash-empty]")) {
          if (!(await confirmDialog(`ゴミ箱の ${list.length} 項目を完全に消しますか。元に戻せません`, "完全に消す"))) return;
          for (const x of list) await purge(x);
          return ctx.refresh(["left"]);
        }
        const id = t.closest<HTMLElement>("[data-te]")?.dataset.te;
        const entry = list.find((x) => x.id === id);
        if (!entry) return;
        if (t.closest("[data-te-restore]")) await restore(ctx, entry);
        else if (t.closest("[data-te-purge]")) {
          if (!(await confirmDialog(`${basename(entry.original)} を完全に消しますか。元に戻せません`, "完全に消す"))) return;
          await purge(entry);
        }
        ctx.refresh(["left"]);
      };
    },
  };

  treeMenus.push((path) => [{ label: "ゴミ箱に移す", icon: icon("trash-2", 14), run: () => void moveToTrash(ctx, path) }]);

  addCommands(ctx.commands, 
    {
      id: "file.trash",
      label: "ゴミ箱に移す",
      icon: "trash-2",
      keys: ["Mod-Backspace"],
      menu: true,
      when: (s) => outsideText() && (s.selected.length > 0 || !!s.anchor),
      run: async (c) => {
        const s = c.store.get();
        for (const p of s.selected.length ? s.selected : [s.anchor!]) if (!(await moveToTrash(c, p))) break;
      },
    },
    {
      id: "view.left.trash",
      label: "サイドバー：ゴミ箱",
      icon: "trash-2",
      when: () => true,
      run: (c) => {
        const s = c.store.get();
        if (!(s.showLeft && s.left === "trash")) c.store.dispatch({ type: "left", panel: "trash" });
      },
    },
  );

  // entries past 30 days go at launch
  void listEntries().then(async (list) => {
    for (const e of expired(list, Date.now())) await purge(e).catch(() => {});
  });
};

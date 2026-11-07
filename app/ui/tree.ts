// The file tree of the current workspace (docs/adr/0004).
import { api, type Entry } from "../api.ts";
import { adopt } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { forgetGrid } from "../docs.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { addChapter, manifestChapters } from "../manifest.ts";
import { basename, dirname, stem } from "../path.ts";
import { allDocs, focused } from "../store.ts";
import { collectProjects, flatten, kindOf, selectChapters, titleOf, treeRows, type Row } from "../workspace.ts";
import { golem } from "../tools.ts";
import { ask, menu, toast, type MenuItem } from "./dom.ts";
import { item } from "./settings.ts";

const ICONS: Record<string, string> = {
  gm: "file-text",
  md: "file-text",
  txt: "file",
  emet: "sigma",
  toml: "settings-2",
  csv: "sheet",
  tsv: "sheet",
  svg: "image",
  mmd: "workflow",
  pdf: "file-type",
  json: "file",
  jsonc: "file",
  json5: "file",
  jsonl: "file",
};

let entries: Entry[] = [];
/** The workspace as the tree last read it. */
export const treeEntries = () => entries;
const chapters = new Map<string, string[]>();

/** Items of a row's right-click menu, by the parts that add them (bookmarks, the trash). */
export const treeMenus: ((path: string, dir: boolean, ctx: Ctx) => MenuItem[])[] = [];

/** Run after the tree and the titles were read again (the wikilinks' index, docs/adr/0027). */
export const treeReloaded: ((ctx: Ctx) => void | Promise<void>)[] = [];

/** Reads the workspace again: the tree, the projects, their chapters and the sheets' titles. */
export const reloadTree = async (ctx: Ctx) => {
  const ws = ctx.store.get().workspace;
  entries = ws ? await api.listTree(ws).catch(() => []) : [];
  const projects = new Set(collectProjects(entries));
  // projects of every workspace, for the cross-project panels
  for (const w of ctx.store.get().workspaces) if (w !== ws) collectProjects(await api.listTree(w).catch(() => [])).forEach((p) => projects.add(p));
  ctx.projects = [...projects];
  chapters.clear();
  await Promise.all(
    [...projects].map(async (p) => chapters.set(p, manifestChapters(await api.readText(`${p}/manifest.toml`).catch(() => "")).map((r) => `${p}/${r}`))),
  );
  await Promise.all(
    flatten(entries)
      .filter((e) => ["gm", "md"].includes(kindOf(e.path)))
      .map(async (e) => {
        const t = titleOf(kindOf(e.path), await api.readText(e.path).catch(() => ""));
        if (t) ctx.titles.set(e.path, t);
        else ctx.titles.delete(e.path);
      }),
  );
  for (const f of treeReloaded) await f(ctx);
};

const row = (r: Row, ctx: Ctx) => {
  const s = ctx.store.get();
  const pad = `padding-left:${8 + r.depth * 16}px`;
  if (r.t === "dir") {
    const open = s.expanded.includes(r.entry.path);
    return `<div class="r ${r.project ? "proj" : ""}" style="${pad}" data-dir="${esc(r.entry.path)}">${icon(open ? "chevron-down" : "chevron-right", 13)}${
      r.project ? `<span class="ic book">${icon("book-open", 15)}</span>` : icon("folder", 14)
    }<span class="ttl">${esc(r.entry.name)}</span></div>`;
  }
  const p = r.entry.path;
  const k = kindOf(p);
  const title = r.plot ? "プロット" : (ctx.titles.get(p) ?? stem(r.entry.name));
  // a heading as the name, the file's name small beside it (docs/adr/0004); otherwise the kind
  const fn = r.plot ? "" : ctx.titles.has(p) ? r.entry.name.replace(/\.gm$/, "") : k;
  const on = s.open.some((d) => d.path === p) || s.selected.includes(p) || (r.plot && s.plot === r.project);
  return `<div class="r ${on ? "on" : ""}" style="${pad}" data-file="${esc(p)}" ${r.plot ? `data-plot="${esc(r.project!)}"` : ""}>${icon(
    r.plot ? "table-2" : (ICONS[k] ?? "image"),
    14,
  )}<span class="ttl">${esc(title)}</span><span class="fn">${esc(fn)}</span><span class="c">${ctx.decor.map((f) => f(p, ctx)).join("")}</span></div>`;
};

const rowsNow = (ctx: Ctx) => treeRows(entries, new Set(ctx.store.get().expanded), (p) => chapters.get(p) ?? []);

const draw = (el: HTMLElement, ctx: Ctx) => {
  const s = ctx.store.get();
  el.innerHTML = `<div class="acts">
      <span class="iconbtn" data-act="new-file" title="新しいシート">${icon("square-pen")}</span>
      <span class="iconbtn" data-act="new-folder" title="新しいフォルダ">${icon("folder-plus")}</span>
      <span class="iconbtn" data-act="new-project" title="新しいプロジェクト（golem new）">${icon("book-plus")}</span>
      <span class="sp"></span>
      <span class="iconbtn" data-act="refresh" title="読みなおす">${icon("refresh-cw")}</span>
      <span class="iconbtn" data-act="collapse" title="すべて閉じる">${icon("chevrons-down-up")}</span>
    </div>
    <div class="tree">${
      !s.workspace
        ? `<div class="empty">ワークスペースを足してください。<br><span class="btn" data-act="add-ws">フォルダを選ぶ</span></div>`
        : rowsNow(ctx).map((r) => row(r, ctx)).join("") || `<div class="empty">空のワークスペースです。</div>`
    }</div>`;
};

/** A directory for a new file: the open sheet's, or the workspace's root. */
const targetDir = (ctx: Ctx) => {
  const d = focused(ctx.store.get());
  return d ? dirname(d.path) : ctx.store.get().workspace;
};

/** Adds a folder the writer picks in a native dialog that Rust opens (docs/adr/0050). */
export const addWorkspace = async (ctx: Ctx) => {
  const written = await api.addWorkspace();
  if (!written) return;
  const before = ctx.config.workspaces;
  adopt(ctx.config, written);
  await ctx.saveConfig();
  const p = ctx.config.workspaces.find((w) => !before.includes(w));
  if (p) ctx.store.dispatch({ type: "workspace", path: p });
};

/** Adds a new chapter to a project's manifest. */
export const newChapter = async (ctx: Ctx, project: string) => {
  const list = chapters.get(project) ?? [];
  const name = await ask("新しい章のファイル名", `chapters/${String(list.length + 1).padStart(2, "0")}.gm`);
  if (!name) return null;
  const path = `${project}/${name}`;
  if (await api.exists(path)) return toast(`${name} はもうあります`), null;
  await api.writeText(path, "# \n");
  if (name.endsWith(".gm")) {
    const mp = `${project}/manifest.toml`;
    await api.writeText(mp, addChapter(await api.readText(mp), name));
  }
  return path;
};

/** The tree's actions (the buttons above it), also run as commands (docs/adr/0023). */
export const runTreeAct = async (ctx: Ctx, act: string) => {
  const s = ctx.store.get();
  switch (act) {
    case "add-ws":
      return addWorkspace(ctx);
    case "refresh":
      await reloadTree(ctx);
      return ctx.refresh(["left"]);
    case "collapse":
      return ctx.store.dispatch({ type: "collapseAll" });
    case "new-folder": {
      const dir = targetDir(ctx);
      const name = dir && (await ask("新しいフォルダの名前"));
      if (!dir || !name) return;
      await api.makeDir(`${dir}/${name}`);
      await reloadTree(ctx);
      return ctx.store.dispatch({ type: "expand", path: dir, on: true });
    }
    case "new-project": {
      const ws = s.workspace;
      const name = ws && (await ask("新しいプロジェクトの名前（golem new）"));
      if (!ws || !name) return;
      // fonts come from the shared library, never from golem's download (docs/adr/0004, docs/adr/0014)
      const out = await golem(ctx, ws, ["new", name, "--no-fonts"]);
      if (out.code !== 0) return toast((out.stderr || out.stdout).trim());
      for (const f of ctx.onNewProject) await f(`${ws}/${name}`, ctx);
      if (!ctx.config.libraryDir) toast("共有ライブラリがないので、フォントは入っていません。設定の「共有ライブラリ」でフォルダを決めると、開いたときにコピーします");
      await reloadTree(ctx);
      ctx.store.dispatch({ type: "expand", path: `${ws}/${name}`, on: true });
      return ctx.open([`${ws}/${name}/chapters/01.gm`]);
    }
    case "new-file": {
      const project = focused(s)?.project ?? null;
      let path: string | null = null;
      if (project) path = await newChapter(ctx, project);
      else {
        const dir = targetDir(ctx);
        const name = dir && (await ask("新しいシートの名前", "untitled.md"));
        if (!dir || !name) return;
        path = `${dir}/${name}`;
        if (await api.exists(path)) return toast(`${name} はもうあります`);
        await api.writeText(path, "");
      }
      if (!path) return;
      await reloadTree(ctx);
      return ctx.open([path], { line: 1, col: 2 });
    }
  }
};

export const mountTree = (ctx: Ctx) => {
  ctx.left.files = {
    icon: "files",
    title: "ファイル",
    render: async (el) => {
      if (!entries.length) await reloadTree(ctx);
      draw(el, ctx);
      el.onclick = async (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>("[data-file],[data-dir],[data-act]");
        if (!t) return;
        const d = t.dataset;
        const s = ctx.store.get();
        if (d.dir) return ctx.store.dispatch({ type: "expand", path: d.dir, on: !s.expanded.includes(d.dir) });
        // ⌥ opens in a new tab (docs/adr/0024)
        const newTab = (e as MouseEvent).altKey;
        if (d.plot) return void ctx.open([`${d.plot}/plot.csv`], undefined, { newTab });
        if (d.file) {
          const me = e as MouseEvent;
          if (kindOf(d.file) === "gm" && (me.shiftKey || me.metaKey)) {
            const gm = rowsNow(ctx).flatMap((r) => (r.t === "file" && kindOf(r.entry.path) === "gm" ? [r.entry.path] : []));
            const sel = selectChapters(gm, s.selected, s.anchor, d.file, me.shiftKey ? "range" : "toggle");
            if (sel.length) return void ctx.open(sel, undefined, { newTab });
            return;
          }
          return void ctx.open([d.file], undefined, { newTab });
        }
        return runTreeAct(ctx, d.act!);
      };
      el.ondblclick = async (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>("[data-file]");
        if (!t || t.dataset.plot) return;
        const from = t.dataset.file!;
        const name = await ask("名前を変える", basename(from));
        if (!name || name === basename(from)) return;
        const to = `${dirname(from)}/${name}`;
        if (await api.exists(to)) return toast(`${name} はもうあります`);
        // an open sheet is saved first, so its unsaved text goes with it (docs/adr/0011)
        if (allDocs(ctx.store.get()).some((d) => d.path === from)) await ctx.save([from]);
        await api.rename(from, to);
        ctx.store.dispatch({ type: "rename", from, to });
        for (const f of ctx.onRename) await f(from, to, ctx);
        await reloadTree(ctx);
        draw(el, ctx);
      };
    },
  };

  // a row's right-click: the items the other parts add
  document.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree [data-file]:not([data-plot]), .tree [data-dir]");
    const path = row?.dataset.file ?? row?.dataset.dir;
    if (!row || !path) return;
    const items = treeMenus.flatMap((f) => f(path, row.dataset.dir !== undefined, ctx));
    if (!items.length) return;
    e.preventDefault();
    menu(row, items);
  });

  // after saving a manifest or a style, chapters and grids are read again
  ctx.onRename.push((from) => {
    if (from.endsWith("/style.toml")) forgetGrid(dirname(from));
  });

  ctx.settings.push({
    id: "workspaces",
    label: "ワークスペース",
    group: "オプション",
    render: (c) =>
      c.config.workspaces.map((w, i) => item(basename(w), esc(w), `<span class="btn" data-rmws="${i}">外す</span>`)).join("") +
      item("ワークスペースを足す", "フォルダを一つワークスペースにする。Git のリポジトリなら Git の機能も使える", `<span class="btn" data-addws>フォルダを選ぶ</span>`),
    onClick: async (el, c) => {
      const t = el.closest<HTMLElement>("[data-rmws],[data-addws]");
      if (!t) return false;
      if (t.dataset.rmws !== undefined) {
        c.config.workspaces.splice(Number(t.dataset.rmws), 1);
        await c.saveConfig();
      } else await addWorkspace(c);
      return true;
    },
  });
};

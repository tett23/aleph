// The file tree of the current workspace (docs/adr/0004).
import { api, type Entry } from "../api.ts";
import { notifyError } from "./notices.ts";
import { adopt } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { forgetGrid, gridOf } from "../docs.ts";
import { forgetManifest, loadManifest } from "../separator.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { manifestChapters } from "../manifest.ts";
import { selectedGmInTreeOrder } from "../chapter-export.ts";
import { basename, dirname, ext, stem } from "../path.ts";
import { allDocs, focused } from "../store.ts";
import { flatten, IMAGE_KINDS, kindOf, opensOnClick, projectOf, projectsIn, selectChapters, titleOf, treeRows, workspaceRows, type Row } from "../workspace.ts";
import { handedOver, zipNames } from "../handover.ts";
import { openRepositorySettings } from "../git-settings.ts";
import { golem } from "../tools.ts";
import { ask, choiceDialog, menu, toast, type MenuItem } from "./dom.ts";
import { keepScroll } from "./scroll.ts";
import { item, toggle } from "./settings.ts";
import { revealItems } from "../reveal.ts";
import { canRenameTreeItem, renameTarget } from "../tree-rename.ts";
import { createdPath, SHEET_KINDS } from "../tree-create.ts";
import { moveProject, orderProjectEntries, projectNeighbors } from "../project-order.ts";
import { clip, cutItem, pasteInto } from "../tree-paste.ts";

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
let baseEntries: Entry[] = [];
/** The workspace's default tree, used by search, links and trash independently of display settings. */
export const treeEntries = () => baseEntries;
const chapters = new Map<string, string[]>();
const initializing = new Map<string, 'placing' | 'refreshing'>();

/** Items of a row's right-click menu, by the parts that add them (bookmarks, the trash). */
export const treeMenus: ((path: string, dir: boolean, ctx: Ctx) => MenuItem[])[] = [];

/** Run after the tree and the titles were read again (the wikilinks' index, docs/adr/0027). */
export const treeReloaded: ((ctx: Ctx) => void | Promise<void>)[] = [];

/** Reads the workspace again: the tree, the projects, their chapters and the sheets' titles. */
export const reloadTree = async (ctx: Ctx) => {
  const ws = ctx.store.get().workspace;
  baseEntries = ws ? await api.listTree(ws).catch(() => []) : [];
  entries = ws && (ctx.config?.showHiddenFiles || ctx.config?.showGitignoredFiles === false)
    ? await api.listTree(ws, { showHidden: ctx.config?.showHiddenFiles ?? false, showIgnored: ctx.config?.showGitignoredFiles ?? true }).catch(() => [])
    : baseEntries;
  const projects = new Set(ws ? projectsIn(ws, baseEntries) : []);
  // projects of every workspace, for the cross-project panels
  for (const w of ctx.store.get().workspaces) if (w !== ws) projectsIn(w, await api.listTree(w).catch(() => [])).forEach((p) => projects.add(p));
  for (const [root, stage] of initializing) if (stage === 'placing') projects.delete(root);
  ctx.projects = [...projects];
  chapters.clear();
  await Promise.all(
    [...projects].map(async (p) => chapters.set(p, manifestChapters(await api.readText(`${p}/manifest.toml`).catch(() => "")).map((r) => `${p}/${r}`))),
  );
  await Promise.all(
    [...new Map([...flatten(baseEntries), ...flatten(entries)].map((entry) => [entry.path, entry])).values()]
      .filter((e) => ["gm", "md"].includes(kindOf(e.path)))
      .map(async (e) => {
        const t = titleOf(kindOf(e.path), await api.readText(e.path).catch(() => ""));
        if (t) ctx.titles.set(e.path, t);
        else ctx.titles.delete(e.path);
      }),
  );
  for (const f of treeReloaded) await f(ctx);
};

// the item cut is drawn faint until it is pasted (docs/adr/0109)
const cutClass = (path: string) => (clip.current()?.path === path ? " cut" : "");

const row = (r: Row, ctx: Ctx) => {
  const s = ctx.store.get();
  const pad = `padding-left:${8 + r.depth * 16}px`;
  if (r.t === "dir") {
    const open = s.expanded.includes(r.entry.path);
    return `<div class="r ${r.project ? "proj" : ""}${cutClass(r.entry.path)}" style="${pad}" data-dir="${esc(r.entry.path)}">${icon(open ? "chevron-down" : "chevron-right", 13)}${
      r.project ? `<span class="ic book">${icon("book-open", 15)}</span>` : icon("folder", 14)
    }<span class="ttl">${esc(r.entry.name)}</span>${r.project ? `<button type="button" class="iconbtn project-git" data-project-git="${esc(r.entry.path)}" title="Git 設定を開く" aria-label="${esc(r.entry.name)}の Git 設定を開く">${icon("settings", 14)}</button>` : ""}</div>`;
  }
  const p = r.entry.path;
  const k = kindOf(p);
  const title = r.plot ? "プロット" : (ctx.titles.get(p) ?? stem(r.entry.name));
  // a heading as the name, the file's name small beside it (docs/adr/0004); otherwise the kind
  const fn = r.plot ? "" : ctx.titles.has(p) ? r.entry.name.replace(/\.gm$/, "") : k;
  const on = s.open.some((d) => d.path === p) || s.selected.includes(p) || (r.plot && s.plot === r.project);
  return `<div class="r ${on ? "on" : ""}${cutClass(p)}" style="${pad}" data-file="${esc(p)}" ${r.plot ? `data-plot="${esc(r.project!)}"` : ""}>${icon(
    r.plot ? "table-2" : (ICONS[k] ?? (IMAGE_KINDS.includes(k) ? "image" : "file")),
    14,
  )}<span class="ttl">${esc(title)}</span><span class="fn">${esc(fn)}</span><span class="c">${ctx.decor.map((f) => f(p, ctx)).join("")}</span></div>`;
};

const rowsNow = (ctx: Ctx) => {
  const ws = ctx.store.get().workspace;
  const expanded = new Set(ctx.store.get().expanded);
  const of = (p: string) => chapters.get(p) ?? [];
  const known = new Set(ctx.projects);
  return ws ? workspaceRows(ws, orderProjectEntries(ws, entries, known, ctx.config.projectOrder), expanded, of, known) : treeRows(entries, expanded, of);
};

/** The paths a drag or a copy from the pressed row hands outside (docs/adr/0077). */
export const handedOverFrom = (ctx: Ctx, pressed: string) => handedOver(pressed, ctx.store.get().selected, rowsNow(ctx).map((r) => r.entry.path));

/** Writes a folder as a zip whose names are NFC (docs/adr/0077); Rust asks where. */
const zipFolder = async (ctx: Ctx, dir: string) => {
  try {
    const written = await api.zipFolder(dir, zipNames(await api.zipEntries(dir)));
    if (!written) return;
    ctx.notify({ message: `${basename(written)} に書き出しました` });
    await reloadTree(ctx);
    ctx.refresh(["sidebar"]);
  } catch (error) {
    notifyError(`zip に書き出せませんでした: ${String(error)}`);
  }
};

const copyFiles = async (ctx: Ctx, pressed: string) => {
  const paths = handedOverFrom(ctx, pressed);
  try {
    await api.copyFiles(paths);
    clip.copied();
    ctx.toast(paths.length === 1 ? `${basename(paths[0])} をコピーしました` : `${paths.length} 件をコピーしました`);
  } catch (error) {
    notifyError(`コピーできませんでした: ${String(error)}`);
  }
};

// the tree is drawn anew on every change (a sheet chosen, a row opened); it stays where it was scrolled
const draw = (el: HTMLElement, ctx: Ctx) => keepScroll(el, ".file-tree", () => drawRows(el, ctx));

const drawRows = (el: HTMLElement, ctx: Ctx) => {
  const s = ctx.store.get();
  el.innerHTML = `<div class="acts">
      <span class="iconbtn" data-act="new-file" title="新しいシート">${icon("square-pen")}</span>
      <span class="iconbtn" data-act="new-folder" title="新しいフォルダ">${icon("folder-plus")}</span>
      <span class="iconbtn" data-act="new-project" title="新しいプロジェクト（golem new）">${icon("book-plus")}</span>
      <span class="sp"></span>
      <span class="iconbtn" data-act="refresh" title="読みなおす">${icon("refresh-cw")}</span>
      <span class="iconbtn" data-act="collapse" title="すべて閉じる">${icon("chevrons-down-up")}</span>
    </div>
    <div class="file-tree">${
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

/** Both rename entry points operate on the row that was activated. */
const renameTreeItem = async (ctx: Ctx, from: string) => {
  if (!canRenameTreeItem(from, ctx.store.get().workspaces, ctx.projects)) return;
  const name = await ask("名前を変える", basename(from));
  if (name === null) return;
  const to = renameTarget(from, name);
  if (!to) return;
  let prepared: Awaited<ReturnType<NonNullable<Ctx["prepareRename"]>>> = null;
  let renamed = false;
  ctx.renameReferencesHandled = false;
  try {
    if (await api.exists(to)) return toast(`${name} はもうあります`);
    const open = allDocs(ctx.store.get())
      .filter((d) => d.path === from || d.path.startsWith(`${from}/`))
      .map((d) => d.path);
    if (open.length) await ctx.save(open);
    // mayWrite can decline a save when an external edit conflicts with it.
    if (allDocs(ctx.store.get()).some((d) => open.includes(d.path) && (ctx.editors.get(d.path)?.text() ?? d.text) !== d.saved)) return;
    for (const f of ctx.beforeRename) await f(from, to, ctx);
    if (ctx.prepareRename) {
      try {
        prepared = await ctx.prepareRename(from, to, ctx);
      } catch (error) {
        const selected = await choiceDialog("参照を更新できませんでした", String(error), ["中止", "参照を更新せず改名"]);
        if (selected !== 1) return;
      }
    }
    await api.rename(from, to);
    renamed = true;
    await prepared?.renamed();
    ctx.store.dispatch({ type: "rename", from, to });
    for (const f of ctx.onRename) await f(from, to, ctx);
    await reloadTree(ctx);
    ctx.refresh(["sidebar"]);
  } catch (error) {
    if (!renamed && prepared) {
      try { await prepared.rollback(); }
      catch (undoError) { notifyError(`参照の編集を戻せませんでした: ${String(undoError)}`); }
    }
    notifyError(String(error));
  }
};

/** Creates exactly one child of the row that opened the menu. */
const createAt = async (ctx: Ctx, parent: string, dir: boolean) => {
  const name = await ask(dir ? "新しいフォルダの名前" : "新しいシートの名前");
  if (name === null) return;
  const kindIndex = dir ? null : await choiceDialog("シートの種類", "", [...SHEET_KINDS]);
  if (!dir && kindIndex === null) return;
  const path = createdPath(parent, name, kindIndex === null ? null : SHEET_KINDS[kindIndex]);
  if (!path) return toast("名前には一つの名前だけを指定してください");
  try {
    await api.createEntry(path, dir);
    await reloadTree(ctx);
    ctx.store.dispatch({ type: "expand", path: parent, on: true });
    ctx.refresh(["sidebar"]);
    if (!dir) await ctx.open([path]);
  } catch (error) {
    notifyError(String(error));
  }
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

/** Resolves the ordinary New Sheet name before any file is created (docs/adr/0093). */
const newSheetName = async (input: string): Promise<string | null> => {
  const leaf = basename(input);
  if (ext(leaf)) return input;
  const name = input.replace(/\.+$/, "");
  if (!basename(name)) return toast("シートの名前を指定してください"), null;
  const formats = [
    { label: "やめる", extension: "" },
    { label: "Markdown (.md)", extension: ".md" },
    { label: "Golem (.gm)", extension: ".gm" },
  ];
  const choice = await choiceDialog("シートの形式", "", formats.map(({ label }) => label));
  const extension = choice === null ? "" : formats[choice].extension;
  return extension ? name + extension : null;
};

const prepareProjectFonts = async (ctx: Ctx, project: string) => {
  try {
    for (const prepare of ctx.onNewProject) await prepare(project, ctx);
  } catch (error) {
    ctx.notify({ message: `フォントを用意できませんでした：${String(error)}`, level: "warning" });
  }
};

const initializeProject = async (ctx: Ctx, root: string) => {
  if (ctx.projects.includes(root))
    return void ctx.notify({ message: `${root} はすでに Golem プロジェクトです`, level: "warning" });
  if (initializing.has(root))
    return void ctx.notify({ message: `${root} を初期化しています` });
  initializing.set(root, "placing");
  try {
    try {
      await api.initializeWorkspaceProject(root);
    } catch (error) {
      ctx.notify({ message: `Golem プロジェクトに初期化できませんでした\n${String(error)}`, level: "error", sticky: true });
      return;
    }
    initializing.set(root, "refreshing");

    await prepareProjectFonts(ctx, root);
    try {
      await reloadTree(ctx);
      if (!ctx.projects.includes(root)) throw new Error("ツリーでプロジェクトを再確認できません");
      forgetGrid(root);
      forgetManifest(root);
      const [grid] = await Promise.all([gridOf(root), loadManifest(root)]);
      ctx.store.dispatch({ type: "projectInitialized", root, grid });
      ctx.refresh(["sidebar", "rightSidebar", "status", "previewTab"]);
    } catch (error) {
      ctx.notify({ message: `初期化したプロジェクトを読み直せませんでした：${root}\n${String(error)}`, level: "error", sticky: true });
      return;
    }
    ctx.notify({ message: `Golem プロジェクトに初期化しました：${root}` });
  } finally {
    initializing.delete(root);
  }
};

/** The workspace menu is also available when the root has no tree row. */
export const workspaceProjectItem = (ctx: Ctx, root: string | null): MenuItem | null =>
  root && root === ctx.store.get().workspace
    ? {
        label: ctx.projects.includes(root) ? "Golem プロジェクトに初期化（初期化済み）" : "Golem プロジェクトに初期化",
        icon: icon("book-plus", 14),
        disabled: ctx.projects.includes(root) || initializing.has(root),
        run: () => { if (root === ctx.store.get().workspace) void runTreeAct(ctx, "init-project"); },
      }
    : null;

/** The tree's actions (the buttons above it), also run as commands (docs/adr/0023). */
export const runTreeAct = async (ctx: Ctx, act: string) => {
  const s = ctx.store.get();
  switch (act) {
    case "init-project":
      if (s.workspace) await initializeProject(ctx, s.workspace);
      return;
    case "add-ws":
      return addWorkspace(ctx);
    case "refresh":
      await reloadTree(ctx);
      return ctx.refresh(["sidebar"]);
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
      // a name like an option is not passed to golem (docs/adr/0048)
      if (name.startsWith("-")) return toast("「-」で始まる名前のプロジェクトは作れません");
      // fonts come from the shared library, never from golem's download (docs/adr/0004, docs/adr/0014)
      const out = await golem(ctx, ws, ["new", name, "--no-fonts"]);
      if (out.code !== 0) return void notifyError((out.stderr || out.stdout).trim() || "golem new に失敗しました");
      await prepareProjectFonts(ctx, `${ws}/${name}`);
      await reloadTree(ctx);
      ctx.store.dispatch({ type: "expand", path: `${ws}/${name}`, on: true });
      return ctx.open([`${ws}/${name}/chapters/01.gm`]);
    }
    case "new-file": {
      const project = focused(s)?.project ?? null;
      const dir = project ?? targetDir(ctx);
      if (!dir) return;
      const proposed = project
        ? await ask("新しい章のファイル名", `chapters/${String((chapters.get(project)?.length ?? 0) + 1).padStart(2, "0")}.gm`)
        : await ask("新しいシートの名前", "untitled.md");
      if (proposed === null) return;
      const name = await newSheetName(proposed);
      if (name === null) return;
      const path = `${dir}/${name}`;
      if (await api.exists(path)) return toast(`${name} はもうあります`);
      await api.writeText(path, project ? "# \n" : "", true);
      if (project && ext(name) === "gm") {
        await updateChapter(ctx, path, project, "add");
      }
      await reloadTree(ctx);
      return ctx.open([path], { line: 1, col: 2 });
    }
  }
};

/** Keep an open manifest in step with the checked update, unless the writer edited it meanwhile. */
const updateChapter = async (ctx: Ctx, path: string, project: string, mode: "add" | "toggle") => {
  const manifestPath = `${project}/manifest.toml`;
  try {
    const currentManifest = () => allDocs(ctx.store.get()).find((doc) => doc.path === manifestPath);
    if (currentManifest()) await ctx.save([manifestPath]);
    const before = currentManifest();
    if (before && before.text !== before.saved) return;
    const { text: updated } = await api.updateManifestChapter(project, path, mode);
    const current = currentManifest();
    if (before && current && current.text === before.text && current.saved === before.saved) {
      const editor = ctx.editors.get(manifestPath);
      if (editor?.edit && editor.text() !== updated) editor.edit.apply([{ from: 0, to: editor.text().length, insert: updated }], "manifest");
      else ctx.store.dispatch({ type: "edit", path: manifestPath, text: updated });
      ctx.store.dispatch({ type: "saved", path: manifestPath, text: updated });
    }
  } catch (error) {
    notifyError(`manifest.toml の更新に失敗しました: ${String(error)}`);
  }
};

const toggleChapter = async (ctx: Ctx, path: string, project: string) => {
  await updateChapter(ctx, path, project, "toggle");
  await reloadTree(ctx);
  ctx.refresh(["sidebar"]);
};

const exportSelected = async (ctx: Ctx, paths: string[]) => {
  try {
    const opened = new Map(allDocs(ctx.store.get()).map((doc) => [doc.path, doc]));
    const parts = paths.map((path) => ({
      path,
      live: opened.has(path) ? (ctx.editors.get(path)?.text() ?? opened.get(path)!.text) : null,
    }));
    if (await api.exportChapters(parts)) ctx.toast(`${paths.length} 件の原稿を書き出しました`);
  } catch (error) {
    notifyError(`原稿の書き出しに失敗しました: ${String(error)}`);
  }
};

export const mountTree = (ctx: Ctx) => {
  let projectOrderSave = Promise.resolve();
  // a cut cannot move across workspaces, and its faint row follows it (docs/adr/0109)
  ctx.store.subscribe((s, prev) => { if (s.workspace !== prev.workspace) clip.switched(); });
  clip.listen(() => ctx.refresh(["sidebar"]));
  ctx.sidebar.files = {
    icon: "files",
    title: "ファイル",
    render: async (el) => {
      if (!entries.length) await reloadTree(ctx);
      draw(el, ctx);
      el.onclick = async (e) => {
        const settings = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-project-git]");
        if (settings?.dataset.projectGit) return openRepositorySettings(ctx, settings.dataset.projectGit, settings.dataset.projectGit, settings);
        const t = (e.target as HTMLElement).closest<HTMLElement>("[data-file],[data-dir],[data-act]");
        if (!t) return;
        const d = t.dataset;
        const s = ctx.store.get();
        if (d.dir) return ctx.store.dispatch({ type: "expand", path: d.dir, on: !s.expanded.includes(d.dir) });
        // ⌥ opens in a new tab (docs/adr/0024)
        const newTab = (e as MouseEvent).altKey;
        if (d.plot) return void ctx.open([`${d.plot}/plot.csv`], undefined, { newTab });
        // a kind Aleph cannot open (in a project's build/) is only selected (docs/adr/0077)
        if (d.file && !opensOnClick(d.file)) return ctx.store.dispatch({ type: "select", paths: [d.file], anchor: d.file });
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
        if (t?.dataset.file) await renameTreeItem(ctx, t.dataset.file);
      };
    },
  };

  // "Finder で表示" for files, folders and projects (docs/adr/0053)
  treeMenus.push((path, dir, c) => {
    const item = dir ? workspaceProjectItem(c, path) : null;
    return item ? [item] : [];
  });
  treeMenus.push((p) => revealItems(p, (x) => void api.revealPath(x).catch((e) => notifyError(String(e))), icon("folder", 14)));
  // the files' URLs on the pasteboard, and a folder's zip (docs/adr/0077)
  treeMenus.push((p, dir) => [
    // cut and paste (docs/adr/0109): one movable item is cut; folders and projects take a paste
    ...(canRenameTreeItem(p, ctx.store.get().workspaces, ctx.projects)
      ? [clip.current()?.path === p
          ? { label: "切り取りをやめる", icon: icon("x", 14), run: () => clip.cancel() }
          : { label: "切り取り", icon: icon("scissors", 14), run: () => void cutItem(ctx, p, reloadTree) }]
      : []),
    { label: "コピー", icon: icon("files", 14), run: () => void copyFiles(ctx, p) },
    ...(dir && !ctx.store.get().workspaces.includes(p)
      ? [{ label: "貼り付け", icon: icon("clipboard-paste", 14), run: () => void pasteInto(ctx, p, reloadTree) }]
      : []),
    ...(dir ? [{ label: "zip で書き出す…", icon: icon("folder", 14), run: () => void zipFolder(ctx, p) }] : []),
  ]);
  treeMenus.push((p) =>
    canRenameTreeItem(p, ctx.store.get().workspaces, ctx.projects)
      ? [{ label: "名前を変える", icon: icon("pencil", 14), run: () => void renameTreeItem(ctx, p) }]
      : [],
  );

  treeMenus.push((path, dir) => {
    const ws = ctx.store.get().workspace;
    if (!dir || !ws) return [];
    const neighbors = projectNeighbors(ws, entries, new Set(ctx.projects), ctx.config.projectOrder, path);
    return (["up", "down"] as const).flatMap((direction): MenuItem[] => neighbors[direction]
      ? [{ label: direction === "up" ? "一つ上へ" : "一つ下へ", run: () => {
          ctx.config.projectOrder = moveProject(ws, entries, new Set(ctx.projects), ctx.config.projectOrder, path, direction);
          ctx.refresh(["sidebar"]);
          projectOrderSave = projectOrderSave.then(() => ctx.saveConfig()).catch((error) => { notifyError(String(error)); });
        } }]
      : []);
  });

  treeMenus.push((p, dir) => dir
    ? [
        { label: "フォルダを追加", icon: icon("folder-plus", 14), run: () => void createAt(ctx, p, true) },
        { label: "シートを追加", icon: icon("square-pen", 14), run: () => void createAt(ctx, p, false) },
      ]
    : []);

  treeMenus.push((path, dir) => {
    if (dir) return [];
    const items: MenuItem[] = [];
    const project = projectOf(path, ctx.projects);
    if (kindOf(path) === "gm" && project) {
      const registered = (chapters.get(project) ?? []).includes(path);
      items.push({ label: registered ? "chapters から削除" : "chapters に追加", run: () => void toggleChapter(ctx, path, project) });
    }
    const selected = ctx.store.get().selected;
    const paths = selected.includes(path) ? selected : [path];
    const shown = rowsNow(ctx).flatMap((row) => row.t === "file" ? [row.entry.path] : []);
    const ordered = selectedGmInTreeOrder(shown, paths);
    if (ordered) items.push({ label: "選択した原稿を書き出す", run: () => void exportSelected(ctx, ordered) });
    return items;
  });

  // a row's right-click: the items the other parts add
  document.addEventListener("contextmenu", (e) => {
    if ((e.target as Element).closest<HTMLButtonElement>("[data-project-git]")?.dataset.projectGit) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>(".file-tree [data-file]:not([data-plot]), .file-tree [data-dir]");
    const path = row?.dataset.file ?? row?.dataset.dir;
    if (!row || !path) return;
    let anchor = row;
    if (row.dataset.file && !ctx.store.get().selected.includes(path)) {
      ctx.store.dispatch({ type: "select", paths: [path], anchor: path });
      // Selecting a file redraws its row.
      if (!row.isConnected) {
        const drawn = document.querySelector<HTMLElement>(`.file-tree [data-file="${CSS.escape(path)}"]:not([data-plot])`);
        if (!drawn) return;
        anchor = drawn;
      }
    }
    const items = treeMenus.flatMap((f) => f(path, row.dataset.dir !== undefined, ctx));
    if (!items.length) return;
    e.preventDefault();
    menu(anchor, items);
  });

  // after saving a manifest or a style, chapters and grids are read again
  ctx.onRename.push((from) => {
    if (from.endsWith("/style.toml")) forgetGrid(dirname(from));
  });

  ctx.settings.push({
    id: "tree-visibility",
    label: "ファイルツリー",
    group: "オプション",
    render: (c) =>
      item("隠しファイルを表示", "名前が . で始まるファイルとフォルダを表示する", toggle("showHiddenFiles", c.config.showHiddenFiles)) +
      item(".gitignore 対象のファイルを表示", "ワークスペースの .gitignore に従う", toggle("showGitignoredFiles", c.config.showGitignoredFiles)),
    onClick: async (el, c) => {
      const setting = el.closest<HTMLElement>("[data-toggle]")?.dataset.toggle;
      if (setting !== "showHiddenFiles" && setting !== "showGitignoredFiles") return false;
      c.config[setting] = !c.config[setting];
      await c.saveConfig();
      await reloadTree(c);
      c.refresh(["sidebar"]);
      return true;
    },
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

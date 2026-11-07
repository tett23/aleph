// The main window: ribbon, workspace tree, toolbar, editor and previews, right panel, status.
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, basename, dirname, rel, stem, type Entry } from "./api";
import { config, saveConfig } from "./config";
import { parseDelimited, writeDelimited } from "./csv";
import { createEditor, notifySaved, PROSE, type Editor } from "./editor";
import { lineMarks } from "./diff";
import { gmBlocks, mdToGm, plainParagraphs, stats, type Grid } from "./gm";
import { esc, h, icon } from "./icons";
import { lspFor } from "./lsp";
import { mountAttachments, mountGit, mountLibrary, mountOutline, mountSearch, openSettings, type Ctx } from "./panels";
import { mountPlot } from "./plot";
import { buildChapterHtml, buildPages, renderEvaluated, renderMarkdown, renderMermaid, renderPages, renderPdf, renderSvg, type BuildResult } from "./preview";
import { addChapter, copyFonts, flatten, gridOf, kindOf, loadMeta, loadPlot, manifestChapters, projectOf, rowsForFile, TEXT_KINDS, workspaceOf, type PlotRow } from "./project";
import { loadPlugins, registry } from "./plugins";
import { ask, menu, toast } from "./ui";

type Doc = { path: string; kind: string; text: string; saved: string; project: string | null; workspace: string | null; grid: Grid };

const store = {
  get: <T>(k: string, d: T): T => {
    try {
      return JSON.parse(localStorage.getItem(k) ?? "") as T;
    } catch {
      return d;
    }
  },
  set: (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v)),
};

const state = {
  workspace: store.get<string | null>("ws", null),
  left: "files" as "files" | "search" | "git",
  right: store.get<"attach" | "outline" | "library">("right", "attach"),
  showLeft: true,
  showRight: store.get("showRight", true),
  side: store.get<"none" | "plain" | "pages">("side", "none"),
  vertical: store.get("vertical", false),
  expanded: new Set(store.get<string[]>("expanded", [])),
  tree: [] as Entry[],
  dirty: new Set<string>(),
  doc: null as Doc | null,
  editor: null as Editor | null,
  plotView: null as { project: string } | null,
  plot: [] as PlotRow[],
  plotProject: "",
  pages: new Map<string, BuildResult>(),
  html: new Map<string, { html: string | null; note: string }>(), // evaluated chapters by path
  building: new Set<string>(),
  diagnostics: { errors: 0, warnings: 0 },
  fontsChecked: new Set<string>(),
  titles: new Map<string, { title: string; chars: number }>(),
};

const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="ribbon" data-tauri-drag-region>
    <span class="iconbtn" data-left="files" title="ファイル">${icon("files")}</span>
    <span class="iconbtn" data-left="search" title="検索">${icon("search")}</span>
    <span class="iconbtn" data-left="git" title="Git">${icon("git-branch")}</span>
    <span class="iconbtn" data-plot title="プロット">${icon("table-2")}</span>
    <span class="grow drag" data-tauri-drag-region></span>
    <span class="iconbtn" data-settings title="設定">${icon("settings")}</span>
  </div>
  <div class="side"></div>
  <div class="center">
    <div class="toolbar drag" data-tauri-drag-region></div>
    <div class="split"><div class="pane main-pane"><div class="pbody"></div></div><div class="pane side-pane" hidden><div class="phead"></div><div class="pbody"></div></div></div>
    <div class="status"></div>
  </div>
  <div class="right"><div class="rhead drag" data-tauri-drag-region></div><div class="rbody"></div></div>`;

const $ = <T extends HTMLElement>(s: string) => app.querySelector<T>(s)!;
const sideEl = $(".side");
const toolbar = $(".toolbar");
const mainBody = $(".main-pane .pbody");
const sidePane = $(".side-pane");
const sideHead = $(".side-pane .phead");
const sideBody = $(".side-pane .pbody");
const statusEl = $(".status");
const rightEl = $(".right");
const rightHead = $(".rhead");
const rightBody = $(".rbody");

const ctx: Ctx = {
  openFile: (p, line, col) => openFile(p, line, col),
  current: () =>
    state.doc && { path: state.doc.path, project: state.doc.project, workspace: state.doc.workspace, text: state.editor?.text() ?? state.doc.text, kind: state.doc.kind },
  workspace: () => currentWs(),
  refreshTree: () => refreshTree(),
  refreshRight: () => void renderRight(),
  refreshMarks: () => state.editor?.refreshMarks(true),
  toast,
  afterConfig: async () => {
    if (state.workspace && !config.workspaces.includes(state.workspace)) state.workspace = null;
    await refreshTree();
    if (state.doc) {
      state.editor?.setWidth(charsOf(state.doc));
      state.editor?.setInvisibles(config.showInvisibles);
    }
    renderAll();
  },
};

const currentWs = () => {
  if (!state.workspace || !config.workspaces.includes(state.workspace)) state.workspace = config.workspaces[0] ?? null;
  return state.workspace;
};

/** A fresh element inside a scrolling body: renderers set their own class on it, not on the body. */
const inner = (body: HTMLElement) => {
  const d = document.createElement("div");
  body.replaceChildren(d);
  return d;
};

const charsOf = (d: Doc) => (PROSE.includes(d.kind) ? (config.charsOverride ?? d.grid.chars) : 110);

// ---------------- tree ----------------
const ring = (pct: number) => {
  const C = 2 * Math.PI * 7;
  return `<svg width="13" height="13" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" fill="none" stroke="var(--bg-3)" stroke-width="3"/>${pct > 0 ? `<circle cx="9" cy="9" r="7" fill="none" stroke="var(--accent)" stroke-width="3" stroke-dasharray="${Math.min(1, pct) * C} ${C}" transform="rotate(-90 9 9)"/>` : ""}</svg>`;
};

const titleOf = async (p: string) => {
  const k = kindOf(p);
  if (k !== "gm" && k !== "md") return null;
  const text = await api.readText(p).catch(() => "");
  const first = k === "gm" ? gmBlocks(text).find((b) => b.kind === "h")?.text : /^#{1,6}\s+(.*)$/m.exec(text)?.[1];
  const chars = stats(plainParagraphs(k, text), config.manuscript.cols, config.manuscript.rows).chars;
  return { title: first?.trim() || stem(p), chars };
};

const refreshTree = async () => {
  const ws = currentWs();
  state.tree = ws ? await api.listTree(ws) : [];
  if (ws) {
    const st = await api.git(ws, ["status", "--porcelain=v1", "-uall"]).catch(() => null);
    state.dirty = new Set((st?.code === 0 ? st.stdout.split("\n").filter(Boolean) : []).map((l) => `${ws}/${l.slice(3)}`));
  }
  await Promise.all(
    flatten(state.tree)
      .filter((e) => ["gm", "md"].includes(kindOf(e.path)))
      .map(async (e) => {
        const t = await titleOf(e.path);
        if (t) state.titles.set(e.path, t);
      }),
  );
  renderSide();
};

const isProject = (e: Entry) => e.dir && e.children.some((c) => c.name === "manifest.toml");

const metaCache = new Map<string, { goals: Map<string, number> }>();
const goalsOf = async (project: string) => {
  const meta = await loadMeta(project);
  const plot = await loadPlot(project);
  const goals = new Map<string, number>();
  for (const e of flatten(state.tree).filter((x) => x.path.startsWith(project + "/"))) {
    const m = meta[rel(project, e.path)];
    const planned = rowsForFile(plot, project, e.path).reduce((a, r) => a + (Number(r.target) || 0), 0);
    const g = m?.goal ?? planned;
    if (g) goals.set(e.path, g);
  }
  metaCache.set(project, { goals });
};

const fileRow = (e: Entry, depth: number, project: string | null) => {
  const k = kindOf(e.path);
  const t = state.titles.get(e.path);
  const goal = project ? metaCache.get(project)?.goals.get(e.path) : undefined;
  const ic = { gm: "file-text", md: "file-text", emet: "sigma", toml: "settings-2", csv: "sheet", tsv: "sheet", svg: "image", mmd: "workflow", pdf: "file-type", txt: "file" }[k] ?? "file";
  const isPlot = project && e.path === `${project}/plot.csv`;
  const name = isPlot ? "プロット" : t ? t.title : stem(e.name);
  const fn = isPlot ? "" : k === "gm" && t ? stem(e.name) : k;
  return `<div class="r ${state.doc?.path === e.path || (isPlot && state.plotView?.project === project) ? "on" : ""}" style="padding-left:${8 + depth * 16}px" data-file="${esc(e.path)}" ${isPlot ? `data-plotfor="${esc(project!)}"` : ""}>
    ${icon(isPlot ? "table-2" : ic, 14)}<span class="ttl">${esc(name)}</span><span class="fn">${esc(fn)}</span>
    <span class="c">${t && k === "gm" ? `${t.chars.toLocaleString()}` : ""}${state.dirty.has(e.path) ? `<span class="dot"></span>` : ""}${goal ? ring((t?.chars ?? 0) / goal) : ""}</span></div>`;
};

const dirRows = (entries: Entry[], depth: number, project: string | null): string =>
  entries
    .map((e) => {
      if (!e.dir) return TEXT_KINDS.includes(kindOf(e.path)) || kindOf(e.path) === "pdf" ? fileRow(e, depth, project) : "";
      const proj = isProject(e);
      const open = state.expanded.has(e.path);
      const total = proj ? flatten(e.children).reduce((a, c) => a + (kindOf(c.path) === "gm" ? (state.titles.get(c.path)?.chars ?? 0) : 0), 0) : 0;
      const head = `<div class="r ${proj ? "proj" : ""}" style="padding-left:${8 + depth * 16}px" data-dir="${esc(e.path)}">${icon(open ? "chevron-down" : "chevron-right", 13)}${proj ? `<span class="ic book">${icon("book-open", 15)}</span>` : icon("folder", 14)}<span class="ttl">${esc(e.name)}</span>${proj ? `<span class="c">${total.toLocaleString()} 字</span>` : ""}</div>`;
      if (!open) return head;
      if (!proj) return head + dirRows(e.children, depth + 1, project);
      // a project: chapters in manifest order, then the rest
      const chapters = projectChapters.get(e.path) ?? [];
      const byPath = new Map(flatten(e.children).map((c) => [c.path, c]));
      const chapterRows = chapters.flatMap((p) => (byPath.has(p) ? [fileRow(byPath.get(p)!, depth + 1, e.path)] : []));
      const rest = e.children
        .map((c) => (c.dir ? { ...c, children: c.children.filter((x) => !chapters.includes(x.path)) } : c))
        .filter((c) => !chapters.includes(c.path))
        .filter((c) => !(c.dir && c.children.length === 0 && c.name === "chapters"))
        .sort((a, b) => Number(b.name === "plot.csv") - Number(a.name === "plot.csv"));
      return head + chapterRows.join("") + dirRows(rest, depth + 1, e.path);
    })
    .join("");

const projectChapters = new Map<string, string[]>();

const renderSide = async () => {
  sideEl.classList.toggle("hidden", !state.showLeft);
  app.querySelectorAll<HTMLElement>("[data-left]").forEach((b) => b.classList.toggle("on", b.dataset.left === state.left && state.showLeft));
  const ws = currentWs();
  const head = `<div class="wsbar drag" data-tauri-drag-region><span class="name" data-wsmenu>${icon("chevrons-up-down", 13)}<span>${esc(ws ? basename(ws) : "ワークスペースなし")}</span></span><span class="br" data-left-git>${icon("git-branch", 12)}<span class="branch"></span></span></div>`;
  if (state.left === "search") {
    sideEl.innerHTML = head + `<div class="searchhost" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>`;
    mountSearch(sideEl.querySelector(".searchhost")!, ctx);
  } else if (state.left === "git") {
    sideEl.innerHTML = head + `<div class="githost rbody"></div>`;
    await mountGit(sideEl.querySelector(".githost")!, ctx);
  } else {
    for (const e of flatten([{ path: "", name: "", dir: true, children: state.tree }]).length ? collectProjects(state.tree) : []) {
      if (!projectChapters.has(e.path)) {
        const chapters = manifestChapters(await api.readText(`${e.path}/manifest.toml`).catch(() => "")).map((r) => `${e.path}/${r}`);
        projectChapters.set(e.path, chapters);
      }
      if (!metaCache.has(e.path)) await goalsOf(e.path);
    }
    sideEl.innerHTML =
      head +
      `<div class="acts">
        <span class="iconbtn" data-act="new-file" title="新しいシート">${icon("square-pen")}</span>
        <span class="iconbtn" data-act="new-folder" title="新しいフォルダ">${icon("folder-plus")}</span>
        <span class="iconbtn" data-act="new-project" title="新しいプロジェクト（golem new）">${icon("book-plus")}</span>
        <span class="sp"></span>
        <span class="iconbtn" data-act="refresh" title="読みなおす">${icon("refresh-cw")}</span>
        <span class="iconbtn" data-act="collapse" title="すべて閉じる">${icon("chevrons-down-up")}</span>
      </div>
      <div class="tree">${ws ? dirRows(state.tree, 0, null) || `<div class="empty">空のワークスペースです。${icon("book-plus", 13)} で Golem のプロジェクトを作れます。</div>` : `<div class="empty">ワークスペース（Git のリポジトリ）を足してください。<br><span class="btn" data-act="add-ws">フォルダを選ぶ</span></div>`}</div>`;
  }
  if (ws) api.git(ws, ["branch", "--show-current"]).then((o) => (sideEl.querySelector(".branch")!.textContent = o.code === 0 ? o.stdout.trim() : "—")).catch(() => {});
};

const collectProjects = (entries: Entry[]): Entry[] => entries.flatMap((e) => (e.dir ? (isProject(e) ? [e] : collectProjects(e.children)) : []));

const targetDir = () => {
  const d = state.doc?.path ? dirname(state.doc.path) : currentWs();
  return d;
};

sideEl.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const row = t.closest<HTMLElement>("[data-file],[data-dir],[data-act],[data-wsmenu],[data-left-git]");
  if (!row) return;
  const d = row.dataset;
  if (d.wsmenu !== undefined) {
    return menu(row, [
      ...config.workspaces.map((w) => ({ label: basename(w), icon: icon(w === state.workspace ? "check" : "dot", 14), run: () => switchWs(w) })),
      "-",
      { label: "ワークスペースを足す…", icon: icon("plus", 14), run: addWorkspace },
    ]);
  }
  if (d.leftGit !== undefined) return setLeft("git");
  if (d.dir) {
    state.expanded.has(d.dir) ? state.expanded.delete(d.dir) : state.expanded.add(d.dir);
    store.set("expanded", [...state.expanded]);
    return renderSide();
  }
  if (d.plotfor) return openPlot(d.plotfor);
  if (d.file) return openFile(d.file);
  const ws = currentWs();
  switch (d.act) {
    case "add-ws":
      return addWorkspace();
    case "refresh":
      projectChapters.clear();
      metaCache.clear();
      return refreshTree();
    case "collapse":
      state.expanded.clear();
      store.set("expanded", []);
      return renderSide();
    case "new-folder": {
      const name = await ask("新しいフォルダの名前");
      if (name && ws) await api.makeDir(`${targetDir()}/${name}`);
      return refreshTree();
    }
    case "new-project": {
      if (!ws) return;
      const name = await ask("新しいプロジェクトの名前（golem new）");
      if (!name) return;
      const out = await api.tool("golem", config.golemPath || undefined, ws, ["new", name, ...(config.libraryDir ? ["--no-fonts"] : [])]);
      if (out.code !== 0) return toast(out.stderr || out.stdout);
      const copied = await copyFonts(`${ws}/${name}`);
      state.expanded.add(`${ws}/${name}`);
      toast(`作りました${copied.length ? `（フォントを共有ライブラリからコピー: ${copied.join(", ")}）` : ""}`);
      await refreshTree();
      return openFile(`${ws}/${name}/chapters/01.gm`);
    }
    case "new-file": {
      if (!ws) return;
      const project = state.doc?.project ?? null;
      if (project) {
        const chapters = projectChapters.get(project) ?? [];
        const n = String(chapters.length + 1).padStart(2, "0");
        const name = await ask("新しい章のファイル名", `chapters/${n}.gm`);
        if (!name) return;
        const p = `${project}/${name}`;
        await api.writeText(p, "# \n");
        if (name.endsWith(".gm")) {
          const mp = `${project}/manifest.toml`;
          await api.writeText(mp, addChapter(await api.readText(mp), name));
          projectChapters.delete(project);
        }
        await refreshTree();
        return openFile(p, 1, 2);
      }
      const name = await ask("新しいシートの名前", "untitled.md");
      if (!name) return;
      const p = `${targetDir()}/${name}`;
      await api.writeText(p, "");
      await refreshTree();
      return openFile(p);
    }
  }
});

sideEl.addEventListener("dblclick", async (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-file]");
  if (!row || row.dataset.plotfor) return;
  const p = row.dataset.file!;
  const name = await ask("名前を変える", basename(p));
  if (!name || name === basename(p)) return;
  await api.rename(p, `${dirname(p)}/${name}`);
  if (state.doc?.path === p) state.doc.path = `${dirname(p)}/${name}`;
  projectChapters.clear();
  await refreshTree();
});

const addWorkspace = async () => {
  const p = (await openDialog({ directory: true, multiple: false })) as string | null;
  if (!p) return;
  if (!config.workspaces.includes(p)) config.workspaces.push(p);
  await saveConfig();
  await switchWs(p);
};

const switchWs = async (w: string) => {
  state.workspace = w;
  store.set("ws", w);
  await closeDoc();
  await refreshTree();
  renderAll();
};

const setLeft = (l: typeof state.left) => {
  if (state.left === l && state.showLeft) state.showLeft = false;
  else {
    state.left = l;
    state.showLeft = true;
  }
  renderSide();
};

app.querySelector(".ribbon")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-left],[data-plot],[data-settings]");
  if (!b) return;
  if (b.dataset.left) setLeft(b.dataset.left as typeof state.left);
  if (b.dataset.plot !== undefined) {
    const p = state.doc?.project ?? state.plotView?.project ?? collectProjects(state.tree)[0]?.path;
    if (p) openPlot(p);
    else toast("Golem のプロジェクトがありません");
  }
  if (b.dataset.settings !== undefined) openSettings(ctx);
});

// ---------------- documents ----------------
let buildTimer = 0;

// autosave: every few seconds when the sheet has changed (⌘S saves at once)
setInterval(() => {
  const d = state.doc;
  if (d && state.editor && state.editor.text() !== d.saved) save(false);
}, Math.max(2, config.autosaveSeconds || 10) * 1000);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Commits every change of a workspace; returns git's last line. */
const commitAll = async (ws: string, message: string) => {
  await save(true);
  const st = await api.git(ws, ["status", "--porcelain=v1"]);
  if (st.code !== 0) return "Git のリポジトリではありません";
  if (!st.stdout.trim()) return "変更はありません";
  await api.git(ws, ["add", "-A"]);
  const out = await api.git(ws, ["commit", "-m", message]);
  await refreshTree();
  state.editor?.refreshMarks(true);
  return (out.stdout + out.stderr).trim().split("\n")[0] || "コミットしました";
};

/** Once a day, commit each workspace that has changes. */
const autoCommit = async () => {
  if (!config.autoCommit) return;
  const day = today();
  for (const ws of config.workspaces) {
    if (config.lastAutoCommit[ws] === day) continue;
    const st = await api.git(ws, ["status", "--porcelain=v1"]).catch(() => null);
    if (!st || st.code !== 0) continue;
    if (st.stdout.trim()) {
      const r = await commitAll(ws, `Autosave ${day}`);
      toast(`${basename(ws)}: 1 日 1 回の自動コミット（${r}）`);
    }
    config.lastAutoCommit[ws] = day;
    await saveConfig();
  }
};

const closeDoc = async () => {
  if (state.doc && state.editor && state.editor.text() !== state.doc.saved) await save();
  state.editor?.destroy();
  state.editor = null;
  state.doc = null;
  state.plotView = null;
};

const openFile = async (path: string, line?: number, col?: number) => {
  if (state.doc?.path === path && state.editor) {
    if (line) state.editor.goto(line, col);
    return;
  }
  await closeDoc();
  const kind = kindOf(path);
  const workspace = workspaceOf(path);
  const project = workspace ? await projectOf(path, workspace) : null;
  if (project && path === `${project}/plot.csv`) return openPlot(project);
  const text = kind === "pdf" ? "" : await api.readText(path);
  state.doc = { path, kind, text, saved: text, project, workspace, grid: await gridOf(project) };
  if (project && !state.fontsChecked.has(project)) {
    state.fontsChecked.add(project);
    copyFonts(project).then((c) => c.length && toast(`共有ライブラリからフォントをコピーしました: ${c.join(", ")}`));
  }
  if (project && state.plotProject !== project) {
    state.plot = await loadPlot(project);
    state.plotProject = project;
  }
  // expand the folders down to the file
  if (workspace) {
    let d = dirname(path);
    while (d.length > workspace.length) {
      state.expanded.add(d);
      d = dirname(d);
    }
  }
  state.diagnostics = { errors: 0, warnings: 0 };
  mountMain();
  if (line) state.editor?.goto(line, col);
  renderAll();
};

const openPlot = async (project: string) => {
  await closeDoc();
  state.plotView = { project };
  mountPlot(mainBody, project, { onOpenFile: (r) => openFile(`${project}/${r}`) });
  renderAll();
};

const mountMain = () => {
  const d = state.doc!;
  mainBody.innerHTML = "";
  if (d.kind === "pdf") {
    renderPdf(inner(mainBody), d.path, dirname(d.path));
    return;
  }
  if (d.kind === "csv" || d.kind === "tsv") return mountTable(d);
  if (state.vertical && ["gm", "md", "txt"].includes(d.kind)) return mountVertical(d);
  state.editor = createEditor({
    parent: mainBody,
    path: d.path,
    kind: d.kind,
    text: d.text,
    project: d.project,
    grid: d.grid,
    chars: charsOf(d),
    invisibles: config.showInvisibles,
    base: async () => {
      if (!d.workspace) return null;
      const out = await api.git(d.workspace, ["show", `HEAD:${rel(d.workspace, d.path)}`]).catch(() => null);
      return out && out.code === 0 ? out.stdout : null;
    },
    onChange: (text) => onEdit(text),
    onSave: () => void save(true),
  });
  state.editor.view.focus();
};

/** The vertical editor: a textarea over a mirror with the same line breaks, which
 * shows the line numbers above each line and the change marks above them. */
const mountVertical = (d: Doc) => {
  const wrap = h(`<div class="vwrap"><div class="vstack"><div class="vmirror" aria-hidden="true"></div><textarea class="vedit" spellcheck="false"></textarea></div></div>`);
  const ta = wrap.querySelector("textarea")!;
  const mirror = wrap.querySelector<HTMLElement>(".vmirror")!;
  const stack = wrap.querySelector<HTMLElement>(".vstack")!;
  ta.value = d.text;
  let base: string | null | undefined;
  const setHeight = (c: number) => wrap.style.setProperty("--vchars", String(c));
  setHeight(charsOf(d));
  const layout = async () => {
    if (base === undefined) {
      base = null;
      if (d.workspace) {
        const out = await api.git(d.workspace, ["show", `HEAD:${rel(d.workspace, d.path)}`]).catch(() => null);
        base = out && out.code === 0 ? out.stdout : null;
      }
    }
    const marks = lineMarks(base, ta.value);
    mirror.innerHTML = ta.value
      .split("\n")
      .map((l, i) => `<div class="vl" data-n="${i + 1}" ${marks.get(i) ? `data-m="${marks.get(i)}"` : ""}>${esc(l) || "\u200b"}</div>`)
      .join("");
    // grow sideways with the text instead of scrolling inside the textarea
    ta.style.width = "0px";
    const w = Math.max(ta.scrollWidth, wrap.clientWidth - 40);
    ta.style.width = `${w}px`;
    stack.style.width = `${w}px`;
  };
  let t = 0;
  ta.addEventListener("input", () => {
    onEdit(ta.value);
    clearTimeout(t);
    t = window.setTimeout(layout, 120);
  });
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      save(true);
    }
  });
  mainBody.append(wrap);
  layout();
  ta.setSelectionRange(0, 0); // start at the beginning, the right edge
  wrap.scrollLeft = 0;
  state.editor = {
    view: null as never,
    text: () => ta.value,
    setWidth: (c) => (setHeight(c), layout()),
    setInvisibles: () => {},
    setGrid: () => {},
    refreshMarks: (reset) => {
      if (reset) base = undefined;
      layout();
    },
    goto: (line) => {
      const lines = ta.value.split("\n");
      const pos = lines.slice(0, Math.max(0, line - 1)).reduce((a, l) => a + l.length + 1, 0);
      ta.focus();
      ta.setSelectionRange(pos, pos);
      mirror.children[line - 1]?.scrollIntoView({ inline: "center", block: "nearest" });
    },
    destroy: () => wrap.remove(),
  };
  ta.focus();
};

const mountTable = (d: Doc) => {
  const sep = d.kind === "tsv" ? "\t" : ",";
  let rows = parseDelimited(d.text, sep);
  const render = () => {
    const width = Math.max(1, ...rows.map((r) => r.length));
    mainBody.innerHTML = `<div class="plot"><div class="bar2"><span class="f" data-add>${icon("plus", 14)}行</span><span class="f" data-addcol>${icon("plus", 14)}列</span><span class="sp"></span><span class="muted">${rows.length} 行 · ${width} 列 · ${d.kind.toUpperCase()}</span></div>
      <div class="table-wrap"><table class="grid"><tbody>${rows
        .map((r, i) => `<tr data-row="${i}"><td class="rowtools"><span data-del>${icon("x", 12)}</span></td>${Array.from({ length: width }, (_, j) => `<td><div class="cell" contenteditable="plaintext-only" data-c="${j}" ${i === 0 ? 'style="font-weight:600"' : ""}>${esc(r[j] ?? "")}</div></td>`).join("")}</tr>`)
        .join("")}</tbody></table></div></div>`;
  };
  const sync = () => onEdit(writeDelimited(rows, sep));
  mainBody.oninput = (e) => {
    const c = e.target as HTMLElement;
    const tr = c.closest("tr");
    if (!tr || c.dataset.c === undefined) return;
    const r = rows[Number(tr.dataset.row)];
    r[Number(c.dataset.c)] = c.innerText.replace(/\n$/, "");
    sync();
  };
  mainBody.onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-add],[data-addcol],[data-del]");
    if (!t) return;
    if (t.dataset.add !== undefined) rows.push([]);
    if (t.dataset.addcol !== undefined) rows = rows.map((r) => [...r, ""]);
    if (t.dataset.del !== undefined) rows.splice(Number(t.closest("tr")!.dataset.row), 1);
    sync();
    render();
  };
  render();
  state.editor = {
    view: null as never,
    text: () => writeDelimited(rows, sep),
    setWidth: () => {},
    setInvisibles: () => {},
    setGrid: () => {},
    refreshMarks: () => {},
    goto: () => {},
    destroy: () => {
      mainBody.oninput = null;
      mainBody.onclick = null;
    },
  };
};

const onEdit = (text: string) => {
  if (!state.doc) return;
  state.doc.text = text;
  renderTitle();
  scheduleStatus();
  if (state.side === "plain") scheduleSide();
};

const save = async (explicit = false) => {
  const d = state.doc;
  if (!d || !state.editor) return;
  const text = state.editor.text();
  if (text === d.saved && !explicit) return;
  await api.writeText(d.path, text);
  d.saved = text;
  notifySaved(d.project, d.path);
  renderTitle();
  registry.save.forEach((f) => f(ctx.current()));
  if (state.titles.has(d.path) || ["gm", "md"].includes(d.kind)) {
    const t = await titleOf(d.path);
    if (t) state.titles.set(d.path, t);
  }
  if (d.workspace) {
    const st = await api.git(d.workspace, ["status", "--porcelain=v1", "--", rel(d.workspace, d.path)]).catch(() => null);
    if (st?.stdout.trim()) state.dirty.add(d.path);
    else state.dirty.delete(d.path);
  }
  renderSide();
  if (d.path.endsWith("/style.toml") || d.path.endsWith("/manifest.toml")) projectChapters.clear();
  if (d.project && d.kind === "gm" && state.side === "plain") refreshHtml(d);
  if (d.project && config.rebuildOnSave && (state.side === "pages" || pagesWindows.has(d.project))) {
    clearTimeout(buildTimer);
    buildTimer = window.setTimeout(() => build(d.project!), explicit ? 0 : 800);
  }
};

const build = async (project: string) => {
  if (state.building.has(project)) return;
  state.building.add(project);
  renderSidePane();
  try {
    state.pages.set(project, await buildPages(project));
  } catch (e) {
    state.pages.set(project, { ok: false, log: String(e), urls: [] });
  }
  state.building.delete(project);
  renderSidePane();
};

const pagesWindows = new Set<string>();

/** Rebuilds the HTML of the project and shows the chapter with commands and expressions applied. */
const refreshHtml = async (d: Doc) => {
  if (!d.project) return;
  const r = await buildChapterHtml(d.project, d.path).catch((e) => ({ ok: false, html: "", log: String(e) }));
  const prev = state.html.get(d.path);
  state.html.set(d.path, r.ok ? { html: r.html, note: "" } : { html: prev?.html ?? null, note: `組めませんでした: ${r.log.split("\n")[0] ?? ""}` });
  if (state.doc?.path === d.path) renderSidePane();
};

// ---------------- toolbar, side pane, right, status ----------------
const renderTitle = () => {
  const t = toolbar.querySelector(".title");
  if (!t) return;
  const d = state.doc;
  t.innerHTML = d
    ? `${esc(state.titles.get(d.path)?.title ?? stem(d.path))}<small>${esc(d.workspace ? rel(d.workspace, d.path) : d.path)}</small>${d.text !== d.saved ? `<span class="dirty"> ●</span>` : ""}`
    : state.plotView
      ? `プロット<small>${esc(basename(state.plotView.project))}</small>`
      : "";
};

const sideKinds: Record<string, ("plain" | "pages")[]> = { gm: ["plain", "pages"], md: ["plain"], svg: ["plain"], mmd: ["plain"] };

const renderToolbar = () => {
  const d = state.doc;
  const kinds = d ? (sideKinds[d.kind] ?? []) : [];
  const canVertical = d && ["gm", "md", "txt"].includes(d.kind);
  toolbar.innerHTML = `
    <span class="iconbtn" data-tb="left" title="サイドバー">${icon("panel-left")}</span>
    <span class="title" data-tauri-drag-region></span>
    ${kinds.length ? `<span class="seg"><span data-side="none" class="${state.side === "none" ? "on" : ""}">原稿</span><span data-side="plain" class="${state.side === "plain" ? "on" : ""}">${d!.kind === "gm" ? "本文" : "プレビュー"}</span>${kinds.includes("pages") ? `<span data-side="pages" class="${state.side === "pages" ? "on" : ""}">ページ</span>` : ""}</span>` : ""}
    ${canVertical ? `<span class="seg"><span data-vert="1" class="${state.vertical ? "on" : ""}">縦</span><span data-vert="0" class="${state.vertical ? "" : "on"}">横</span></span>` : ""}
    ${d ? `<span class="iconbtn" data-tb="more" title="ほかの操作">${icon("more-horizontal")}</span>` : ""}
    <span class="iconbtn" data-tb="right" title="添付">${icon("paperclip")}</span>`;
  renderTitle();
};

toolbar.addEventListener("click", async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tb],[data-side],[data-vert]");
  if (!t) return;
  if (t.dataset.side) {
    state.side = t.dataset.side as typeof state.side;
    store.set("side", state.side);
    renderAll();
    if (state.side === "pages" && state.doc?.project && !state.pages.has(state.doc.project)) build(state.doc.project);
  }
  if (t.dataset.vert) {
    const v = t.dataset.vert === "1";
    if (v !== state.vertical && state.doc) {
      const d = state.doc;
      d.text = state.editor?.text() ?? d.text;
      state.vertical = v;
      store.set("vertical", v);
      state.editor?.destroy();
      state.editor = null;
      mountMain();
      renderAll();
    }
  }
  if (t.dataset.tb === "left") {
    state.showLeft = !state.showLeft;
    renderSide();
  }
  if (t.dataset.tb === "right") {
    state.showRight = !state.showRight;
    store.set("showRight", state.showRight);
    renderRight();
  }
  if (t.dataset.tb === "more") moreMenu(t);
});

const moreMenu = (anchor: HTMLElement) => {
  const d = state.doc!;
  menu(anchor, [
    ...(d.kind === "md"
      ? [{ label: "gm に変換", icon: icon("arrow-right-left", 14), run: () => convertMd(d) }]
      : []),
    ...(d.project
      ? [
          { label: "ページを組む（golem build + shem）", icon: icon("printer", 14), run: () => (state.side = "pages", store.set("side", "pages"), renderAll(), build(d.project!)) },
          { label: "ページを別ウィンドウで開く", icon: icon("external-link", 14), run: () => openPagesWindow(d.project!) },
          { label: "本文を別ウィンドウで開く", icon: icon("external-link", 14), run: () => openPlainWindow(d.path) },
          { label: "プロットを別ウィンドウで開く", icon: icon("table-2", 14), run: () => new WebviewWindow(`plot-${Date.now()}`, { url: `index.html?view=plot&project=${encodeURIComponent(d.project!)}`, title: `プロット — ${basename(d.project!)}`, width: 1300, height: 800 }) },
          { label: "今すぐコミット…", icon: icon("git-commit-horizontal", 14), run: () => commitNow() },
          { label: "golem fmt で整形", icon: icon("wand-sparkles", 14), run: () => runGolem(d, ["fmt", rel(d.project!, d.path)]) },
          { label: "golem check", icon: icon("circle-check", 14), run: () => runGolem(d, ["check"]) },
          { label: "共有ライブラリのフォントをコピー", icon: icon("type", 14), run: async () => toast((await copyFonts(d.project!)).join(", ") || "足りないフォントはありません") },
        ]
      : []),
    ...(registry.commands.length ? (["-"] as const) : []),
    ...registry.commands.map((c) => ({ label: c.label, icon: icon("puzzle", 14), run: () => void c.run(ctx.current()) })),
  ]);
};

const commitNow = async () => {
  const ws = currentWs();
  if (!ws) return;
  const msg = await ask("コミットメッセージ", `Update ${state.doc ? stem(state.doc.path) : basename(ws)}`);
  if (msg) toast(await commitAll(ws, msg));
};

const runGolem = async (d: Doc, args: string[]) => {
  await save(true);
  const out = await api.tool("golem", config.golemPath || undefined, d.project!, args);
  toast((out.stdout + out.stderr).trim().split("\n").slice(-6).join("\n") || (out.code === 0 ? "完了" : "失敗"));
  if (args[0] === "fmt" && out.code === 0) {
    const text = await api.readText(d.path);
    d.text = d.saved = text;
    state.editor?.destroy();
    mountMain();
  }
};

const convertMd = async (d: Doc) => {
  const to = `${dirname(d.path)}/${stem(d.path)}.gm`;
  if ((await api.exists(to)) && !(await ask(`${basename(to)} があります。上書きするなら OK`, "上書き"))) return;
  await api.writeText(to, mdToGm(state.editor?.text() ?? d.text));
  if (d.project) {
    const mp = `${d.project}/manifest.toml`;
    const r = rel(d.project, to);
    const m = await api.readText(mp);
    if (!manifestChapters(m).includes(r)) await api.writeText(mp, addChapter(m, r));
    projectChapters.delete(d.project);
  }
  await refreshTree();
  await openFile(to);
  toast("gm に変換しました");
};

const openPagesWindow = (project: string) => {
  pagesWindows.add(project);
  new WebviewWindow(`pages-${Date.now()}`, { url: `index.html?view=pages&project=${encodeURIComponent(project)}`, title: `ページ — ${basename(project)}`, width: 640, height: 900 });
  if (!state.pages.has(project)) build(project);
};

const openPlainWindow = (path: string) =>
  new WebviewWindow(`plain-${Date.now()}`, { url: `index.html?view=plain&path=${encodeURIComponent(path)}&project=${encodeURIComponent(state.doc?.project ?? "")}`, title: `本文 — ${basename(path)}`, width: 700, height: 900 });

let sideTimer = 0;
const scheduleSide = () => {
  clearTimeout(sideTimer);
  sideTimer = window.setTimeout(renderSidePane, 300);
};

const renderSidePane = () => {
  const d = state.doc;
  const kinds = d ? (sideKinds[d.kind] ?? []) : [];
  const show = !!d && state.side !== "none" && kinds.includes(state.side as "plain" | "pages");
  sidePane.hidden = !show;
  if (!show || !d) return;
  const text = state.editor?.text() ?? d.text;
  if (state.side === "pages" && d.project) {
    const busy = state.building.has(d.project);
    sideHead.innerHTML = `${icon("book-open", 13)}<span>ページ · ${esc(basename(d.project))}</span><span class="sp"></span><span class="iconbtn" data-build title="組む">${icon("refresh-cw", 14)}</span><span class="iconbtn" data-pagewin title="別ウィンドウ">${icon("external-link", 14)}</span>`;
    renderPages(inner(sideBody), state.pages.get(d.project) ?? null, busy);
  } else {
    sideHead.innerHTML = `${icon("eye", 13)}<span>${d.kind === "gm" ? "本文 · 命令と式を反映" : "プレビュー"}</span><span class="sp"></span>${d.kind === "gm" ? `<span class="iconbtn" data-plainwin title="別ウィンドウ">${icon("external-link", 14)}</span>` : ""}`;
    if (d.kind === "gm") {
      const h = state.html.get(d.path);
      if (!h && d.project) refreshHtml(d);
      renderEvaluated(inner(sideBody), h?.html ?? null, text, state.vertical, h?.note ?? (d.project ? "組んでいます…" : ""));
    }
    else if (d.kind === "md") renderMarkdown(inner(sideBody), text, state.vertical);
    else if (d.kind === "svg") renderSvg(inner(sideBody), text);
    else if (d.kind === "mmd") renderMermaid(inner(sideBody), text);
  }
};

sideHead.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-build],[data-pagewin],[data-plainwin]");
  const d = state.doc;
  if (!t || !d) return;
  if (t.dataset.build !== undefined && d.project) save(true).then(() => build(d.project!));
  if (t.dataset.pagewin !== undefined && d.project) openPagesWindow(d.project);
  if (t.dataset.plainwin !== undefined) openPlainWindow(d.path);
});

const renderRight = async () => {
  rightEl.classList.toggle("hidden", !state.showRight);
  if (!state.showRight) return;
  rightHead.innerHTML = (
    [
      ["attach", "paperclip", "目標、キーワード、ノート"],
      ["outline", "list", "アウトライン"],
      ["library", "library-big", "共有ライブラリ"],
    ] as const
  )
    .map(([k, i, t]) => `<span class="iconbtn ${state.right === k ? "on" : ""}" data-r="${k}" title="${t}">${icon(i)}</span>`)
    .join("");
  if (state.right === "attach") await mountAttachments(rightBody, ctx, state.plot, docCounts());
  else if (state.right === "outline") mountOutline(rightBody, ctx);
  else await mountLibrary(rightBody, ctx);
};

rightHead.addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>("[data-r]")?.dataset.r;
  if (!r) return;
  state.right = r as typeof state.right;
  store.set("right", r);
  renderRight();
});

const docCounts = () => {
  const d = state.doc;
  if (!d) return { chars: 0, words: 0, sheets: 0 };
  return stats(plainParagraphs(d.kind, state.editor?.text() ?? d.text), config.manuscript.cols, config.manuscript.rows);
};

let statusTimer = 0;
const scheduleStatus = () => {
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(renderStatus, 250);
};

const renderStatus = () => {
  const d = state.doc;
  const c = docCounts();
  const lsp = d?.project && (d.kind === "gm" || d.kind === "emet") ? lspFor(d.project).status() : null;
  let pos = "";
  const v = state.editor?.view;
  if (v) {
    const head = v.state.selection.main.head;
    const line = v.state.doc.lineAt(head);
    pos = `行 ${line.number}, 列 ${head - line.from + 1}`;
  }
  const extra = registry.status.map((f) => f(ctx.current())).filter(Boolean);
  statusEl.innerHTML = d
    ? `${lsp ? `<span class="${lsp === "ready" ? "ok" : lsp === "failed" ? "ng" : ""}">● LSP${lsp === "failed" ? " を起動できません" : lsp === "starting" ? " 起動中" : ""}</span>` : ""}
       ${state.diagnostics.errors + state.diagnostics.warnings ? `<span>${state.diagnostics.errors ? `エラー ${state.diagnostics.errors}` : ""} ${state.diagnostics.warnings ? `警告 ${state.diagnostics.warnings}` : ""}</span>` : ""}
       ${extra.map((x) => `<span>${esc(x)}</span>`).join("")}
       <span>${c.chars.toLocaleString()} 字</span><span>${c.words.toLocaleString()} 語</span><span>原稿用紙 ${c.sheets} 枚</span>
       ${d.project ? `<span>${charsOf(d)} 字 × ${d.grid.lines} 行${config.charsOverride ? "（上書き）" : ""}${d.grid.vertical ? " · 縦組み" : ""}</span>` : ""}
       ${pos ? `<span>${pos}</span>` : ""}`
    : "";
};

mainBody.addEventListener("keyup", scheduleStatus);
mainBody.addEventListener("mouseup", scheduleStatus);
mainBody.addEventListener("diagnostics", (e) => {
  const ds = (e as CustomEvent<{ severity: string }[]>).detail;
  state.diagnostics = { errors: ds.filter((x) => x.severity === "error").length, warnings: ds.filter((x) => x.severity === "warning").length };
  scheduleStatus();
});

const renderWelcome = () => {
  if (state.doc || state.plotView) return;
  state.editor = null;
  mainBody.innerHTML = `<div class="welcome" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%"><img src="/icon.svg" alt=""><div>${
    config.workspaces.length ? "左からシートを選んでください。" : `ワークスペース（Git のリポジトリ）を足してください。<br><span class="btn" id="welcome-add">フォルダを選ぶ</span>`
  }</div></div>`;
  mainBody.querySelector("#welcome-add")?.addEventListener("click", addWorkspace);
};

const renderAll = () => {
  renderToolbar();
  renderWelcome();
  renderSidePane();
  renderSide();
  renderRight();
  renderStatus();
};

// ---------------- events from other windows ----------------
listen<{ project: string }>("aleph:plot-saved", async (e) => {
  if (e.payload.project === state.plotProject) state.plot = await loadPlot(e.payload.project);
  metaCache.delete(e.payload.project);
  renderSide();
  renderRight();
});
listen<{ project: string }>("aleph:build-request", (e) => build(e.payload.project));
listen<{ project: string }>("aleph:pages-window", (e) => pagesWindows.add(e.payload.project));

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    state.left = "search";
    state.showLeft = true;
    renderSide();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    commitNow();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    openSettings(ctx);
  }
});
window.addEventListener("beforeunload", () => void save());

export const start = async () => {
  await loadPlugins(toast).catch(() => {});
  await refreshTree();
  renderAll();
  const last = store.get<string | null>("lastFile", null);
  if (last && (await api.exists(last))) openFile(last);
  setInterval(() => state.doc && store.set("lastFile", state.doc.path), 2000);
  autoCommit();
  setInterval(autoCommit, 60 * 60 * 1000);
};

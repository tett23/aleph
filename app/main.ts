// Entry of the main window: the settings, the store and the frame drawn from it.
import "./style.css";
import { api } from "./api.ts";
import { normalize, type Config } from "./config.ts";
import { applyTheme } from "./theme.ts";
import { createUiState, setUiState, uiState } from "./uistate.ts";
import { mountPreview } from "./preview/mount.ts";
import { startPreviewWindow } from "./preview/window.ts";
import { mountPlotFeature, startPlotWindow } from "./plot/mount.ts";
import { listen } from "@tauri-apps/api/event";
import type { Ctx } from "./ctx.ts";
import { createStore, initialState, readPreviewMode, shownDoc, type State } from "./store.ts";
import { confirmDialog, toast } from "./ui/dom.ts";
import { notify } from "./ui/notices.ts";
import { finishWrite, mayWrite, mountWatch } from "./watchmount.ts";
import { guardLinks } from "./links.ts";
import { item } from "./ui/settings.ts";
import { debugBuild } from "./build.ts";
import { mountShell, renderRibbon, renderRightSidebarHead, renderStatus, renderToolbar, renderWorkspaceBar, type Shell } from "./ui/shell.ts";
import { openPaths, saveSheets } from "./docs.ts";
import { mountTree, reloadTree, treeReloaded } from "./ui/tree.ts";
import { readTitleOnSave } from "./savedtitles.ts";
import { git, gitOk, mountTools } from "./tools.ts";
import { mountAssistantSettings } from "./assistant/models.ts";
import { startRecorder } from "./ed/recorder.ts";
import { mountEditors } from "./editor/host.ts";
import { mountJson } from "./jsonfeature.ts";
import { mountCommands } from "./palette.ts";
import { cleanKeyBindings, mountKeybind } from "./keybind.ts";
import { mountBookmarks } from "./bookmarkpanel.ts";
import { mountQuickOpen } from "./quickopenmount.ts";
import { mountWikilinks } from "./wikilinkmount.ts";
import { mountKeywords } from "./keywordpanel.ts";
import { mountProofread } from "./proofreadmount.ts";
import { mountPasteImage } from "./pasteimagemount.ts";
import { mountTrash } from "./trashpanel.ts";
import { mountRecent, reopenLast } from "./recentpanel.ts";
import { keepTabs, restoreTabs } from "./tabsui.ts";
import { mountLsp } from "./lsp/mount.ts";
import { mountAttach } from "./attach.ts";
import { mountLibrary } from "./libpanel.ts";
import { mountImageDrag } from "./imagedrag.ts";
import { mountDragOut } from "./dragout.ts";
import { mountDiagnostics } from "./diag/mount.ts";
import { mountSearch } from "./searchpanel.ts";
import { mountBottomPanel } from "./problemsmount.ts";
import { mountAssistant } from "./assistant/mount.ts";
import { mountProjectBuild } from "./projectbuildmount.ts";
import { mountMdConvert } from "./mdconvert.ts";
import { mountPlugins } from "./plugins/mount.ts";
import { currentBranch, mountGit } from "./gitpanel.ts";
import { mountDiffTab } from "./difftab/mount.ts";
import { rel } from "./path.ts";

/** The parts of the state kept between launches, in config.json's `ui` (docs/adr/0004). */
const KEPT = ["sidebarPanel", "showSidebar", "rightSidebarPanel", "showRightSidebar", "previewMode", "vertical", "expanded", "workspace"] as const;
const keep = (s: State) => uiState().merge(Object.fromEntries(KEPT.map((k) => [k, s[k]])));
// previewMode other than "plain" and "pages" ("none" included) is read as "plain" (docs/adr/0087)
const kept = (ui: Record<string, unknown>): Partial<State> => ({ ...Object.fromEntries(KEPT.filter((k) => k in ui).map((k) => [k, ui[k]])), previewMode: readPreviewMode(ui.previewMode) });

const start = async () => {
  const config = normalize(JSON.parse(await api.configLoad().catch(() => "{}")));
  applyTheme(config);
  // the kept state is written a moment after it changes, and only when it changed
  let uiTimer = 0;
  let uiLast = JSON.stringify(config.ui);
  setUiState(
    createUiState(config.ui, (ui) => {
      config.ui = ui;
      clearTimeout(uiTimer);
      uiTimer = window.setTimeout(() => {
        const now = JSON.stringify(ui);
        if (now === uiLast) return;
        uiLast = now;
        void api.configSave(JSON.stringify(config, null, 2));
      }, 500);
    }),
  );
  // the preview and plot windows send their part (their zooms)
  void listen<Record<string, unknown>>("aleph:ui", (e) => uiState().merge(e.payload));
  const store = createStore({ ...initialState(), ...kept(config.ui) });
  store.dispatch({ type: "workspaces", workspaces: config.workspaces });

  const titles = new Map<string, string>();
  // the tree reads titles into ctx.titles; the toolbar shares the same map
  let shell: Shell;
  const ctx: Ctx = {
    store,
    config,
    saveConfig: async () => {
      Object.assign(config, normalize(config));
      await api.configSave(JSON.stringify(config, null, 2));
      applyTheme(config);
      store.dispatch({ type: "workspaces", workspaces: config.workspaces });
    },
    toast,
    notify,
    sidebar: {},
    rightSidebar: {},
    status: [],
    statusActions: {},
    gitChanged: [],
    settings: [],
    commands: [],
    findSheets: null,
    view: {},
    open: (paths, at, opts) => openPaths(ctx, paths, at, opts),
    openers: [],
    pendingAt: null,
    decor: [],
    titles,
    debug: await debugBuild(),
    projects: [],
    beforeRename: [],
    onRename: [],
    onNewProject: [],
    editors: new Map(),
    editorPlugins: [],
    kindViews: {},
    save: (paths, opts) => saveSheets(ctx, paths, opts, async (doc, text) => {
      if (!(await mayWrite(ctx, doc, !!opts?.explicit))) return false;
      await api.writeText(doc.path, text);
      finishWrite(doc.path);
      return true;
    }),
    baseText: async (d) => {
      // no git: nothing to compare with, so no marks (docs/adr/0060)
      if (!(await gitOk())) return false;
      if (!d.workspace) return null;
      const out = await git(ctx, d.workspace, ["show", `HEAD:${rel(d.workspace, d.path)}`]).catch(() => null);
      return out && out.code === 0 ? out.stdout : null;
    },
    // before the frame is drawn there is nothing to redraw (the daily commit may finish first)
    refresh: (what = ["sidebar", "rightSidebar", "status", "previewTab"]) => void (shell && draw(store.get(), store.get(), what)),
  };

  ctx.settings.push({
    id: "general",
    label: "一般",
    group: "オプション",
    render: (c) =>
      item(
        "外観",
        "OS に合わせるか、固定するか",
        (["light", "dark", "auto"] as const)
          .map((t) => `<span class="btn ${c.config.theme === t ? "pri" : ""}" data-theme="${t}">${{ light: "ライト", dark: "ダーク", auto: "自動" }[t]}</span>`)
          .join(""),
      ),
    onClick: async (el, c) => {
      const t = el.closest<HTMLElement>("[data-theme]")?.dataset.theme;
      if (!t) return false;
      c.config.theme = t as Config["theme"];
      await c.saveConfig();
      return true;
    },
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(config));

  let cleanupEditorArea: (() => void) | void;
  const draw = (s: State, prev: State | null, what: string[] = []) => {
    const changed = (k: keyof State) => !prev || prev[k] !== s[k];
    renderRibbon(document.body, s);
    shell.sidebarEl.classList.toggle("hidden", !s.showSidebar);
    if (changed("workspace")) renderWorkspaceBar(document.body, s, currentBranch());
    renderToolbar(document.body, s, ctx, titles);
    renderRightSidebarHead(shell, s);
    if (what.includes("sidebar") || changed("sidebarPanel") || changed("workspace") || changed("showSidebar") || changed("expanded") || changed("selected") || changed("open") && !prev)
      void ctx.sidebar[s.sidebarPanel]?.render(shell.sidebarBody, ctx);
    if (what.includes("rightSidebar") || changed("rightSidebarPanel") || changed("focus") || changed("open") || changed("followed") || changed("showRightSidebar"))
      if (s.showRightSidebar) void ctx.rightSidebar[s.rightSidebarPanel]?.render(shell.rightSidebarBody, ctx);
    // the panes and tabs follow the store themselves (docs/adr/0024); made again only when asked
    if (what.includes("editorArea") || !prev) {
      cleanupEditorArea?.();
      shell.editorAreaBody.innerHTML = "";
      cleanupEditorArea = ctx.view.editorArea?.(shell.editorAreaBody, ctx);
    }
    // the preview tab, drawn only while it is shown in its pane (docs/adr/0087); the panes draw it when it is selected
    if (what.includes("previewTab") || changed("previewMode") || changed("panes") || changed("pane") || changed("followed") || changed("vertical")) {
      const tab = document.querySelector<HTMLElement>(".tabview.preview-tab:not([hidden])");
      if (tab) ctx.view.previewTab?.(tab.querySelector<HTMLElement>(".phead")!, tab.querySelector<HTMLElement>(".pbody")!, ctx);
    }
    if (what.includes("bottomPanel") || changed("focus") || changed("open") || !prev) ctx.view.bottomPanel?.(shell.bottomPanelEl, ctx);
    renderStatus(shell, s, ctx);
    keep(s);
  };

  mountTree(ctx);
  mountTools(ctx);
  mountAssistantSettings(ctx);
  mountEditors(ctx);
  mountBottomPanel(ctx); // before the LSP: the counts sit left of its state in the status bar
  mountAssistant(ctx);
  mountLsp(ctx);
  mountJson(ctx);
  mountDiagnostics(ctx); // lint and preflight sit beside the LSP in the status bar
  mountProjectBuild(ctx); // after lint and preflight: its status item sits right of them (docs/adr/0058)
  mountPreview(ctx);
  mountGit(ctx);
  mountDiffTab(ctx);
  mountWatch(ctx);
  mountPlotFeature(ctx);
  mountAttach(ctx);
  mountLibrary(ctx);
  mountImageDrag(ctx);
  mountDragOut(ctx); // after the image drag: a drag that leaves the window ends that one first (docs/adr/0077)
  mountSearch(ctx);
  mountMdConvert(ctx);
  mountBookmarks(ctx);
  mountRecent(ctx);
  mountQuickOpen(ctx);
  mountWikilinks(ctx);
  mountKeywords(ctx);
  mountProofread(ctx);
  mountPasteImage(ctx);
  mountTrash(ctx);
  // last: the built-in commands, the settings sections as commands, and the window's keys (docs/adr/0023)
  mountKeybind(ctx);
  mountCommands(ctx);
  cleanKeyBindings(ctx);
  // a file to open, sent by another window (the plot window)
  void listen<{ path: string }>("aleph:open", (e) => void ctx.open([e.payload.path]));
  await reloadTree(ctx);
  store.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace) void reloadTree(ctx).then(() => ctx.refresh(["sidebar"]));
  });
  // a saved sheet's title is read again from what was saved; drawn again only when it changed (docs/adr/0079)
  store.subscribe((s, prev, a) =>
    void readTitleOnSave(s, prev, a, ctx.titles, {
      redraw: () => ctx.refresh(["sidebar"]),
      reloaded: async () => {
        for (const f of treeReloaded) await f(ctx);
      },
    }),
  );

  shell = mountShell(document.getElementById("app")!, ctx, () => {
    const s = store.get();
    const p = s.open[0]?.project ?? s.plot ?? shownDoc(s)?.project;
    if (p) store.dispatch({ type: "plot", project: p });
    else toast("Golem のプロジェクトのシートを開いてから押してください");
  });
  store.subscribe((s, prev) => draw(s, prev));
  draw(store.get(), null);
  // the tabs of the last launch, or else the newest recent sheet
  void restoreTabs(ctx).then((done) => (done ? undefined : reopenLast(ctx)));
  keepTabs(ctx);
  // plugins load last: a slow or failing one does not hold up the window
  void mountPlugins(ctx);
};

// links never move a window; http(s) opens in the browser after asking (docs/adr/0044)
guardLinks(api.openUrl, confirmDialog);
const view = new URLSearchParams(location.search).get("view");
if (view === "plot") void startPlotWindow(new URLSearchParams(location.search).get("project") ?? "");
else if (view === "pages" || view === "plain") void startPreviewWindow(view, new URLSearchParams(location.search).get("project") ?? "");
else if (view === "imelog") startRecorder(document.getElementById("app")!);
else void start();

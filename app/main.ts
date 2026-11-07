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
import { createStore, initialState, type State } from "./store.ts";
import { toast } from "./ui/dom.ts";
import { item } from "./ui/settings.ts";
import { mountShell, renderRibbon, renderRightHead, renderStatus, renderToolbar, renderWsbar, type Shell } from "./ui/shell.ts";
import { openPaths } from "./docs.ts";
import { mountTree, reloadTree } from "./ui/tree.ts";
import { git, mountTools } from "./tools.ts";
import { startRecorder } from "./ed/recorder.ts";
import { mountEditors } from "./editor/host.ts";
import { mountJson } from "./jsonfeature.ts";
import { mountCommands } from "./palette.ts";
import { mountBookmarks } from "./bookmarkpanel.ts";
import { mountRecent, reopenLast } from "./recentpanel.ts";
import { mountLsp } from "./lsp/mount.ts";
import { mountAttach } from "./attach.ts";
import { mountLibrary } from "./libpanel.ts";
import { mountImageDrag } from "./imagedrag.ts";
import { mountDiagnostics } from "./diag/mount.ts";
import { mountSearch } from "./searchpanel.ts";
import { mountMdConvert } from "./mdconvert.ts";
import { mountPlugins } from "./plugins/mount.ts";
import { currentBranch, mountGit } from "./gitpanel.ts";
import { rel } from "./path.ts";

/** The parts of the state kept between launches, in config.json's `ui` (docs/adr/0004). */
const KEPT = ["left", "showLeft", "right", "showRight", "side", "vertical", "expanded", "workspace"] as const;
const keep = (s: State) => uiState().merge(Object.fromEntries(KEPT.map((k) => [k, s[k]])));
const kept = (ui: Record<string, unknown>): Partial<State> => Object.fromEntries(KEPT.filter((k) => k in ui).map((k) => [k, ui[k]]));

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
    left: {},
    right: {},
    status: [],
    statusActions: {},
    settings: [],
    commands: [],
    findSheets: null,
    view: {},
    open: (paths, at) => openPaths(ctx, paths, at),
    openers: [],
    pendingAt: null,
    decor: [],
    titles,
    projects: [],
    onRename: [],
    onNewProject: [],
    editors: new Map(),
    editorPlugins: [],
    kindViews: {},
    save: async (paths, opts) => {
      // the basic save: write the sheets with changes (docs/adr/0011 adds autosave and the rest)
      for (const d of store.get().open) {
        if (paths && !paths.includes(d.path)) continue;
        const text = ctx.editors.get(d.path)?.text() ?? d.text;
        if (text === d.saved && !opts?.explicit) continue;
        await api.writeText(d.path, text);
        store.dispatch({ type: "saved", path: d.path, text });
      }
    },
    baseText: async (d) => {
      if (!d.workspace) return null;
      const out = await git(ctx, d.workspace, ["show", `HEAD:${rel(d.workspace, d.path)}`]).catch(() => null);
      return out && out.code === 0 ? out.stdout : null;
    },
    // before the frame is drawn there is nothing to redraw (the daily commit may finish first)
    refresh: (what = ["left", "right", "status", "side"]) => void (shell && draw(store.get(), store.get(), what)),
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

  let cleanupMain: (() => void) | void;
  const draw = (s: State, prev: State | null, what: string[] = []) => {
    const changed = (k: keyof State) => !prev || prev[k] !== s[k];
    renderRibbon(document.body, s);
    shell.sideEl.classList.toggle("hidden", !s.showLeft);
    if (changed("workspace")) renderWsbar(document.body, s, currentBranch());
    renderToolbar(document.body, s, ctx, titles);
    renderRightHead(shell, s);
    if (what.includes("left") || changed("left") || changed("workspace") || changed("showLeft") || changed("expanded") || changed("selected") || changed("open") && !prev)
      void ctx.left[s.left]?.render(shell.leftBody, ctx);
    if (what.includes("right") || changed("right") || changed("focus") || changed("open") || changed("showRight"))
      if (s.showRight) void ctx.right[s.right]?.render(shell.rightBody, ctx);
    if (what.includes("main") || changed("plot") || prev?.open.map((d) => d.path).join() !== s.open.map((d) => d.path).join()) {
      cleanupMain?.();
      shell.mainBody.innerHTML = "";
      if (!s.open.length && !s.plot)
        shell.mainBody.innerHTML = `<div class="welcome"><img src="/icon.svg" alt=""><div>${
          s.workspaces.length ? "左からシートを選んでください。" : "設定の「ワークスペース」で、Git のリポジトリなどのフォルダを足してください。"
        }</div></div>`;
      else cleanupMain = ctx.view.main?.(shell.mainBody, ctx);
    }
    if (what.includes("side") || changed("side") || changed("open") || changed("focus") || changed("vertical")) ctx.view.side?.(shell.sideHead, shell.sideBody, ctx);
    if (!ctx.view.side) shell.sidePane.hidden = true;
    renderStatus(shell, s, ctx);
    keep(s);
  };

  mountTree(ctx);
  mountTools(ctx);
  mountEditors(ctx);
  mountLsp(ctx);
  mountJson(ctx);
  mountDiagnostics(ctx); // lint and preflight sit beside the LSP in the status bar
  mountPreview(ctx);
  mountGit(ctx);
  mountPlotFeature(ctx);
  mountAttach(ctx);
  mountLibrary(ctx);
  mountImageDrag(ctx);
  mountSearch(ctx);
  mountMdConvert(ctx);
  mountBookmarks(ctx);
  mountRecent(ctx);
  // last: the built-in commands, the settings sections as commands, and the window's keys (docs/adr/0023)
  mountCommands(ctx);
  // a file to open, sent by another window (the plot window)
  void listen<{ path: string }>("aleph:open", (e) => void ctx.open([e.payload.path]));
  await reloadTree(ctx);
  store.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace) void reloadTree(ctx).then(() => ctx.refresh(["left"]));
  });

  shell = mountShell(document.getElementById("app")!, ctx, () => {
    const s = store.get();
    const p = s.open[0]?.project ?? s.plot;
    if (p) store.dispatch({ type: "plot", project: p });
    else toast("Golem のプロジェクトのシートを開いてから押してください");
  });
  store.subscribe((s, prev) => draw(s, prev));
  draw(store.get(), null);
  // the sheet open when Aleph was last closed (docs/adr/0026)
  void reopenLast(ctx);
  // plugins load last: a slow or failing one does not hold up the window
  void mountPlugins(ctx);
};

const view = new URLSearchParams(location.search).get("view");
if (view === "plot") void startPlotWindow(new URLSearchParams(location.search).get("project") ?? "");
else if (view === "pages" || view === "plain") void startPreviewWindow(view, new URLSearchParams(location.search).get("project") ?? "");
else if (view === "imelog") startRecorder(document.getElementById("app")!);
else void start();

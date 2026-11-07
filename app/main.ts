// Entry of the main window: the settings, the store and the frame drawn from it.
import "./style.css";
import { api } from "./api.ts";
import { isDark, normalize, type Config } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import { createStore, initialState, type State } from "./store.ts";
import { toast } from "./ui/dom.ts";
import { item } from "./ui/settings.ts";
import { mountShell, renderRibbon, renderRightHead, renderStatus, renderToolbar, renderWsbar, type Shell } from "./ui/shell.ts";

/** The parts of the state worth keeping between launches, per viewer (localStorage may be unavailable). */
const KEPT = ["left", "showLeft", "right", "showRight", "side", "vertical", "expanded", "workspace"] as const;
const keep = (s: State) => {
  try {
    localStorage.setItem("ui", JSON.stringify(Object.fromEntries(KEPT.map((k) => [k, s[k]]))));
  } catch {
    /* not kept */
  }
};
const kept = (): Partial<State> => {
  try {
    return JSON.parse(localStorage.getItem("ui") ?? "{}");
  } catch {
    return {};
  }
};

export const applyTheme = (c: Config) => {
  const dark = isDark(c.theme, matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("theme-dark", dark);
  const st = document.body.style;
  st.setProperty("--lh", String(c.lineHeight));
  st.setProperty("--fs-body", `${c.fontSize}px`);
  st.setProperty("--fs-code", `${c.codeFontSize}px`);
};

const start = async () => {
  const config = normalize(JSON.parse(await api.configLoad().catch(() => "{}")));
  applyTheme(config);
  const store = createStore({ ...initialState(), ...kept() });
  store.dispatch({ type: "workspaces", workspaces: config.workspaces });

  const titles = new Map<string, string>();
  let shell: Shell;
  let branch = "";
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
    settings: [],
    commands: [],
    view: {},
    refresh: (what = ["left", "right", "status", "side"]) => draw(store.get(), null, what),
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
    if (changed("workspace")) renderWsbar(document.body, s, branch);
    renderToolbar(document.body, s, ctx, titles);
    renderRightHead(shell, s);
    if (what.includes("left") || changed("left") || changed("workspace") || changed("showLeft") || changed("expanded") || changed("selected") || changed("open") && !prev)
      void ctx.left[s.left]?.render(shell.leftBody, ctx);
    if (what.includes("right") || changed("right") || changed("focus") || changed("open") || changed("showRight"))
      if (s.showRight) void ctx.right[s.right]?.render(shell.rightBody, ctx);
    if (what.includes("main") || changed("plot") || prev?.open.map((d) => d.path).join() !== s.open.map((d) => d.path).join() || changed("vertical")) {
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

  shell = mountShell(document.getElementById("app")!, ctx, () => {
    const s = store.get();
    const p = s.open[0]?.project ?? s.plot;
    if (p) store.dispatch({ type: "plot", project: p });
    else toast("Golem のプロジェクトのシートを開いてから押してください");
  });
  store.subscribe((s, prev) => draw(s, prev));
  draw(store.get(), null);
};

void start();

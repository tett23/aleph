// The screen's frame, drawn from the state (docs/adr/0005): ribbon, left sidebar,
// toolbar, editor and preview panes, right panel, status bar.
import type { Ctx } from "../ctx.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { basename, rel, stem } from "../path.ts";
import { dirty, focused, type LeftPanel, type RightPanel, type State } from "../store.ts";
import { canVertical, effectiveSide, previewLabel, previewsFor } from "../toolbar.ts";
import { keyLabel, menuCommands } from "../commands.ts";
import { runCommand } from "../palette.ts";
import { menu, onPress } from "./dom.ts";
import { openSettings } from "./settings.ts";

const RIBBON: [LeftPanel | "plot", string, string][] = [
  ["files", "files", "ファイル"],
  ["search", "search", "検索"],
  ["git", "git-branch", "Git"],
  ["plot", "table-2", "プロット"],
  ["diagnostics", "list-checks", "診断（check、lint、preflight）"],
  ["library", "library-big", "共有ライブラリ（すべてのプロジェクト）"],
];

const RIGHT: [RightPanel, string, string][] = [
  ["attach", "paperclip", "添付（目標、キーワード、書くこと、ノート）"],
  ["outline", "list", "アウトライン"],
  ["library", "library-big", "このプロジェクトの共有ライブラリ"],
];

export type Shell = {
  sideEl: HTMLElement;
  leftBody: HTMLElement;
  mainBody: HTMLElement;
  sidePane: HTMLElement;
  sideHead: HTMLElement;
  sideBody: HTMLElement;
  rightEl: HTMLElement;
  rightBody: HTMLElement;
  statusEl: HTMLElement;
};

export const mountShell = (root: HTMLElement, ctx: Ctx, onPlot: () => void): Shell => {
  root.innerHTML = `
    <div class="ribbon" data-tauri-drag-region>
      ${RIBBON.map(([k, i, t]) => `<span class="iconbtn" data-rib="${k}" title="${t}">${icon(i)}</span>`).join("")}
      <span class="grow" data-tauri-drag-region></span>
      <span class="iconbtn" data-settings title="設定">${icon("settings")}</span>
    </div>
    <div class="side">
      <div class="wsbar" data-tauri-drag-region><span class="name" data-wsmenu></span><span class="br"></span></div>
      <div class="leftbody"></div>
    </div>
    <div class="center">
      <div class="toolbar" data-tauri-drag-region></div>
      <div class="split">
        <div class="pane main-pane"><div class="pbody"></div></div>
        <div class="pane side-pane" hidden><div class="phead"></div><div class="pbody"></div></div>
      </div>
      <div class="status"></div>
    </div>
    <div class="right"><div class="rhead" data-tauri-drag-region></div><div class="rbody"></div></div>`;
  const $ = (s: string) => root.querySelector<HTMLElement>(s)!;
  const shell: Shell = {
    sideEl: $(".side"),
    leftBody: $(".leftbody"),
    mainBody: $(".main-pane .pbody"),
    sidePane: $(".side-pane"),
    sideHead: $(".side-pane .phead"),
    sideBody: $(".side-pane .pbody"),
    rightEl: $(".right"),
    rightBody: $(".right .rbody"),
    statusEl: $(".status"),
  };
  const toolbar = $(".toolbar");

  onPress($(".ribbon"), (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-rib],[data-settings]");
    if (!t) return;
    if (t.dataset.settings !== undefined) return void openSettings(ctx);
    if (t.dataset.rib === "plot") return onPlot();
    ctx.store.dispatch({ type: "left", panel: t.dataset.rib as LeftPanel });
  });

  onPress($(".wsbar"), (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-wsmenu]");
    if (!t) return;
    const s = ctx.store.get();
    menu(t, [
      ...s.workspaces.map((w) => ({ label: basename(w), icon: icon(w === s.workspace ? "check" : "dot", 14), run: () => ctx.store.dispatch({ type: "workspace", path: w }) })),
      "-",
      { label: "ワークスペースを足す…", icon: icon("plus", 14), run: () => void openSettings(ctx, "workspaces") },
    ]);
  });

  onPress(toolbar, (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tb],[data-side],[data-vert]");
    if (!t) return;
    const s = ctx.store.get();
    if (t.dataset.side) ctx.store.dispatch({ type: "side", side: t.dataset.side as State["side"] });
    if (t.dataset.vert) ctx.store.dispatch({ type: "vertical", on: t.dataset.vert === "1" });
    if (t.dataset.tb === "left") ctx.store.dispatch({ type: "left", panel: s.left });
    if (t.dataset.tb === "right") ctx.store.dispatch({ type: "toggleRight" });
    if (t.dataset.tb === "more")
      menu(
        t,
        menuCommands(ctx.commands, s).map((c) => ({ label: c.label, icon: c.icon ? icon(c.icon, 14) : "", hint: c.keys?.[0] ? keyLabel(c.keys[0]) : undefined, run: () => void runCommand(ctx, c) })),
      );
  });

  onPress($(".rhead"), (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>("[data-r]")?.dataset.r;
    if (r) ctx.store.dispatch({ type: "right", panel: r as RightPanel });
  });

  return shell;
};

export const renderRibbon = (root: HTMLElement, s: State) =>
  root.querySelectorAll<HTMLElement>("[data-rib]").forEach((b) => b.classList.toggle("on", s.showLeft && b.dataset.rib === s.left || b.dataset.rib === "plot" && s.plot !== null));

export const renderWsbar = (root: HTMLElement, s: State, branch: string) => {
  const name = root.querySelector<HTMLElement>(".wsbar .name")!;
  name.innerHTML = `${icon("chevrons-up-down", 13)}<span>${esc(s.workspace ? basename(s.workspace) : "ワークスペースなし")}</span>`;
  root.querySelector<HTMLElement>(".wsbar .br")!.innerHTML = branch ? `${icon("git-branch", 12)}<span>${esc(branch)}</span>` : "";
};

/** The title of the focused sheet, the plot, or nothing. */
export const titleHtml = (s: State, titles: Map<string, string>) => {
  const d = focused(s);
  if (d) {
    const others = s.open.length > 1 ? ` <small>ほか ${s.open.length - 1} 章</small>` : "";
    return `${esc(titles.get(d.path) ?? stem(d.path))}<small>${esc(d.workspace ? rel(d.workspace, d.path) : d.path)}</small>${others}${s.open.some(dirty) ? `<span class="dirty"> ●</span>` : ""}`;
  }
  return s.plot ? `プロット<small>${esc(basename(s.plot))}</small>` : "";
};

export const renderToolbar = (root: HTMLElement, s: State, ctx: Ctx, titles: Map<string, string>) => {
  const toolbar = root.querySelector<HTMLElement>(".toolbar")!;
  const d = focused(s);
  const sides = d ? previewsFor(d.kind) : [];
  const side = d ? effectiveSide(d.kind, s.side) : "none";
  // the editor's switch on the left, the preview's on the right (docs/adr/0005)
  toolbar.innerHTML = `
    <span class="iconbtn" data-tb="left" title="サイドバー">${icon("panel-left")}</span>
    ${s.open.length && s.open.every((x) => canVertical(x.kind)) ? `<span class="seg"><span data-vert="1" class="${s.vertical ? "on" : ""}">縦</span><span data-vert="0" class="${s.vertical ? "" : "on"}">横</span></span>` : ""}
    <span class="title" data-tauri-drag-region>${titleHtml(s, titles)}</span>
    ${sides.length ? `<span class="seg">${sides.map((k) => `<span data-side="${k}" class="${side === k ? "on" : ""}">${previewLabel(d!.kind, k)}</span>`).join("")}</span>` : ""}
    ${menuCommands(ctx.commands, s).length ? `<span class="iconbtn" data-tb="more" title="ほかの操作">${icon("more-horizontal")}</span>` : ""}
    <span class="iconbtn ${s.showRight ? "on" : ""}" data-tb="right" title="右のパネル">${icon("panel-right")}</span>`;
};

export const renderRightHead = (shell: Shell, s: State) => {
  shell.rightEl.classList.toggle("hidden", !s.showRight);
  shell.rightEl.querySelector<HTMLElement>(".rhead")!.innerHTML = RIGHT.map(
    ([k, i, t]) => `<span class="iconbtn ${s.right === k ? "on" : ""}" data-r="${k}" title="${t}">${icon(i)}</span>`,
  ).join("");
  shell.rightBody.className = `rbody ${s.right}`;
};

export const renderStatus = (shell: Shell, s: State, ctx: Ctx) => {
  const parts = ctx.status.map((f) => f(s, ctx)).filter(Boolean);
  shell.statusEl.innerHTML = parts.join("");
  shell.statusEl.onclick = (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("[data-status]")?.dataset.status;
    if (k) ctx.statusActions[k]?.(ctx);
  };
};

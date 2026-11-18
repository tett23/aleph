// The screen's frame, drawn from the state (docs/adr/0005): ribbon, sidebar, toolbar,
// editor area, bottom panel, status bar and right sidebar (names: docs/glossary.md).
// The preview is a tab of the editor area's panes (docs/adr/0087).
import { devBadge } from "../build.ts";
import type { Ctx } from "../ctx.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { basename, rel, stem } from "../path.ts";
import { diffSelected, dirty, previewAvailable, shown, type SidebarPanelId, type RightSidebarPanelId, type State } from "../store.ts";
import { canVertical } from "../toolbar.ts";
import { menuCommands } from "../commands.ts";
import { hintOf } from "../keybind.ts";
import { runCommand } from "../palette.ts";
import { menu, onPress } from "./dom.ts";
import { openSettingsDialog } from "./settings.ts";

const RIBBON: [SidebarPanelId | "plot" | "diff", string, string][] = [
  ["files", "files", "ファイル"],
  ["bookmarks", "map-pin", "ブックマークと最近開いたシート"],
  ["keywords", "tag", "キーワード"],
  ["search", "search", "検索"],
  ["git", "git-branch", "Git"],
  ["diff", "git-compare", "差分"],
  ["plot", "table-2", "プロット"],
  ["diagnostics", "list-checks", "診断（check、lint、preflight）"],
  ["library", "library-big", "共有ライブラリ（すべてのプロジェクト）"],
  ["trash", "trash-2", "ゴミ箱"],
];

const RIGHT_SIDEBAR: [RightSidebarPanelId, string, string][] = [
  ["attach", "paperclip", "添付（目標、キーワード、書くこと、ノート）"],
  ["outline", "list", "アウトライン"],
  ["links", "link", "リンク（このシートを指すリンク、このシートから出るリンク）"],
  ["library", "library-big", "このプロジェクトの共有ライブラリ"],
];

export type Shell = {
  sidebarEl: HTMLElement;
  sidebarBody: HTMLElement;
  editorAreaBody: HTMLElement;
  rightSidebarEl: HTMLElement;
  rightSidebarBody: HTMLElement;
  statusBarEl: HTMLElement;
  /** The bottom panel under the editor area (docs/adr/0055). */
  bottomPanelEl: HTMLElement;
};

export const mountShell = (root: HTMLElement, ctx: Ctx, onPlot: () => void): Shell => {
  root.innerHTML = `
    <div class="ribbon" data-tauri-drag-region>
      ${RIBBON.map(([k, i, t]) => `<span class="iconbtn" data-rib="${k}" title="${t}">${icon(i)}</span>`).join("")}
      <span class="grow" data-tauri-drag-region></span>
      <span class="iconbtn" data-settings title="設定">${icon("settings")}</span>
    </div>
    <div class="sidebar">
      <div class="workspace-bar" data-tauri-drag-region><span class="name" data-wsmenu></span><span class="br"></span></div>
      <div class="leftbody"></div>
    </div>
    <div class="center">
      <div class="toolbar" data-tauri-drag-region></div>
      <div class="split">
        <div class="editor-area"><div class="pbody"></div></div>
      </div>
      <div class="bottom-panel" hidden></div>
      <div class="status-bar"></div>
    </div>
    <div class="right-sidebar"><div class="rhead" data-tauri-drag-region></div><div class="rbody"></div></div>`;
  const $ = (s: string) => root.querySelector<HTMLElement>(s)!;
  const shell: Shell = {
    sidebarEl: $(".sidebar"),
    sidebarBody: $(".leftbody"),
    editorAreaBody: $(".editor-area .pbody"),
    rightSidebarEl: $(".right-sidebar"),
    rightSidebarBody: $(".right-sidebar .rbody"),
    statusBarEl: $(".status-bar"),
    bottomPanelEl: $(".bottom-panel"),
  };
  const toolbar = $(".toolbar");

  onPress($(".ribbon"), (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-rib],[data-settings]");
    if (!t) return;
    if (t.dataset.settings !== undefined) return void openSettingsDialog(ctx);
    if (t.dataset.rib === "plot") return onPlot();
    // the diff tab, through its command (docs/adr/0088)
    if (t.dataset.rib === "diff") {
      const c = ctx.commands.find((x) => x.id === "view.diff");
      if (c && c.when(ctx.store.get())) void runCommand(ctx, c);
      return;
    }
    ctx.store.dispatch({ type: "sidebarPanel", panel: t.dataset.rib as SidebarPanelId });
  });

  onPress($(".workspace-bar"), (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-wsmenu]");
    if (!t) return;
    const s = ctx.store.get();
    menu(t, [
      ...s.workspaces.map((w) => ({ label: basename(w), icon: icon(w === s.workspace ? "check" : "dot", 14), run: () => ctx.store.dispatch({ type: "workspace", path: w }) })),
      "-",
      { label: "ワークスペースを足す…", icon: icon("plus", 14), run: () => void openSettingsDialog(ctx, "workspaces") },
    ]);
  });

  onPress(toolbar, (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-toolbar],[data-vert]");
    if (!t) return;
    const s = ctx.store.get();
    // the preview tab, shown without changing previewMode (docs/adr/0087)
    if (t.dataset.toolbar === "preview") ctx.store.dispatch({ type: "showPreview" });
    if (t.dataset.vert) ctx.store.dispatch({ type: "vertical", on: t.dataset.vert === "1" });
    if (t.dataset.toolbar === "sidebar") ctx.store.dispatch({ type: "sidebarPanel", panel: s.sidebarPanel });
    if (t.dataset.toolbar === "right-sidebar") ctx.store.dispatch({ type: "toggleRightSidebar" });
    // the build popup (docs/adr/0058)
    if (t.dataset.toolbar === "build") ctx.statusActions.buildOptions?.(ctx);
    if (t.dataset.toolbar === "more-actions")
      menu(
        t,
        menuCommands(ctx.commands, s).map((c) => ({ label: c.label, icon: c.icon ? icon(c.icon, 14) : "", hint: hintOf(ctx, c), run: () => void runCommand(ctx, c) })),
      );
  });

  onPress($(".rhead"), (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>("[data-r]")?.dataset.r;
    if (r) ctx.store.dispatch({ type: "rightSidebarPanel", panel: r as RightSidebarPanelId });
  });

  return shell;
};

export const renderRibbon = (root: HTMLElement, s: State) =>
  root.querySelectorAll<HTMLElement>("[data-rib]").forEach((b) =>
    b.classList.toggle("on", (s.showSidebar && b.dataset.rib === s.sidebarPanel) || (b.dataset.rib === "plot" && s.plot !== null) || (b.dataset.rib === "diff" && diffSelected(s))),
  );

export const renderWorkspaceBar = (root: HTMLElement, s: State, branch: string) => {
  const name = root.querySelector<HTMLElement>(".workspace-bar .name")!;
  name.innerHTML = `${icon("chevrons-up-down", 13)}<span>${esc(s.workspace ? basename(s.workspace) : "ワークスペースなし")}</span>`;
  root.querySelector<HTMLElement>(".workspace-bar .br")!.innerHTML = branch ? `${icon("git-branch", 12)}<span>${esc(branch)}</span>` : "";
};

/** The title of the shown sheet (docs/adr/0087), the plot, or nothing. */
export const titleHtml = (s: State, titles: Map<string, string>) => {
  const { open, focus } = shown(s);
  const d = open[focus];
  if (d) {
    const others = open.length > 1 ? ` <small>ほか ${open.length - 1} 章</small>` : "";
    return `${esc(titles.get(d.path) ?? stem(d.path))}<small>${esc(d.workspace ? rel(d.workspace, d.path) : d.path)}</small>${others}${open.some(dirty) ? `<span class="dirty"> ●</span>` : ""}`;
  }
  return s.plot ? `プロット<small>${esc(basename(s.plot))}</small>` : "";
};

export const renderToolbar = (root: HTMLElement, s: State, ctx: Ctx, titles: Map<string, string>) => {
  const toolbar = root.querySelector<HTMLElement>(".toolbar")!;
  const { open, focus } = shown(s);
  const d = open[focus];
  // the editor's switch on the left, the preview's button on the right (docs/adr/0005, docs/adr/0087)
  toolbar.innerHTML = `
    <span class="iconbtn" data-toolbar="sidebar" title="サイドバー">${icon("panel-left")}</span>
    ${open.length && open.every((x) => canVertical(x.kind)) ? `<span class="seg"><span data-vert="1" class="${s.vertical ? "on" : ""}">縦</span><span data-vert="0" class="${s.vertical ? "" : "on"}">横</span></span>` : ""}
    <span class="title" data-tauri-drag-region>${devBadge(ctx.debug)}${titleHtml(s, titles)}</span>
    ${previewAvailable(s) ? `<span class="seg"><span data-toolbar="preview" title="プレビューのタブを出す">プレビュー</span></span>` : ""}
    ${d?.project ? `<span class="iconbtn" data-toolbar="build" title="ビルド">${icon("hammer")}</span>` : ""}
    ${menuCommands(ctx.commands, s).length ? `<span class="iconbtn" data-toolbar="more-actions" title="ほかの操作">${icon("more-horizontal")}</span>` : ""}
    <span class="iconbtn ${s.showRightSidebar ? "on" : ""}" data-toolbar="right-sidebar" title="右サイドバー">${icon("panel-right")}</span>`;
};

export const renderRightSidebarHead = (shell: Shell, s: State) => {
  shell.rightSidebarEl.classList.toggle("hidden", !s.showRightSidebar);
  shell.rightSidebarEl.querySelector<HTMLElement>(".rhead")!.innerHTML = RIGHT_SIDEBAR.map(
    ([k, i, t]) => `<span class="iconbtn ${s.rightSidebarPanel === k ? "on" : ""}" data-r="${k}" title="${t}">${icon(i)}</span>`,
  ).join("");
  shell.rightSidebarBody.className = `rbody ${s.rightSidebarPanel}`;
};

export const renderStatus = (shell: Shell, s: State, ctx: Ctx) => {
  const parts = ctx.status.map((f) => f(s, ctx)).filter(Boolean);
  shell.statusBarEl.innerHTML = parts.join("");
  shell.statusBarEl.onclick = (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("[data-status]")?.dataset.status;
    if (k) ctx.statusActions[k]?.(ctx);
  };
};

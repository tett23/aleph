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
import { plotReason } from "../plot/availability.ts";
import { menu, onPress } from "./dom.ts";
import { workspaceProjectItem } from "./tree.ts";
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

type RibbonId = (typeof RIBBON)[number][0];

/** The ribbon's buttons (docs/adr/0098), named by the item; their states are set by renderRibbon. */
export const ribbonHtml = () => `
      ${RIBBON.map(([k, i, t]) => `<button type="button" class="iconbtn" data-rib="${k}" aria-label="${esc(t)}" aria-pressed="false" title="${esc(t)}">${icon(i)}</button>`).join("")}
      <span class="grow" data-tauri-drag-region></span>
      <button type="button" class="iconbtn" data-settings aria-label="設定" title="設定">${icon("settings")}</button>`;

/** The command whose check an item uses: the plot's and the diff's, and the sidebar's panels that have one. */
const ribbonCommand = (ctx: Ctx, k: RibbonId) => {
  const id = k === "plot" ? "view.plot" : k === "diff" ? "view.diff" : `view.sidebar.${k}`;
  return ctx.commands.find((c) => c.id === id);
};

/**
 * An item's state (docs/adr/0098): disabled when its command cannot run, else selected or not.
 * A disabled plot says why in its tooltip.
 */
export const ribbonItem = (k: RibbonId, s: State, ctx: Ctx): { selected: boolean; disabled: boolean; title: string } => {
  const label = RIBBON.find(([x]) => x === k)?.[2] ?? k;
  const c = ribbonCommand(ctx, k);
  // a panel without a command is always enabled; the plot and the diff without theirs are not
  const disabled = c ? !c.when(s) : k === "plot" || k === "diff";
  const selected = !disabled && ((s.showSidebar && k === s.sidebarPanel) || (k === "plot" && s.plot !== null) || (k === "diff" && diffSelected(s)));
  const reason = disabled && k === "plot" ? plotReason(ctx.plotGate?.availability(s) ?? { kind: "noTarget" }) : null;
  return { selected, disabled, title: reason ? `${label}（${reason}）` : label };
};

/** A press on an item; a disabled item runs nothing, and the plot's and the diff's commands check again. */
const pressRibbon = (ctx: Ctx, t: HTMLElement) => {
  if (t.dataset.settings !== undefined) return void openSettingsDialog(ctx);
  const k = t.dataset.rib as RibbonId | undefined;
  if (!k || (t as HTMLButtonElement).disabled) return;
  if (k === "plot" || k === "diff") {
    // the diff tab, through its command (docs/adr/0088); the plot, through view.plot (docs/adr/0098)
    const c = ribbonCommand(ctx, k);
    if (c && c.when(ctx.store.get())) void runCommand(ctx, c);
    return;
  }
  ctx.store.dispatch({ type: "sidebarPanel", panel: k });
};

/** The mouse at mouseup (see onPress), and the keyboard's Enter and Space: a click with no pointer (detail 0). */
export const wireRibbon = (el: HTMLElement, ctx: Ctx) => {
  const at = (e: Event) => (e.target as HTMLElement).closest<HTMLElement>("[data-rib],[data-settings]");
  onPress(el, (e) => {
    const t = at(e);
    if (t) pressRibbon(ctx, t);
  });
  el.addEventListener("click", (e) => {
    if ((e as MouseEvent).detail !== 0) return;
    const t = at(e);
    if (t) pressRibbon(ctx, t);
  });
};

export const mountShell = (root: HTMLElement, ctx: Ctx): Shell => {
  root.innerHTML = `
    <div class="ribbon" data-tauri-drag-region>${ribbonHtml()}
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

  wireRibbon($(".ribbon"), ctx);

  onPress($(".workspace-bar"), (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-wsmenu]");
    if (!t) return;
    const s = ctx.store.get();
    const initialize = workspaceProjectItem(ctx, s.workspace);
    menu(t, [
      ...s.workspaces.map((w) => ({ label: basename(w), icon: icon(w === s.workspace ? "check" : "dot", 14), run: () => ctx.store.dispatch({ type: "workspace", path: w }) })),
      "-",
      ...(initialize ? [initialize] : []),
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

/** Sets each item's state: the selection's class and aria-pressed, disabled, and the tooltip (docs/adr/0098). */
export const renderRibbon = (root: ParentNode, s: State, ctx: Ctx) =>
  root.querySelectorAll<HTMLButtonElement>("[data-rib]").forEach((b) => {
    const { selected, disabled, title } = ribbonItem(b.dataset.rib as RibbonId, s, ctx);
    b.classList.toggle("on", selected);
    b.setAttribute("aria-pressed", String(selected));
    b.disabled = disabled;
    b.title = title;
  });

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

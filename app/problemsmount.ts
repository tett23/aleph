// The bottom panel under the editor area (docs/adr/0055, names:
// docs/adr/0082): the problems tab with the open sheets' diagnostics and the project's
// check, lint and preflight, grouped by file; the notifications tab with their history
// (docs/adr/0064); the build log tab after a build (docs/adr/0069); and the assistant's tab
// (docs/adr/0081), whose element is kept across redraws so its field keeps what is typed.
import { assistantTab, assistantView } from "./assistant/mount.ts";
import { addCommands } from "./commands.ts";
import type { Ctx } from "./ctx.ts";
import { golemResults } from "./diag/mount.ts";
import { renderBuildLog } from "./buildlog.ts";
import { buildLogs, buildProblems } from "./projectbuildmount.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import { countProblems, DEFAULT_HEIGHT, emptyText, filterGroups, fromGolem, groupProblems, nextFilter, panelHeight, problemsCopyText, problemSeverityLabel, type Filter, type Problem } from "./problems.ts";
import { allDocs, focused, shownDoc } from "./store.ts";
import { uiState } from "./uistate.ts";
import { copyText, LEVEL_ICON, notifications } from "./ui/notices.ts";
import { badgeText, type Note } from "./notify.ts";

const SHOW = "showBottomPanel";
const HEIGHT = "bottomPanelHeight";
const TAB = "bottomPanelTab";
type Tab = "problems" | "notifications" | "build-log" | "assistant";
const KEPT: Tab[] = ["problems", "notifications", "assistant"];

const SEV: Record<Problem["severity"], string> = { error: "circle-x", warning: "triangle-alert", info: "info" };

/** The open sheets' editor diagnostics. */
const editorProblems = (ctx: Ctx): Problem[] =>
  allDocs(ctx.store.get()).flatMap((d) =>
    (ctx.editors.get(d.path)?.edit?.diagnostics() ?? []).map((x) => ({
      file: d.path,
      line: x.line,
      col: x.col,
      severity: x.severity === "error" ? "error" : x.severity === "warning" ? "warning" : "info",
      message: x.message,
      source: x.source ?? "",
      code: "",
    })),
  );

const allProblems = (ctx: Ctx): Problem[] => {
  const project = focused(ctx.store.get())?.project;
  return [...editorProblems(ctx), ...(project ? [...golemResults(project).flatMap((r) => fromGolem(project, r.kind, r.items)), ...buildProblems(project)] : [])];
};

// the counts beside the tab narrow the list to their severity, and clear it pressed again (docs/adr/0110)
const COUNTS: [Problem["severity"], string, "errors" | "warnings" | "others", string][] = [
  ["error", "circle-x", "errors", "エラー"],
  ["warning", "triangle-alert", "warnings", "警告"],
  ["info", "info", "others", "そのほか"],
];
const countsHtml = (c: ReturnType<typeof countProblems>, filter: Filter) =>
  COUNTS.map(([sev, ic, key, name]) =>
    `<span class="pc sev-${sev}${filter === sev ? " on" : ""}" data-sev="${sev}" title="${filter === sev ? "絞りこみを外す" : `${name}だけを出す`}">${icon(ic, 12)}${c[key]}</span>`,
  ).join("");

const rowHtml = (x: Problem, g: number, i: number) => {
  const open = x.line === null ? "診断のファイルを開く" : "診断の位置へ移動";
  return `<div class="pr sev-${x.severity}" data-g="${g}" data-i="${i}" title="${problemSeverityLabel[x.severity]}">${icon(SEV[x.severity], 13)}<span class="msg">${esc(x.message)}</span><small>${esc(
    [x.source, x.code].filter(Boolean).join(" "),
  )}${x.line !== null ? ` [${x.line}, ${x.col ?? 1}]` : ""}</small>${x.file ? `<button type="button" class="iconbtn problem-open" data-problem-open aria-label="${open}" title="${open}">${icon("arrow-up-right", 13)}</button>` : ""}</div>`;
};

const time = (at: number) => new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A row of the history: still on the screen and sticky, it has the notification's buttons. */
const noteRow = (n: Note) =>
  `<div class="nr lv-${n.level}">${icon(LEVEL_ICON[n.level], 13)}<span class="tm">${time(n.at)}</span><div class="msg">${esc(n.message)}${n.repeats > 1 ? `<span class="rep">×${n.repeats}</span>` : ""}${
    n.live && n.actions.length ? `<div class="btns">${n.actions.map((a, i) => `<span class="btn${a.primary ? " pri" : ""}" data-nid="${n.id}" data-na="${i}">${esc(a.label)}</span>`).join("")}</div>` : ""
  }</div></div>`;

export const mountBottomPanel = (ctx: Ctx) => {
  let el: HTMLElement | null = null;
  const shown = () => uiState().get(SHOW, false);
  let buildSelected = false;
  let filter: Filter = null;
  const tab = (): Tab => {
    if (buildSelected) return "build-log";
    const kept = uiState().get<string>(TAB, "problems");
    return KEPT.find((t) => t === kept) ?? "problems";
  };
  const setTab = (t: Tab) => {
    buildSelected = t === "build-log";
    if (!buildSelected) uiState().set(TAB, t);
    ctx.refresh(["bottomPanel"]);
  };
  const column = () => el?.parentElement?.clientHeight ?? 800;

  const setShown = (on: boolean) => {
    uiState().set(SHOW, on);
    ctx.refresh(["bottomPanel"]);
  };

  const draw = (host: HTMLElement) => {
    el = host;
    host.hidden = !shown();
    if (host.hidden) return;
    host.style.height = `${panelHeight(uiState().get(HEIGHT, DEFAULT_HEIGHT), column())}px`;
    const s = ctx.store.get();
    const list = allProblems(ctx);
    const groups = groupProblems(list, focused(s)?.path ?? null, s.workspace);
    // the list shows the filter's severity only; the counts above stay those of every diagnostic
    const shownGroups = filterGroups(groups, filter);
    const project = focused(s)?.project;
    const log = project && buildLogs.get(project);
    const t = tab() === "build-log" && !log ? "problems" : tab();
    const ns = notifications();
    // seeing the tab clears its count
    if (t === "notifications") ns.seen();
    const un = ns.unseen();
    const badge = un.count ? `<span class="nbadge${un.error ? " err" : ""}">${badgeText(un.count)}</span>` : "";
    const history = ns.history();
    const head = `<div class="phead2"><span class="bottom-panel-tab${t === "problems" ? " on" : ""}" data-tab="problems">問題</span>${countsHtml(countProblems(groups.flatMap((g) => g.items)), filter)}<span class="bottom-panel-tab${t === "notifications" ? " on" : ""}" data-tab="notifications">通知${badge}</span>${log ? `<span class="bottom-panel-tab${t === "build-log" ? " on" : ""}" data-tab="build-log">ビルドログ</span>` : ""}<span class="bottom-panel-tab${t === "assistant" ? " on" : ""}" data-tab="assistant">アシスタント</span><span class="grow"></span>${
        t === "problems" ? `<button type="button" class="btn small copy-text" data-copy-problems${shownGroups.length ? "" : " disabled"}>問題をコピー</button>`
          : t === "notifications" && history.length ? `<span class="btn small" data-clear>履歴を消す</span>` : ""
      }<span class="iconbtn" data-close title="閉じる（⇧⌘M）">${icon("x", 13)}</span></div>`;
    // the assistant's element stays in place: only the head is drawn again
    const body = host.querySelector<HTMLElement>(".pbody2");
    if (t === "assistant" && body?.firstElementChild === assistantView(ctx)) {
      host.querySelector(".phead2")!.outerHTML = head;
    } else host.innerHTML = `<div class="pgrip" data-grip></div>
      ${head}
      <div class="pbody2${t === "assistant" ? " as-body" : ""}" tabindex="-1">${
        t === "assistant" ? "" : t === "build-log" && log ? renderBuildLog(log) : t === "notifications"
          ? history.length
            ? history.map(noteRow).join("")
            : `<div class="empty">通知はありません</div>`
          : shownGroups.length
            ? shownGroups.map((g, gi) => `<div class="pg"><div class="pf">${esc(g.label)}<small>${g.items.length}</small></div>${g.items.map((x, i) => rowHtml(x, gi, i)).join("")}</div>`).join("")
            : `<div class="empty">${emptyText(filter)}</div>`
      }</div>`;
    if (t === "assistant") host.querySelector(".pbody2")!.append(assistantView(ctx));

    host.onmousedown = (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("[data-close]")) return void (e.preventDefault(), setShown(false));
      // the assistant's tab takes its own clicks, and its field takes the focus
      if (t.closest(".assistant")) return;
      if (t.closest("[data-grip]")) return drag(e);
      const sev = t.closest<HTMLElement>("[data-sev]")?.dataset.sev as Problem["severity"] | undefined;
      if (sev) {
        e.preventDefault();
        filter = nextFilter(filter, sev);
        return setTab("problems");
      }
      const tb = t.closest<HTMLElement>("[data-tab]")?.dataset.tab;
      if (tb === "problems" || tb === "notifications" || tb === "build-log" || tb === "assistant") return void (e.preventDefault(), setTab(tb));
      if (t.closest("[data-clear]")) return void (e.preventDefault(), notifications().clearHistory());
      const na = t.closest<HTMLElement>("[data-na]");
      if (na) return void (e.preventDefault(), notifications().press(Number(na.dataset.nid), Number(na.dataset.na)));
    };
    host.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-copy-problems]")) return void copyText(problemsCopyText(shownGroups));
      const row = t.closest("[data-problem-open]")?.closest<HTMLElement>("[data-g]");
      if (!row) return;
      const x = shownGroups[Number(row.dataset.g)]?.items[Number(row.dataset.i)];
      if (x?.file) void ctx.open([x.file], x.line !== null ? { line: x.line, col: Math.max(0, (x.col ?? 1) - 1) } : undefined);
    };
    host.onkeydown = (e) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      setShown(false);
    };
  };

  // the top border: drag to change the height, kept in ui.bottomPanelHeight
  const drag = (down: MouseEvent) => {
    down.preventDefault();
    const host = el!;
    const start = host.offsetHeight;
    const move = (e: MouseEvent) => {
      host.style.height = `${panelHeight(start + down.clientY - e.clientY, column())}px`;
    };
    const up = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      uiState().set(HEIGHT, host.offsetHeight);
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  };

  ctx.view.bottomPanel = (host) => draw(host);
  // the history and its count follow every notification while the panel is open
  notifications().subscribe(() => shown() && ctx.refresh(["bottomPanel"]));
  // opened from the status bar (the counts, lint and preflight); open stays open
  const openTab = (tab: Tab) => {
    setTab(tab);
    setShown(true);
  };
  ctx.statusActions.problems = () => openTab("problems");
  ctx.statusActions.build = () => openTab("build-log");
  assistantTab.open = () => openTab("assistant");

  // the focused sheet's counts, every source's, also for kinds without a server
  ctx.status.push((s) => {
    const d = shownDoc(s);
    const t = d && ctx.editors.get(d.path)?.edit;
    if (!t) return "";
    const c = countProblems(editorProblems(ctx).filter((x) => x.file === d.path));
    return `<span class="problems" data-status="problems" title="下部パネル（⇧⌘M）">エラー ${c.errors}　警告 ${c.warnings}</span>`;
  });

  addCommands(ctx.commands, {
    id: "view.bottomPanel",
    label: "下部パネル",
    icon: "list-checks",
    keys: ["Mod-Shift-m"],
    menu: true,
    when: () => true,
    run: () => setShown(!shown()),
  }, {
    id: "view.notifications",
    label: "通知の履歴を表示",
    icon: "info",
    when: () => true,
    run: () => openTab("notifications"),
  });
};

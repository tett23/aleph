// The problems panel under the editor (docs/adr/0055): the open sheets'
// diagnostics and the project's check, lint and preflight, grouped by file; and the
// notifications' history in a tab of its own (docs/adr/0064).
import { addCommands } from "./commands.ts";
import type { Ctx } from "./ctx.ts";
import { golemResults } from "./diag/mount.ts";
import { buildProblems } from "./projectbuildmount.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import { countProblems, DEFAULT_HEIGHT, fromGolem, groupProblems, panelHeight, type Problem } from "./problems.ts";
import { allDocs, focused } from "./store.ts";
import { uiState } from "./uistate.ts";
import { LEVEL_ICON, notifications } from "./ui/notices.ts";
import type { Note } from "./notify.ts";

const SHOW = "showProblems";
const HEIGHT = "problemsHeight";
const TAB = "problemsTab";
type Tab = "problems" | "notes";

const SEV: Record<Problem["severity"], [string, string]> = {
  error: ["circle-x", "エラー"],
  warning: ["triangle-alert", "警告"],
  info: ["info", "情報"],
};

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

const countsHtml = (c: ReturnType<typeof countProblems>) =>
  `<span class="pc sev-error">${icon("circle-x", 12)}${c.errors}</span><span class="pc sev-warning">${icon("triangle-alert", 12)}${c.warnings}</span><span class="pc sev-info">${icon("info", 12)}${c.others}</span>`;

const rowHtml = (x: Problem, g: number, i: number) =>
  `<div class="pr sev-${x.severity}" data-g="${g}" data-i="${i}" title="${SEV[x.severity][1]}">${icon(SEV[x.severity][0], 13)}<span class="msg">${esc(x.message)}</span><small>${esc(
    [x.source, x.code].filter(Boolean).join(" "),
  )}${x.line !== null ? ` [${x.line}, ${x.col ?? 1}]` : ""}</small></div>`;

const time = (at: number) => new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A row of the history: still on the screen and sticky, it has the notification's buttons. */
const noteRow = (n: Note) =>
  `<div class="nr lv-${n.level}">${icon(LEVEL_ICON[n.level], 13)}<span class="tm">${time(n.at)}</span><div class="msg">${esc(n.message)}${n.repeats > 1 ? `<span class="rep">×${n.repeats}</span>` : ""}${
    n.live && n.actions.length ? `<div class="btns">${n.actions.map((a, i) => `<span class="btn${a.primary ? " pri" : ""}" data-nid="${n.id}" data-na="${i}">${esc(a.label)}</span>`).join("")}</div>` : ""
  }</div></div>`;

export const mountProblems = (ctx: Ctx) => {
  let el: HTMLElement | null = null;
  const shown = () => uiState().get(SHOW, false);
  const tab = (): Tab => (uiState().get<string>(TAB, "problems") === "notes" ? "notes" : "problems");
  const setTab = (t: Tab) => {
    uiState().set(TAB, t);
    ctx.refresh(["problems"]);
  };
  const column = () => el?.parentElement?.clientHeight ?? 800;

  const setShown = (on: boolean) => {
    uiState().set(SHOW, on);
    ctx.refresh(["problems"]);
  };

  const draw = (host: HTMLElement) => {
    el = host;
    host.hidden = !shown();
    if (host.hidden) return;
    host.style.height = `${panelHeight(uiState().get(HEIGHT, DEFAULT_HEIGHT), column())}px`;
    const s = ctx.store.get();
    const list = allProblems(ctx);
    const groups = groupProblems(list, focused(s)?.path ?? null, s.workspace);
    const t = tab();
    const ns = notifications();
    // seeing the tab clears its count
    if (t === "notes") ns.seen();
    const un = ns.unseen();
    const badge = un.count ? `<span class="nbadge${un.error ? " err" : ""}">${un.count}</span>` : "";
    const history = ns.history();
    host.innerHTML = `<div class="pgrip" data-grip></div>
      <div class="phead2"><span class="ptab${t === "problems" ? " on" : ""}" data-tab="problems">問題</span>${countsHtml(countProblems(groups.flatMap((g) => g.items)))}<span class="ptab${t === "notes" ? " on" : ""}" data-tab="notes">通知${badge}</span><span class="grow"></span>${
        t === "notes" && history.length ? `<span class="btn small" data-clear>履歴を消す</span>` : ""
      }<span class="iconbtn" data-close title="閉じる（⇧⌘M）">${icon("x", 13)}</span></div>
      <div class="pbody2" tabindex="-1">${
        t === "notes"
          ? history.length
            ? history.map(noteRow).join("")
            : `<div class="empty">通知はありません</div>`
          : groups.length
            ? groups.map((g, gi) => `<div class="pg"><div class="pf">${esc(g.label)}<small>${g.items.length}</small></div>${g.items.map((x, i) => rowHtml(x, gi, i)).join("")}</div>`).join("")
            : `<div class="empty">問題はありません</div>`
      }</div>`;

    // a row: open its file at its place; taken at mousedown so the editor keeps the focus (as the old list did)
    host.onmousedown = (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest("[data-close]")) return void (e.preventDefault(), setShown(false));
      if (t.closest("[data-grip]")) return drag(e);
      const tb = t.closest<HTMLElement>("[data-tab]")?.dataset.tab;
      if (tb === "problems" || tb === "notes") return void (e.preventDefault(), setTab(tb));
      if (t.closest("[data-clear]")) return void (e.preventDefault(), notifications().clearHistory());
      const na = t.closest<HTMLElement>("[data-na]");
      if (na) return void (e.preventDefault(), notifications().press(Number(na.dataset.nid), Number(na.dataset.na)));
      // the history's text can be selected and copied
      if (t.closest(".nr")) return;
      const row = t.closest<HTMLElement>("[data-g]");
      if (!row) return;
      e.preventDefault();
      const x = groups[Number(row.dataset.g)]?.items[Number(row.dataset.i)];
      if (x?.file) void ctx.open([x.file], x.line !== null ? { line: x.line, col: Math.max(0, (x.col ?? 1) - 1) } : undefined);
    };
    host.onkeydown = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setShown(false);
    };
  };

  // the top border: drag to change the height, kept in ui.problemsHeight
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

  ctx.view.problems = (host) => draw(host);
  // the history and its count follow every notification while the panel is open
  notifications().subscribe(() => shown() && ctx.refresh(["problems"]));
  // opened from the status bar (the counts, lint and preflight); open stays open
  ctx.statusActions.problems = () => setShown(true);

  // the focused sheet's counts, every source's, also for kinds without a server
  ctx.status.push((s) => {
    const d = focused(s);
    const t = d && ctx.editors.get(d.path)?.edit;
    if (!t) return "";
    const c = countProblems(editorProblems(ctx).filter((x) => x.file === d.path));
    return `<span class="problems" data-status="problems" title="問題のパネル（⇧⌘M）">エラー ${c.errors}　警告 ${c.warnings}</span>`;
  });

  addCommands(ctx.commands, {
    id: "view.problems",
    label: "問題のパネル",
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
    run: () => {
      uiState().set(TAB, "notes");
      setShown(true);
      ctx.refresh(["problems"]);
    },
  });
};

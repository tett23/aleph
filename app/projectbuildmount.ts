// Building a project from Aleph (docs/adr/0058): the toolbar's button and its
// popup, the commands, the status item, and the diagnostics for the problems panel.
import { api } from "./api.ts";
import { createBuildLogs, revealBuildAction } from "./buildlog.ts";
import { withBuildDir } from "./buildlock.ts";
import { addCommands } from "./commands.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { h } from "./icons.ts";
import { basename } from "./path.ts";
import { fromGolem, type Problem } from "./problems.ts";
import {
  buildArgs,
  buildStatus,
  createRunner,
  marksApply,
  MARKS,
  PROFILES,
  readBuildOptions,
  readBuildResult,
  TARGETS,
  type BuildOptions,
  type BuildResult,
} from "./projectbuild.ts";
import { focused } from "./store.ts";
import { golem } from "./tools.ts";
import { uiState } from "./uistate.ts";
import { notifications } from "./ui/notices.ts";

const KEY = "buildOptions";
const results = new Map<string, BuildResult>();
export const buildLogs = createBuildLogs();

/** The last build's diagnostics of a project, for the problems panel. */
export const buildProblems = (project: string): Problem[] => fromGolem(project, "build", results.get(project)?.items ?? []);

const LABEL: Record<string, string> = { all: "すべて", none: "なし", japanese: "日本式", western: "西洋式" };
const seg = <T extends string>(name: string, list: T[], on: T) =>
  `<span class="seg" data-opt="${name}">${list.map((v) => `<span data-v="${v}" class="${v === on ? "on" : ""}">${esc(LABEL[v] ?? v)}</span>`).join("")}</span>`;

export const mountProjectBuild = (ctx: Ctx) => {
  const options = () => readBuildOptions(uiState().get<unknown>(KEY, {}));
  const projectNow = () => focused(ctx.store.get())?.project ?? null;

  const run = createRunner(async (project) => {
    const started = performance.now();
    const args = buildArgs(options());
    const pending = buildLogs.run(project, args, () => withBuildDir(project, () => golem(ctx, project, args)));
    ctx.refresh(["status", "problems"]);
    const o = await pending;
    const r: BuildResult = { ...readBuildResult(o.code, o.stderr, o.stdout), seconds: (performance.now() - started) / 1000 };
    results.set(project, r);
    ctx.refresh(["status", "problems"]);
    const errors = r.items.filter((d) => d.severity === "error").length;
    const open = [{ label: "問題のパネルを開く", run: () => ctx.statusActions.problems?.(ctx) }];
    if (r.failed) ctx.notify({ message: "ビルドできませんでした", level: "error", sticky: true, actions: open, key: `build:${project}` });
    else if (errors) ctx.notify({ message: `ビルドでエラーが ${errors} 件あります`, level: "error", sticky: true, actions: open, key: `build:${project}` });
    else {
      // the last build's failure no longer holds
      notifications().dismissKey(`build:${project}`);
      ctx.notify({ message: `ビルドしました（${r.seconds.toFixed(1)} 秒）`, actions: [revealBuildAction(project, reveal)] });
    }
    if (r.failed || errors) ctx.statusActions.problems?.(ctx);
  });

  const build = () => {
    const p = projectNow();
    if (!p) return ctx.toast("Golem のプロジェクトのシートを開いてから実行してください");
    void run(p);
  };
  const reveal = (path: string) => void api.revealPath(path).catch((error) => ctx.notify({ message: String(error), level: "error", sticky: true }));

  // the popup under the toolbar's button
  let popup: HTMLElement | null = null;
  const closePopup = () => {
    popup?.remove();
    popup = null;
  };
  const openPopup = () => {
    const project = projectNow();
    const anchor = document.querySelector<HTMLElement>('.toolbar [data-tb="build"]');
    if (!project) return ctx.toast("Golem のプロジェクトのシートを開いてから実行してください");
    closePopup();
    const draw = (o: BuildOptions) => {
      popup!.innerHTML = `<h4>ビルド<small>${esc(basename(project))}</small></h4>
        <div class="row"><label>ターゲット</label>${seg("target", TARGETS, o.target)}</div>
        <div class="row"><label>プロファイル</label>${seg("profile", PROFILES, o.profile)}</div>
        ${marksApply(o) ? `<div class="row"><label>トンボ</label>${seg("marks", MARKS, o.marks)}</div>` : ""}
        <div class="btns"><span class="btn" data-act="reveal">build/ を Finder で表示</span><span class="btn pri" data-act="build">ビルド（⇧⌘B）</span></div>`;
    };
    popup = h(`<div class="buildpop" tabindex="-1"></div>`);
    document.body.append(popup);
    draw(options());
    const r = anchor?.getBoundingClientRect();
    const w = popup.offsetWidth;
    Object.assign(popup.style, r ? { top: `${r.bottom + 6}px`, left: `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px` } : { top: "48px", right: "16px" });
    // presses are taken at mouseup, like the menus (docs/adr/0058): near the overlay title bar the
    // mousedown can arrive after the mouseup; mousedown only keeps the focus where it is
    const within = (e: MouseEvent, el: Element | null | undefined) => {
      const r = el?.getBoundingClientRect();
      return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    popup.addEventListener("mousedown", (e) => e.button === 0 && e.preventDefault());
    popup.addEventListener("mouseup", (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      const v = t.closest<HTMLElement>("[data-v]");
      const opt = t.closest<HTMLElement>("[data-opt]")?.dataset.opt;
      if (v && opt) {
        const next = { ...options(), [opt]: v.dataset.v };
        uiState().set(KEY, next);
        return draw(readBuildOptions(next));
      }
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "reveal") return reveal(`${project}/build`);
      if (act === "build") {
        closePopup();
        void run(project);
      }
    });
    popup.addEventListener("keydown", (e) => e.key === "Escape" && closePopup());
    popup.focus();
    // a press anywhere but on the popup or its button closes it; judged by where it is, not by its target
    const outside = (e: MouseEvent) => {
      if (!popup) return document.removeEventListener("mouseup", outside, true);
      // a mouseup at (-1, -1) arrives with a press on the popup's button: not a press outside
      if (e.clientX < 0 || e.clientY < 0) return;
      if (within(e, popup) || within(e, anchor)) return;
      closePopup();
      document.removeEventListener("mouseup", outside, true);
    };
    setTimeout(() => document.addEventListener("mouseup", outside, true), 0);
  };

  // the toolbar's button (drawn by the shell when the sheet is in a project)
  ctx.statusActions.buildOptions = () => (popup ? closePopup() : openPopup());

  ctx.status.push((s) => {
    const project = focused(s)?.project;
    if (!project) return "";
    const st = buildStatus(results.get(project) ?? null, buildLogs.get(project)?.result.state === "running");
    return st ? `<span class="chk ${st.cls === "running" ? "running" : st.cls}" data-status="build" title="ビルドログを開く">${esc(st.text)}</span>` : "";
  });

  addCommands(
    ctx.commands,
    { id: "project.build", label: "ビルド", icon: "hammer", keys: ["Mod-Shift-b"], menu: true, when: (s) => !!focused(s)?.project, run: build },
    { id: "project.buildOptions", label: "ビルドの設定", icon: "hammer", when: (s) => !!focused(s)?.project, run: openPopup },
  );
};

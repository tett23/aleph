// Saving and Git (docs/adr/0011): saving every few seconds and before a sheet
// goes away, the daily commit, manual commits, the Git panel and the tree's marks.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { autosaveMessage, parseStatus, shouldAutoCommit, ymd, type StatusEntry } from "./git.ts";
import { icon } from "./icons.ts";
import { basename, rel } from "./path.ts";
import { allDocs, dirty, type State } from "./store.ts";
import { git } from "./tools.ts";
import { item, toggle } from "./ui/settings.ts";
import { renderWsbar } from "./ui/shell.ts";
import { reloadTree } from "./ui/tree.ts";
import { OPEN_KINDS, kindOf } from "./workspace.ts";

const status = new Map<string, StatusEntry[]>();
const changedPaths = new Set<string>();
let branch = "";

/** The current workspace's branch, for the bar above the tree. */
export const currentBranch = () => branch;

const lines = (o: { stdout: string; stderr: string }) => (o.stdout + o.stderr).trim().split("\n").slice(-3).join("\n");

/** Reads `git status` of a workspace again, for the panel and the tree's marks. */
export const refreshStatus = async (ctx: Ctx, ws: string) => {
  const o = await git(ctx, ws, ["status", "--porcelain=v1", "-z", "-uall"]).catch(() => null);
  status.set(ws, o && o.code === 0 ? parseStatus(o.stdout) : []);
  changedPaths.clear();
  for (const [w, list] of status) for (const e of list) changedPaths.add(`${w}/${e.path}`);
};

const refreshBranch = async (ctx: Ctx, ws: string) => {
  const o = await git(ctx, ws, ["branch", "--show-current"]).catch(() => null);
  branch = o && o.code === 0 ? o.stdout.trim() : "";
  if (document.querySelector(".wsbar")) renderWsbar(document.body, ctx.store.get(), branch);
};

/** Saves every open sheet, then `git add -A` and commits; the change marks then compare with the new HEAD. */
export const commit = async (ctx: Ctx, ws: string, message: string): Promise<boolean> => {
  await ctx.save();
  const add = await git(ctx, ws, ["add", "-A"]);
  if (add.code !== 0) return ctx.toast(lines(add) || "git add に失敗しました"), false;
  const c = await git(ctx, ws, ["commit", "-m", message]);
  if (c.code !== 0) return ctx.toast(lines(c) || "コミットに失敗しました"), false;
  for (const d of allDocs(ctx.store.get())) if (d.workspace === ws) ctx.editors.get(d.path)?.refreshMarks(true);
  await refreshStatus(ctx, ws);
  ctx.refresh(["left"]);
  return true;
};

/** The daily commit of each workspace with changes, recorded in the settings. */
const autoCommit = async (ctx: Ctx) => {
  const now = new Date();
  for (const ws of ctx.config.workspaces) {
    await refreshStatus(ctx, ws);
    const changed = (status.get(ws) ?? []).length > 0 || allDocs(ctx.store.get()).some((d) => d.workspace === ws && dirty(d));
    if (!shouldAutoCommit({ today: ymd(now), last: ctx.config.lastAutoCommit[ws], changed, enabled: ctx.config.autoCommit })) continue;
    const isRepo = await git(ctx, ws, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
    if (!isRepo || isRepo.code !== 0) continue;
    if (await commit(ctx, ws, autosaveMessage(now))) {
      ctx.config.lastAutoCommit[ws] = ymd(now);
      await ctx.saveConfig();
      ctx.toast(`${basename(ws)} を自動でコミットしました`);
    }
  }
  ctx.refresh(["left"]);
};

// ---- the panel ----

let selected: string | null = null;
let message = "";

const diffHtml = (text: string) =>
  esc(text)
    .split("\n")
    .map((l) => (l.startsWith("+") && !l.startsWith("+++") ? `<span class="d-add">${l}</span>` : l.startsWith("-") && !l.startsWith("---") ? `<span class="d-del">${l}</span>` : l))
    .join("\n");

const drawPanel = async (el: HTMLElement, ctx: Ctx) => {
  const ws = ctx.store.get().workspace;
  if (!ws) return void (el.innerHTML = `<div class="sec"><div class="muted">ワークスペースがありません。</div></div>`);
  const repo = await git(ctx, ws, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  if (!repo || repo.code !== 0)
    return void (el.innerHTML = `<div class="sec"><div class="muted">${esc(basename(ws))} は Git のリポジトリではありません。</div><div class="row"><span class="btn" data-a="init">git init</span></div></div>`);
  await refreshStatus(ctx, ws);
  const files = status.get(ws) ?? [];
  if (selected && !files.some((f) => f.path === selected)) selected = null;
  const [log, diff] = await Promise.all([
    git(ctx, ws, ["log", "--oneline", "-20"]).catch(() => null),
    selected ? git(ctx, ws, ["diff", "HEAD", "--", selected]).catch(() => null) : null,
  ]);
  el.innerHTML = `<div class="git">
    <div class="sec"><h5>${esc(basename(ws))} <small>${icon("git-branch", 12)} ${esc(branch)}</small></h5>
      ${
        files.length
          ? files
              .map((f) => `<div class="file ${selected === f.path ? "on" : ""}" data-f="${esc(f.path)}" title="${esc(f.path)}">${icon("file-text", 13)}<span>${esc(f.path)}</span><span class="st">${esc(f.code)}</span></div>`)
              .join("")
          : `<div class="muted">変更はありません</div>`
      }
      <textarea class="soft commitmsg" placeholder="コミットメッセージ（⌘↩ でコミット）">${esc(message)}</textarea>
      <div class="row"><span class="btn pri" data-a="commit">コミット</span><span class="btn" data-a="push">push</span><span class="btn" data-a="pull">pull</span><span class="btn" data-a="refresh" title="読みなおす">${icon("refresh-cw", 12)}</span></div>
      ${selected ? `<pre>${diff && diff.stdout ? diffHtml(diff.stdout) : "（HEAD にない新しいファイルです）"}</pre>` : ""}
    </div>
    <div class="sec log"><h5>履歴</h5>${(log?.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => `<div title="${esc(l)}"><b>${esc(l.slice(0, 7))}</b>${esc(l.slice(8))}</div>`)
      .join("")}</div></div>`;
};

const run = async (el: HTMLElement, ctx: Ctx, a: string) => {
  const ws = ctx.store.get().workspace;
  if (!ws) return;
  if (a === "commit") {
    if (!message.trim()) return ctx.toast("コミットメッセージを書いてください");
    if (await commit(ctx, ws, message)) {
      message = "";
      ctx.toast("コミットしました");
    }
  } else if (a === "init" || a === "push" || a === "pull") {
    const o = await git(ctx, ws, a === "pull" ? ["pull", "--no-rebase"] : [a]);
    ctx.toast(lines(o) || (o.code === 0 ? "完了しました" : "失敗しました"));
    if (a === "pull" && o.code === 0) {
      for (const d of allDocs(ctx.store.get())) if (d.workspace === ws) ctx.editors.get(d.path)?.refreshMarks(true);
      await reloadTree(ctx);
    }
    if (a === "init") await refreshBranch(ctx, ws);
  }
  await drawPanel(el, ctx);
};

/** push and pull from the command palette: the Git panel shows the result. */
const gitCommand = async (ctx: Ctx, a: "push" | "pull") => {
  const s = ctx.store.get();
  if (!s.showLeft || s.left !== "git") ctx.store.dispatch({ type: "left", panel: "git" });
  const el = document.querySelector<HTMLElement>(".git")?.parentElement;
  if (el) await run(el, ctx, a);
};

/** ⌘⇧K: the Git panel with the message field focused. */
const startCommit = (ctx: Ctx) => {
  const s = ctx.store.get();
  if (!s.showLeft || s.left !== "git") ctx.store.dispatch({ type: "left", panel: "git" });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>(".git .commitmsg")?.focus(), 150);
};

export const mountGit = (ctx: Ctx) => {
  ctx.left.git = {
    icon: "git-branch",
    title: "Git",
    render: async (el) => {
      await drawPanel(el, ctx);
      el.oninput = (e) => {
        const t = e.target as HTMLTextAreaElement;
        if (t.classList.contains("commitmsg")) message = t.value;
      };
      el.onkeydown = (e) => {
        if ((e.target as HTMLElement).classList.contains("commitmsg") && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void run(el, ctx, "commit");
        }
      };
      el.onclick = async (e) => {
        const t = (e.target as HTMLElement).closest<HTMLElement>("[data-a],[data-f]");
        if (!t) return;
        if (t.dataset.f) {
          const f = t.dataset.f;
          selected = selected === f ? null : f;
          if ((e as MouseEvent).detail === 2 && OPEN_KINDS.includes(kindOf(f))) return void ctx.open([`${ctx.store.get().workspace}/${f}`]);
          return void drawPanel(el, ctx);
        }
        await run(el, ctx, t.dataset.a!);
      };
    },
  };

  // a mark on files with changes not committed
  ctx.decor.push((p) => (changedPaths.has(p) ? `<span class="dot" title="コミットしていない変更"></span>` : ""));

  ctx.commands.push(
    { id: "git.commit", menu: true, keys: ["Mod-Shift-k"], label: "コミット", icon: "git-commit-horizontal", when: (s) => !!s.workspace, run: startCommit },
    { id: "git.push", label: "push", icon: "arrow-up-right", when: (s) => !!s.workspace, run: (c) => gitCommand(c, "push") },
    { id: "git.pull", label: "pull", icon: "refresh-cw", when: (s) => !!s.workspace, run: (c) => gitCommand(c, "pull") },
  );

  // saving: every few seconds, and before a sheet goes away (closed, or replaced by another)
  let timer = 0;
  const schedule = () => {
    clearInterval(timer);
    timer = window.setInterval(() => {
      if (allDocs(ctx.store.get()).some(dirty)) void ctx.save();
    }, ctx.config.autosaveSeconds * 1000);
  };
  schedule();
  let statusTimer = 0;
  ctx.store.subscribe((s: State, prev: State) => {
    for (const d of allDocs(prev)) if (dirty(d) && !allDocs(s).some((x) => x.path === d.path)) void api.writeText(d.path, d.text);
    const saved = allDocs(s).some((d) => allDocs(prev).find((x) => x.path === d.path && x.saved !== d.saved));
    if (saved && s.workspace) {
      clearTimeout(statusTimer);
      statusTimer = window.setTimeout(() => void refreshStatus(ctx, s.workspace!).then(() => ctx.refresh(["left"])), 500);
    }
    if (s.workspace !== prev.workspace && s.workspace) void refreshBranch(ctx, s.workspace).then(() => refreshStatus(ctx, s.workspace!)).then(() => ctx.refresh(["left"]));
  });

  // quitting: save first (the menu's Quit, ⌘Q, asks through the Rust side; the window's close button here)
  void listen("aleph:quit", async () => {
    await ctx.save().catch(() => {});
    await invoke("quit");
  });
  void getCurrentWindow().onCloseRequested(async () => {
    await ctx.save().catch(() => {});
  });

  // the daily commit: at start and every hour
  void autoCommit(ctx);
  setInterval(() => void autoCommit(ctx), 60 * 60 * 1000);
  const ws = ctx.store.get().workspace;
  if (ws) void refreshBranch(ctx, ws);

  ctx.settings.push({
    id: "saving",
    label: "保存と Git",
    group: "オプション",
    render: (c) =>
      item("自動保存の間隔", "変更のあるシートを保存する間隔（既定 10 秒）", `<input class="field num" type="number" min="2" max="600" data-num="autosaveSeconds" value="${c.config.autosaveSeconds}"> 秒`) +
      item("1 日 1 回自動でコミットする", "ワークスペースに変更があれば git add -A して「Autosave 日付」でコミットする。手動では Git のパネルか ⌘⇧K", toggle("autoCommit", c.config.autoCommit)) +
      Object.entries(c.config.lastAutoCommit)
        .map(([w, d]) => item(`最後の自動コミット：${esc(basename(w))}`, esc(rel("", w)), esc(d)))
        .join(""),
    onClick: async (el, c) => {
      if (el.closest<HTMLElement>("[data-toggle]")?.dataset.toggle !== "autoCommit") return false;
      c.config.autoCommit = !c.config.autoCommit;
      await c.saveConfig();
      return true;
    },
    onChange: async (el, c) => {
      if (el.dataset.num !== "autosaveSeconds") return false;
      c.config.autosaveSeconds = Number(el.value);
      await c.saveConfig();
      schedule();
      return true;
    },
  });
};

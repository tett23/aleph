// Saving and Git (docs/adr/0011, docs/adr/0105).
import { addCommands } from "./commands.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { diffTextHtml, readStructuredDiff } from "./difftab/text.ts";
import { MAX_LINES } from "./difftab/read.ts";
import { esc } from "./esc.ts";
import { autosaveMessage, shouldAutoCommit, ymd } from "./git.ts";
import { gitFailure, gitOperation, type GitStatus } from "./git-ipc.ts";
import { askGitCredentials, mountGitSettings, openRepositorySettings, showIdentityRequired, withPullInProgress } from "./git-settings.ts";
import { commitWithIdentity, identityWarningKey, withGitCredentials } from "./git-workflow.ts";
import { icon } from "./icons.ts";
import { basename, rel } from "./path.ts";
import { allDocs, dirty, type State } from "./store.ts";
import { item, toggle } from "./ui/settings.ts";
import { renderWorkspaceBar } from "./ui/shell.ts";
import { reloadTree } from "./ui/tree.ts";
import { mayWrite } from "./watchmount.ts";
import { OPEN_KINDS, kindOf, projectOf } from "./workspace.ts";

const status = new Map<string, GitStatus[]>();
const changedPaths = new Set<string>();
let branch = "";

export const currentBranch = () => branch;

const refreshStatus = async (ws: string) => {
  const entries = await gitOperation(ws, "status", {});
  status.set(ws, entries);
  changedPaths.clear();
  for (const [w, list] of status) for (const e of list) changedPaths.add(`${w}/${e.path}`);
  return entries;
};

const refreshBranch = async (ctx: Ctx, ws: string) => {
  const repo = await gitOperation(ws, "repository", {}).catch(() => null);
  if (ctx.store.get().workspace !== ws) return;
  branch = repo?.branch ?? "";
  if (document.querySelector(".workspace-bar")) renderWorkspaceBar(document.body, ctx.store.get(), branch);
};

export const committed: ((ws: string) => void)[] = [];

const warned = new Set<string>();
const reportFailure = (ctx: Ctx, ws: string, error: unknown, automatic = false) => {
  const fail = gitFailure(error);
  if (fail.kind === "identityRequired") {
    const repository = fail.repository ?? ws;
    const missing = fail.missing ?? ["name", "email"];
    if (!automatic) return showIdentityRequired(ctx, ws, repository, missing);
    const key = identityWarningKey({ repository, identityTarget: fail.identityTarget, missing });
    if (warned.has(key)) return;
    warned.add(key);
  }
  ctx.notify({ message: fail.message, level: "error", sticky: true });
};

/** Check the author before saving any sheets, then stage and commit in Rust. */
export const commit = async (ctx: Ctx, ws: string, message: string, opts: { here?: boolean; automatic?: boolean } = {}): Promise<boolean> => {
  let result;
  try {
    result = await commitWithIdentity(async () => {
      const identity = await gitOperation(ws, "identity", {});
      if (!identity) throw { kind: "read", message: "Git のリポジトリではありません" };
      if (identity.missing.length) throw {
        kind: "identityRequired", message: "Git の名前とメールアドレスを設定してください",
        repository: identity.repository?.root, identityTarget: identity.target, missing: identity.missing,
      };
      if (opts.automatic && identity.repository?.conflicted) throw {
        kind: "conflict", message: "競合を解消して手動でコミットしてください",
      };
    }, () => ctx.save(opts.here ? allDocs(ctx.store.get()).filter((d) => d.workspace === ws).map((d) => d.path) : undefined),
    () => gitOperation(ws, "commit", { message, automatic: !!opts.automatic, scope: opts.here ? "workspace" : "repository" }));
  } catch (error) {
    reportFailure(ctx, ws, error, opts.automatic);
    return false;
  }
  if (!result) {
    if (!opts.automatic) ctx.toast("コミットする変更はありません");
    return false;
  }
  for (const d of allDocs(ctx.store.get())) if (d.workspace === ws) ctx.editors.get(d.path)?.refreshMarks(true);
  await refreshStatus(ws).catch(() => {});
  ctx.refresh(["sidebar"]);
  committed.forEach((f) => f(ws));
  return true;
};

const autoCommit = async (ctx: Ctx) => {
  if (!ctx.config.autoCommit) return;
  const now = new Date();
  for (const ws of ctx.config.workspaces) {
    try {
      const repo = await gitOperation(ws, "repository", {});
      if (!repo || repo.conflicted) continue;
      const entries = await refreshStatus(ws);
      const changed = entries.length > 0 || allDocs(ctx.store.get()).some((d) => d.workspace === ws && dirty(d));
      if (!shouldAutoCommit({ today: ymd(now), last: ctx.config.lastAutoCommit[ws], changed, enabled: ctx.config.autoCommit })) continue;
      if (await commit(ctx, ws, autosaveMessage(now), { automatic: true })) {
        ctx.config.lastAutoCommit[ws] = ymd(now);
        await ctx.saveConfig();
        ctx.toast(`${basename(ws)} を自動でコミットしました`);
      }
    } catch (error) {
      reportFailure(ctx, ws, error, true);
    }
  }
  ctx.refresh(["sidebar"]);
};

let selected: string | null = null;
let message = "";
let panelGeneration = 0;

const drawPanel = async (el: HTMLElement, ctx: Ctx) => {
  const ws = ctx.store.get().workspace;
  const generation = ++panelGeneration;
  const stale = () => generation !== panelGeneration || ctx.store.get().workspace !== ws;
  if (!ws) return void (el.innerHTML = '<div class="sec"><div class="muted">ワークスペースがありません。</div></div>');
  try {
    const repo = await gitOperation(ws, "repository", {});
    if (stale()) return;
    if (!repo) return void (el.innerHTML = `<div class="sec"><div class="muted">${esc(basename(ws))} は Git のリポジトリではありません。</div><div class="row"><button type="button" class="btn" data-a="init">初期化する</button></div></div>`);
    const files = await refreshStatus(ws);
    if (stale()) return;
    const entry = files.find((f) => f.path === selected);
    if (!entry) selected = null;
    const [log, diff] = await Promise.all([
      gitOperation(ws, "history", {}),
      entry ? gitOperation(ws, "diff", { path: entry.path, from: entry.from ?? undefined }) : undefined,
    ]);
    if (stale()) return;
    const view = diff?.body === "lines" ? readStructuredDiff(diff, MAX_LINES) : undefined;
    el.innerHTML = `<div class="git">
      <div class="sec"><button type="button" class="iconbtn git-panel-settings" title="Git 設定を開く" aria-label="Git 設定を開く" data-a="settings">${icon("settings", 14)}</button>
        <h5>${esc(basename(ws))} <small>${icon("git-branch", 12)} ${esc(repo.branch ?? "")}</small></h5>
        ${files.length ? files.map((f) => `<div class="file ${selected === f.path ? "on" : ""}" data-f="${esc(f.path)}" title="${esc(f.path)}">${icon("file-text", 13)}<span>${esc(f.path)}</span><span class="st">${esc(f.xy.trim())}</span></div>`).join("") : '<div class="muted">変更はありません</div>'}
        ${repo.conflicted ? '<p class="ng">競合を解消して手動でコミットしてください。</p>' : ""}
        <textarea class="soft commitmsg" placeholder="コミットメッセージ（⌘↩ でコミット）">${esc(message)}</textarea>
        <div class="row"><button type="button" class="btn pri" data-a="commit">コミット</button><button type="button" class="btn" data-a="push">push</button><button type="button" class="btn" data-a="pull">pull</button><button type="button" class="btn" data-a="refresh" title="読みなおす">${icon("refresh-cw", 12)}</button></div>
        ${view ? `<pre>${diffTextHtml(view.lines)}</pre>${view.moreLines ? `<small>ほか ${view.moreLines} 行</small>` : ""}` :
          diff ? `<p class="muted">${diff.body === "binary" ? "バイナリ" : diff.body === "folder" ? "フォルダ" : "差分はありません"}</p>` : ""}
      </div>
      <div class="sec log"><h5>履歴</h5>${log.map(({ id, summary }) => `<div title="${esc(id)}"><b>${esc(id.slice(0, 7))}</b>${esc(summary)}</div>`).join("")}</div></div>`;
  } catch (error) {
    if (!stale()) el.innerHTML = `<div class="sec"><div class="ng">${esc(gitFailure(error).message)}</div><button type="button" class="btn" data-a="refresh">読みなおす</button></div>`;
  }
};

const run = async (el: HTMLElement | null, ctx: Ctx, a: string, opener?: HTMLElement) => {
  const ws = ctx.store.get().workspace;
  if (!ws) return;
  if (a === "settings") return openRepositorySettings(ctx, ws, ctx.projects.includes(ws) ? ws : projectOf(ws, ctx.projects) ?? undefined, opener);
  if (a === "commit") {
    if (!message.trim()) return ctx.toast("コミットメッセージを書いてください");
    if (!(await commit(ctx, ws, message))) return;
    message = "";
    ctx.toast("コミットしました");
  } else if (a === "init" || a === "push" || a === "pull") {
    try {
      if (a === "init") {
        await gitOperation(ws, "initialize", {});
        await refreshBranch(ctx, ws);
      } else {
        const repo = await gitOperation(ws, "repository", {});
        if (!repo) throw { kind: "read", message: "Git のリポジトリではありません" };
        await withGitCredentials(async (credentials) => {
          const current = await gitOperation(ws, "repository", {});
          if (current?.gitDir !== repo.gitDir || current.branch !== repo.branch) {
            throw { kind: "targetChanged", message: "対象のリポジトリかブランチが変わりました" };
          }
          if (ctx.store.get().workspace !== ws) throw { kind: "targetChanged", message: "対象のワークスペースが変わりました" };
          const operate = () => gitOperation(ws, a, { credentials });
          if (a === "push") return operate();
          return withPullInProgress(ctx, async () => {
            const edits = allDocs(ctx.store.get()).filter(dirty);
            const workspaces = new Set(edits.flatMap((d) => d.workspace ? [d.workspace] : []));
            const elsewhere = await Promise.all([...workspaces].filter((path) => path !== ws)
              .map((path) => gitOperation(path, "repository", {}).catch(() => null)));
            if (edits.some((d) => d.workspace === ws || d.path.startsWith(repo.root + "/")) ||
                elsewhere.some((repository) => repository?.gitDir === repo.gitDir)) {
              throw { kind: "dirty", message: "未保存のシートがあります。保存してから pull してください" };
            }
            return operate();
          });
        }, () => askGitCredentials(ctx));
        if (a === "pull") {
          ctx.gitChanged.forEach((f) => f());
          await reloadTree(ctx);
        }
      }
      ctx.toast("完了しました");
    } catch (error) {
      reportFailure(ctx, ws, error);
      if (gitFailure(error).kind === "conflict") ctx.gitChanged.forEach((f) => f());
      return;
    }
  }
  if (el && ctx.store.get().workspace === ws) await drawPanel(el, ctx);
};

/** push and pull from the command palette: the Git panel shows the result. */
const gitCommand = async (ctx: Ctx, a: "push" | "pull") => {
  const s = ctx.store.get();
  if (!s.showSidebar || s.sidebarPanel !== "git") ctx.store.dispatch({ type: "sidebarPanel", panel: "git" });
  const el = document.querySelector<HTMLElement>(".git")?.parentElement;
  await run(el ?? null, ctx, a);
};

/** ⌘⇧K: the Git panel with the message field focused. */
const startCommit = (ctx: Ctx) => {
  const s = ctx.store.get();
  if (!s.showSidebar || s.sidebarPanel !== "git") ctx.store.dispatch({ type: "sidebarPanel", panel: "git" });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>(".git .commitmsg")?.focus(), 150);
};

export const mountGit = (ctx: Ctx) => {
  mountGitSettings(ctx);
  ctx.sidebar.git = {
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
        await run(el, ctx, t.dataset.a!, t);
      };
    },
  };

  // a mark on files with changes not committed
  ctx.decor.push((p) => (changedPaths.has(p) ? `<span class="dot" title="コミットしていない変更"></span>` : ""));

  addCommands(ctx.commands, 
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
    for (const d of allDocs(prev))
      if (dirty(d) && !allDocs(s).some((x) => x.path === d.path)) void mayWrite(ctx, d, false).then((ok) => (ok ? api.writeText(d.path, d.text) : undefined));
    const saved = allDocs(s).some((d) => allDocs(prev).find((x) => x.path === d.path && x.saved !== d.saved));
    if (saved && s.workspace) {
      clearTimeout(statusTimer);
      statusTimer = window.setTimeout(() => void refreshStatus(s.workspace!).catch(() => {}).then(() => ctx.refresh(["sidebar"])), 500);
    }
    if (s.workspace !== prev.workspace && s.workspace) void refreshBranch(ctx, s.workspace).then(() => refreshStatus(s.workspace!).catch(() => {})).then(() => ctx.refresh(["sidebar"]));
  });

  // quitting: save first (the menu's Quit, ⌘Q, asks through the Rust side; the window's close button here)
  void listen("aleph:quit", async () => {
    await ctx.save().catch(() => {});
    await invoke("quit");
  });
  void getCurrentWindow().onCloseRequested(async () => {
    await ctx.save().catch(() => {});
  });

  // Refresh after a repository change.
  ctx.gitChanged.push(() => {
    for (const d of allDocs(ctx.store.get())) ctx.editors.get(d.path)?.refreshMarks(true);
    const w = ctx.store.get().workspace;
    if (w) void refreshBranch(ctx, w).then(() => refreshStatus(w).catch(() => {})).then(() => ctx.refresh(["sidebar"]));
    else ctx.refresh(["sidebar"]);
  });

  // Check at startup and every hour.
  void autoCommit(ctx);
  setInterval(() => void autoCommit(ctx), 60 * 60 * 1000);
  const ws = ctx.store.get().workspace;
  if (ws) void refreshBranch(ctx, ws).then(() => refreshStatus(ws).catch(() => {})).then(() => ctx.refresh(["sidebar"]));

  ctx.settings.push({
    id: "saving",
    label: "保存と Git",
    group: "オプション",
    render: (c) =>
      item("自動保存の間隔", "変更のあるシートを保存する間隔（既定 10 秒）", `<input class="field num" type="number" min="2" max="600" data-num="autosaveSeconds" value="${c.config.autosaveSeconds}"> 秒`) +
      item("1 日 1 回自動でコミットする", "ワークスペースに変更があればステージして「Autosave 日付」でコミットする。手動では Git のパネルか ⌘⇧K", toggle("autoCommit", c.config.autoCommit)) +
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

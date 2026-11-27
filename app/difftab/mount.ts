import { activeSnapshot, drawSnapshot } from "./snapshot-view.ts";
// The diff tab (docs/adr/0088): the workspace's changes against the last commit (HEAD), read while
// the tab is shown in its pane, and the command view.diff that shows it. Also what runs before the
// assistant's edit is applied: the decision, the modal dialogs and the commit. That function is
// exported for the assistant's tab of docs/adr/0081, which will call it before its "適用".
import { addCommands } from "../commands.ts";
import type { Ctx } from "../ctx.ts";
import { esc } from "../esc.ts";
import { commit, committed } from "../gitpanel.ts";
import { icon } from "../icons.ts";
import { basename } from "../path.ts";
import { allDocs, diffAvailable, dirty, type Doc } from "../store.ts";
import { gitFailure, gitOperation, type GitDiff } from "../git-ipc.ts";
import { opensOnClick } from "../workspace.ts";
import { applyDecision, commitMessage, hasChanges } from "./apply.ts";
import { commitBeforeApplyDialog, irreversibleApplyDialog } from "./modal.ts";
import { diffTextHtml } from "./text.ts";
import { MAX_FILES, diffFiles, folderEntry, type DiffFile } from "./read.ts";

/** The diffs read at the same time, at most. */
const PARALLEL = 4;


/** Runs `f` on each item, at most `n` at a time, keeping the order of the results. */
const pool = async <T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
};

const fileHtml = (f: DiffFile) => {
  const name = f.openable && opensOnClick(f.path) ? `<span class="dname link" data-open="${esc(f.path)}" title="開く">${esc(f.path)}</span>` : `<span class="dname">${esc(f.path)}</span>`;
  const from = f.from !== undefined ? `<small>${esc(f.from)} から</small>` : "";
  const counts = f.body === "lines" ? `<span class="dstat"><span class="d-add">+${f.added}</span> <span class="d-del">−${f.removed}</span></span>` : "";
  const body =
    f.body === "lines"
      ? `<pre>${diffTextHtml(f.lines)}</pre>${f.moreLines ? `<div class="muted dmore">ほか ${f.moreLines} 行</div>` : ""}`
      : `<div class="muted dnote">${f.body === "binary" ? "バイナリ" : f.body === "folder" ? "フォルダ" : "差分はありません"}</div>`;
  return `<section class="dfile"><div class="dfhead">${icon("file-text", 13)}${name}${from}<span class="dkind">${esc(f.kind)}</span>${counts}</div>${body}</section>`;
};

const headHtml = (ws: string, count: number | null, noHead: boolean) =>
  `<span class="dws">${esc(basename(ws))}</span><span>HEAD との差分</span>${count !== null ? `<small>${count} ファイル</small>` : ""}${
    noHead ? `<small>コミットはまだありません</small>` : ""
  }<span class="sp"></span><span class="btn small" data-diff-reload title="読みなおす">${icon("refresh-cw", 12)} 再読み込み</span>`;

/** The latest reading: a reading started later makes the results of the one before it thrown away. */
let generation = 0;

/** Reads the workspace's diff against HEAD and draws the diff tab's head and body. */
const load = async (ctx: Ctx, head: HTMLElement, body: HTMLElement) => {
  const mine = ++generation;
  head.classList.remove("snapshot-head");
  const stale = () => mine !== generation;
  const ws = ctx.store.get().workspace;
  const line = (text: string) => void (body.innerHTML = `<div class="muted dline">${esc(text)}</div>`);
  head.onclick = (e) => {
    if (e.button === 0 && (e.target as HTMLElement).closest("[data-diff-reload]")) void load(ctx, head, body);
  };
  body.onclick = (e) => {
    const p = (e.target as HTMLElement).closest<HTMLElement>("[data-open]")?.dataset.open;
    const w = ctx.store.get().workspace;
    // opened as from the tree: ⌥ for a new tab (docs/adr/0024)
    if (e.button === 0 && p && w) void ctx.open([`${w}/${p}`], undefined, { newTab: e.altKey });
  };
  if (!ws) return void ((head.innerHTML = ""), line("ワークスペースがありません。"));
  const result = await (async () => {
    const repo = await gitOperation(ws, "repository", {});
    if (!repo) return { issue: `${basename(ws)} は Git のリポジトリではありません。` };
    const entries = await gitOperation(ws, "status", {});
    const diffs = new Map<string, GitDiff>();
    await pool(entries.slice(0, MAX_FILES), PARALLEL, async (entry) => {
      if (!folderEntry(entry) && !stale()) {
        diffs.set(entry.path, await gitOperation(ws, "diff", { path: entry.path, from: entry.from ?? undefined }));
      }
    });
    return { entries, repo, ...diffFiles(entries, diffs) };
  })().catch((e) => ({ issue: gitFailure(e).message }));
  if (stale()) return;
  if ("issue" in result) {
    head.innerHTML = headHtml(ws, null, false);
    return line(result.issue ?? "差分を読み込めません");
  }
  const { files, moreFiles, entries, repo } = result;
  head.innerHTML = headHtml(ws, entries.length, !repo.hasHead);
  if (!files.length) return line("HEAD との差分はありません");
  body.innerHTML = files.map(fileHtml).join("") + (moreFiles ? `<div class="muted dmore">ほか ${moreFiles} ファイル</div>` : "");
};

/** The diff tab shown in its pane, read again; nothing when it is not shown. */
const reloadShown = (ctx: Ctx) => {
  if (activeSnapshot(ctx.store.get())) return;
  const el = document.querySelector<HTMLElement>(".tabview.diff-tab:not([hidden])");
  if (el) ctx.view.diffTab?.(el.querySelector<HTMLElement>(".dhead")!, el.querySelector<HTMLElement>(".dbody")!, ctx);
};

export const mountDiffTab = (ctx: Ctx) => {
  ctx.view.diffTab = (head, body) => {
    const snapshot = activeSnapshot(ctx.store.get());
    if (snapshot) {
      generation++;
      drawSnapshot(ctx, head, body, snapshot);
    } else {
      void load(ctx, head, body);
    }
  };

  addCommands(ctx.commands, { id: "view.diff", label: "差分", icon: "git-compare", when: diffAvailable, run: (c) => c.store.dispatch({ type: "showDiff" }) });

  // read again when Git's state changes while the tab is shown: a save, a commit, FSEvents (docs/adr/0063)
  ctx.gitChanged.push(() => reloadShown(ctx));
  committed.push(() => reloadShown(ctx));
  let timer = 0;
  ctx.store.subscribe((s, prev) => {
    const saved = allDocs(s).some((d) => allDocs(prev).find((x) => x.path === d.path && x.saved !== d.saved));
    if (!saved) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => reloadShown(ctx), 500);
  });
};

/**
 * Run before the assistant's edit is applied, once the edit was found to fit the text (docs/adr/0088):
 * decides which dialog to show, shows it, and commits the workspace's changes when asked. Resolves to
 * "apply" to apply, "cancel" to leave the edit as it is, or "unapplicable" when, after the commit,
 * the edit no longer fits (`applicable` checks that again); the caller then gives the reason as before.
 */
export const prepareApply = async (ctx: Ctx, doc: Doc, applicable: () => boolean): Promise<"apply" | "cancel" | "unapplicable"> => {
  const ws = ctx.store.get().workspace;
  const repo = ws ? await gitOperation(ws, "repository", {}).catch(() => null) : null;
  let changed: boolean | null = null;
  if (ws && repo) {
    const entries = await gitOperation(ws, "status", {}).catch(() => null);
    const unsaved = allDocs(ctx.store.get()).filter((d) => d.workspace === ws && dirty(d)).length;
    if (entries) changed = hasChanges(unsaved, entries.length);
  }
  const decision = applyDecision({ git: true, repo: !!repo, inWorkspace: !!ws && doc.workspace === ws, changed });
  if (decision === "apply") return "apply";
  if (decision === "irreversible") return (await irreversibleApplyDialog(ctx.store)) === "apply" ? "apply" : "cancel";
  const answer = await commitBeforeApplyDialog(ctx.store);
  if (answer !== "commit") return answer;
  // the dialog is closed; the workspace's sheets are saved and its changes alone committed; a failure is notified
  if (!(await commit(ctx, ws!, commitMessage(new Date()), { here: true }))) return "cancel";
  return applicable() ? "apply" : "unapplicable";
};

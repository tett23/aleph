// Files changed outside (docs/adr/0063): the FSEvents batches from Rust, the check before
// each save, and what an open sheet does when its file changed or went: reload, take
// both sides' changes in, or stop saving and ask, in words that need no Git.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { merge3, resolve } from "./merge3.ts";
import { basename } from "./path.ts";
import { allDocs, type Doc } from "./store.ts";
import { choiceDialog, confirmDialog } from "./ui/dom.ts";
import { settleConflicts } from "./ui/mergedialog.ts";
import { notifications } from "./ui/notices.ts";
import { reloadTree } from "./ui/tree.ts";
import { classifyChange, saveCheck } from "./watch.ts";
import { TEXT_KINDS } from "./workspace.ts";

/** Sheets whose saves are stopped until the writer chooses: a conflict with the disk, or the file gone. */
const stopped = new Map<string, "conflict" | "gone">();
const keyOf = (path: string) => `external:${path}`;

const readDisk = async (path: string): Promise<string | null> => ((await api.exists(path)) ? api.readText(path).catch(() => null) : null);
const docOf = (ctx: Ctx, path: string) => allDocs(ctx.store.get()).find((d) => d.path === path);
const textOf = (ctx: Ctx, d: Doc) => ctx.editors.get(d.path)?.text() ?? d.text;

const clear = (path: string) => {
  stopped.delete(path);
  notifications().dismissKey(keyOf(path));
};

export const finishWrite = (path: string) => {
  if (stopped.has(path)) clear(path);
};

/** Puts `text` in the sheet (one edit, caret kept) and makes `saved` the disk's. */
const put = (ctx: Ctx, d: Doc, text: string, disk: string) => {
  const ed = ctx.editors.get(d.path);
  if (ed?.fromOutside) ed.fromOutside(text);
  else if (ed) ed.setText(text);
  else ctx.store.dispatch({ type: "edit", path: d.path, text });
  ctx.store.dispatch({ type: "saved", path: d.path, text: disk });
};

const write = async (ctx: Ctx, path: string, text: string) => {
  await api.writeText(path, text);
  ctx.store.dispatch({ type: "saved", path, text });
  clear(path);
};

/** The disk's text in place of Aleph's changes (⌘Z brings them back). */
const useDisk = async (ctx: Ctx, path: string) => {
  const d = docOf(ctx, path);
  const disk = await readDisk(path);
  if (!d || disk === null) return;
  put(ctx, d, disk, disk);
  clear(path);
};

const confirmOverwrite = (path: string) => confirmDialog(`${basename(path)} を Aleph の内容で上書きします。ほかのアプリでの変更はなくなります`, "上書きする");

/** Aleph's text written over the disk's, after asking. */
const overwrite = async (ctx: Ctx, path: string) => {
  const d = docOf(ctx, path);
  if (!d || !(await confirmOverwrite(path))) return;
  await write(ctx, path, textOf(ctx, d));
};

/** The screen to settle the conflicts, on the disk's text as it is now. */
const settle = async (ctx: Ctx, path: string) => {
  const d = docOf(ctx, path);
  const disk = await readDisk(path);
  if (!d || disk === null) return;
  const m = merge3(d.saved, textOf(ctx, d), disk);
  const text = m.conflicts ? await settleConflicts(basename(path), m.chunks) : resolve(m.chunks, []);
  if (text === null) return;
  put(ctx, d, text, disk);
  clear(path);
};

const closeSheet = (ctx: Ctx, path: string) => {
  clear(path);
  const s = ctx.store.get();
  s.panes.forEach((p, pi) =>
    p.tabs.forEach((t, ti) => {
      if (t.open.some((x) => x.path === path)) ctx.store.dispatch({ type: "closeTab", pane: pi, index: ti });
    }),
  );
};

/** What an open sheet does now that its file changed or went. */
export const followChange = async (ctx: Ctx, path: string) => {
  const d = docOf(ctx, path);
  if (!d) return;
  const name = basename(path);
  // a view of a file (PDF, images) is drawn again
  if (!TEXT_KINDS.includes(d.kind)) {
    if (await api.exists(path)) ctx.editors.get(path)?.reload?.();
    return;
  }
  const disk = await readDisk(path);
  const text = textOf(ctx, d);
  const c = classifyChange({ saved: d.saved, text, disk });
  if (c === "none") {
    // back as it was saved (a stopped sheet whose file came back)
    if (stopped.has(path)) clear(path);
    return;
  }
  if (c === "gone") {
    stopped.set(path, "gone");
    ctx.notify({
      level: "warning",
      sticky: true,
      key: keyOf(path),
      message: `${name} がディスクにありません（ほかのアプリで消されたか、名前が変えられました）。保存は止めています。`,
      actions: [
        { label: "閉じる", run: () => closeSheet(ctx, path) },
        { label: "この内容で作りなおす", primary: true, run: () => void write(ctx, path, textOf(ctx, docOf(ctx, path) ?? d)) },
      ],
    });
    return;
  }
  if (c === "reload") {
    clear(path);
    put(ctx, d, disk!, disk!);
    ctx.toast(`ほかのアプリで変更されたので読み込みなおしました：${name}`);
    return;
  }
  const m = merge3(d.saved, text, disk!);
  if (!m.conflicts) {
    clear(path);
    put(ctx, d, resolve(m.chunks, []), disk!);
    ctx.notify({
      message: `ほかのアプリでの変更を取り込みました：${name}。Aleph での変更も残っています`,
      actions: [{ label: "元に戻す", run: () => void ctx.editors.get(path)?.edit?.command("editor.undo") }],
    });
    return;
  }
  stopped.set(path, "conflict");
  ctx.notify({
    level: "warning",
    sticky: true,
    key: keyOf(path),
    message: `${name} がほかのアプリで変更され、Aleph での変更と ${m.conflicts} か所で食い違っています。保存は止めています。`,
    actions: [
      { label: "ほかのアプリの内容にする", run: () => void useDisk(ctx, path) },
      { label: "Aleph の内容で上書きする", run: () => void overwrite(ctx, path) },
      { label: "食い違いを直す", primary: true, run: () => void settle(ctx, path) },
    ],
  });
};

/**
 * Before a save writes `text`: true when the disk still has what was last read or written. Otherwise the change
 * is followed (reload, merge, or a stop), and nothing is written. A stopped sheet is not written; ⌘S asks.
 */
export const mayWrite = async (ctx: Ctx, d: Doc, explicit: boolean): Promise<boolean> => {
  const why = stopped.get(d.path);
  if (why) {
    if (!explicit) return false;
    const name = basename(d.path);
    if (why === "gone") {
      return confirmDialog(`${name} はディスクにありません。この内容で作りなおします`, "作りなおす");
    }
    const i = await choiceDialog(`${name} の保存は止めています`, "ほかのアプリでの変更と食い違っています。どうしますか。", ["ほかのアプリの内容にする", "Aleph の内容で上書きする", "食い違いを直す"]);
    if (i === 0) await useDisk(ctx, d.path);
    if (i === 1) return confirmOverwrite(d.path);
    if (i === 2) await settle(ctx, d.path);
    return false;
  }
  const disk = await readDisk(d.path);
  if (saveCheck({ saved: d.saved, disk }) === "write") return true;
  await followChange(ctx, d.path);
  return false;
};

export const mountWatch = (ctx: Ctx) => {
  let watching = false;
  let roots = "";
  const watch = async () => {
    const now = JSON.stringify([ctx.config.workspaces, ctx.config.libraryDir]);
    if (now === roots) return;
    roots = now;
    watching = await api.watchRoots().catch(() => false);
    if (!watching && ctx.config.workspaces.length) ctx.notify({ level: "warning", message: "ファイルの変更の見張りを始められませんでした。ウィンドウに戻ったときに確かめます" });
  };
  void watch();
  // the workspaces or the shared library changed
  ctx.store.subscribe((s, prev) => {
    if (s.workspaces !== prev.workspaces) void watch();
  });

  let treeTimer = 0;
  let gitTimer = 0;
  const under = (path: string, dirs: string[]) => dirs.some((d) => path === d || path.startsWith(`${d}/`));
  void listen<{ paths: string[]; git: boolean; rescan: string[] }>("aleph:fs", (e) => {
    const { paths, git, rescan } = e.payload;
    for (const d of allDocs(ctx.store.get())) if (paths.includes(d.path) || under(d.path, rescan)) void followChange(ctx, d.path);
    if (paths.length || rescan.length) {
      clearTimeout(treeTimer);
      treeTimer = window.setTimeout(() => void reloadTree(ctx).then(() => ctx.refresh(["left"])), 500);
    }
    if (git) {
      clearTimeout(gitTimer);
      gitTimer = window.setTimeout(() => ctx.gitChanged.forEach((f) => f()), 300);
    }
  });

  // without the watch, the open sheets are checked when the window comes back to the front
  void getCurrentWindow()
    .onFocusChanged(({ payload }) => {
      if (payload && !watching) for (const d of allDocs(ctx.store.get())) void followChange(ctx, d.path);
    })
    .catch(() => {});
};

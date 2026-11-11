// The keys (docs/adr/0034): one dispatcher for the window and the editors, the
// sequence shown in the status bar while it waits, and the settings section
// where the bindings and the leader key are changed. The rules are in keymap.ts.
import { keyedCommands, keyLabel, type Command } from "./commands.ts";
import type { Ctx } from "./ctx.ts";
import { isMac } from "./ed/keys.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import {
  allowedContexts, bindingContext, bindingKey, canonical, cleanBindings, conflicts, effectiveBindings,
  expire, overlapKey, overlaps, press, readBinding, reservedKey, setBinding, strokeOf, takeAway,
  unusableFirst, writtenBinding, type Binding, type BindingContext, type Bound, type KeyContext,
  type Pending, type Stroke,
} from "./keymap.ts";
import { runCommand } from "./palette.ts";
import { focused } from "./store.ts";
import { choiceDialog, confirmDialog } from "./ui/dom.ts";
import { item } from "./ui/settings.ts";

let pending: Pending = null;
let pendingCandidates: Bound[] = [];
let timer = 0;
const seen = new WeakSet<Event>();

/** A command's bindings now: the user's, or its defaults. */
export const bindingsOf = (ctx: Ctx, c: Command): Binding[] => ctx.config.keyBindings[c.id] ?? c.keys ?? [];

/** A binding as shown (the leader key in place of Leader). */
const labelOf = (ctx: Ctx, b: Binding) => {
  const s = readBinding(b, ctx.config.leaderKey);
  return s ? keyLabel(s.join(" ")) : bindingKey(b);
};

/** The label of a command's first binding, for the menu and the palette. */
export const hintOf = (ctx: Ctx, c: Command) => {
  const b = bindingsOf(ctx, c)[0];
  return b ? labelOf(ctx, b) : undefined;
};

const tableFor = (ctx: Ctx, editorFocused: boolean) =>
  effectiveBindings(keyedCommands(ctx.commands, ctx.store.get(), editorFocused), ctx.config.keyBindings, ctx.config.leaderKey);

/** The completion state when the stroke starts, before its command changes it. */
const contextFor = (ctx: Ctx, editorFocused: boolean): KeyContext => {
  if (!editorFocused) return "outside";
  const path = focused(ctx.store.get())?.path;
  return path && ctx.editors.get(path)?.edit?.completionVisible() ? "completionVisible" : "completionHidden";
};

const editorHasFocus = (ctx: Ctx) =>
  typeof document !== "undefined" && [...ctx.editors.values()].some((editor) => editor.edit?.view.content === document.activeElement);

const candidatesFor = (table: Bound[], strokes: Stroke[], context: KeyContext) =>
  table.filter((binding) => binding.strokes.length >= strokes.length && strokes.every((stroke, i) => stroke === binding.strokes[i]) &&
    (!binding.available || binding.available.includes(context)));

const sameBinding = (a: Bound, b: Bound) =>
  a.id === b.id && a.context === b.context && a.strokes.join(" ") === b.strokes.join(" ");

/** A waiting sequence retains only the candidates that were valid when it began. */
export const keyContextChanged = (ctx: Ctx, editorFocused = editorHasFocus(ctx)) => {
  if (!pending) return;
  const context = contextFor(ctx, editorFocused);
  const current = candidatesFor(tableFor(ctx, editorFocused), pending.strokes, context);
  pendingCandidates = pendingCandidates.filter((previous) => current.some((candidate) => sameBinding(previous, candidate)));
  if (!pendingCandidates.length) setPending(ctx, null);
};

const runIds = (ctx: Ctx, ids: string[]) => {
  for (const id of ids) {
    const c = ctx.commands.find((x) => x.id === id);
    if (c) void runCommand(ctx, c);
  }
};

const setPending = (ctx: Ctx, p: Pending, table: Bound[] = [], context: KeyContext = "outside") => {
  const was = pending;
  pending = p;
  clearTimeout(timer);
  pendingCandidates = p ? candidatesFor(table, p.strokes, context) : [];
  if (p)
    timer = window.setTimeout(() => {
      keyContextChanged(ctx);
      const ids = expire(pendingCandidates, pending);
      setPending(ctx, null);
      runIds(ctx, ids);
    }, ctx.config.keySequenceTimeout);
  if (was !== p) ctx.refresh(["status"]);
};

/**
 * A key press, from an editor (which asks before its own keys) or from the
 * window. Returns true when the key was taken: it ran a command, or it is part
 * of a sequence still waiting.
 */
export const dispatchKey = (ctx: Ctx, e: KeyboardEvent, editorFocused: boolean): boolean => {
  if (seen.has(e)) return false;
  seen.add(e);
  const composing = e.isComposing || e.keyCode === 229;
  if (composing) {
    setPending(ctx, null);
    return false;
  }
  const stroke = strokeOf(e, isMac());
  // a modifier pressed alone keeps a sequence waiting
  if (stroke === null) return false;
  keyContextChanged(ctx, editorFocused);
  const context = contextFor(ctx, editorFocused);
  const full = tableFor(ctx, editorFocused);
  const now = performance.now();
  const timedOut = !!pending && now - pending.at > ctx.config.keySequenceTimeout;
  const expired = timedOut ? expire(pendingCandidates, pending) : [];
  if (timedOut) setPending(ctx, null);
  const st = press(pending ? pendingCandidates : full, pending, stroke, now, ctx.config.keySequenceTimeout, context);
  const next = st.retry ? press(full, null, stroke, now, ctx.config.keySequenceTimeout, context) : st;
  setPending(ctx, next.pending, next.pending && !st.retry && pending ? pendingCandidates : full, context);
  runIds(ctx, [...expired, ...next.run]);
  return next.take;
};

// ---- the settings section ----

const SECTION = "keys";
let filter = "";

/** Records a sequence of strokes: ends after the wait or with ↩, cancelled with Esc. */
const record = (ctx: Ctx, show: (text: string) => void): Promise<Stroke[] | null> =>
  new Promise((resolve) => {
    const strokes: Stroke[] = [];
    let t = 0;
    const done = (v: Stroke[] | null) => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) return done(null);
      if (e.key === "Enter" && strokes.length) return done(strokes);
      const s = strokeOf(e, isMac());
      if (!s) return;
      strokes.push(s);
      show(keyLabel(strokes.join(" ")) + " …");
      clearTimeout(t);
      t = window.setTimeout(() => done(strokes), ctx.config.keySequenceTimeout);
    };
    window.addEventListener("keydown", onKey, true);
  });

/** A recorded sequence as written in config.json: the leader key as Leader. */
const nameOf = (ctx: Ctx, id: string) => ctx.commands.find((c) => c.id === id)?.label ?? id;

/** Why a recorded sequence cannot be used, or null. */
const refusal = (strokes: Stroke[]) =>
  strokes.some(reservedKey) ? "このキーは使えません（アプリのメニューのキーです）" : unusableFirst(strokes[0]) ? "初めのキーには ⌘、⌃、⌥ のどれかを含めるか、ファンクションキーを使ってください" : null;

const saveBindings = async (ctx: Ctx, user: Record<string, Binding[]>) => {
  ctx.config.keyBindings = user;
  await ctx.saveConfig();
};

type Scope = BindingContext | "all";
const contextLabels: Record<Scope, string> = {
  all: "操作の有効範囲全体", editor: "エディタ",
  completionVisible: "サジェスト表示中", completionHidden: "サジェスト非表示",
};

/** Change only after the writer accepts any exact-key replacement. */
const assign = async (ctx: Ctx, c: Command, key: string, scope: Scope, index?: number) => {
  const strokes = readBinding(key, ctx.config.leaderKey);
  if (!strokes || !allowedContexts(c).includes(scope)) return;
  const b: Binding = scope === "all" ? key : { key, context: scope };
  const all = effectiveBindings(ctx.commands, ctx.config.keyBindings, ctx.config.leaderKey);
  const cf = conflicts(all, strokes, c.id, scope, ctx.commands);
  let user = ctx.config.keyBindings;
  if (cf.same.length) {
    if (!(await confirmDialog(`${labelOf(ctx, b)} は「${cf.same.map((id) => nameOf(ctx, id)).join("」「")}」に割り当て済みです。置き換えますか`, "置き換える"))) return;
    user = takeAway(user, ctx.commands, cf.same, strokes, ctx.config.leaderKey, scope, c.id);
  }
  const mine = [...bindingsOf(ctx, c)];
  if (index !== undefined) mine.splice(index, 1);
  const duplicate = mine.some((old) => bindingContext(old) === scope && readBinding(old, ctx.config.leaderKey)?.join(" ") === strokes.join(" "));
  if (!duplicate) mine.splice(index ?? mine.length, 0, b);
  await saveBindings(ctx, setBinding(user, ctx.commands, c.id, mine));
  if (cf.prefix.length) ctx.toast(`「${cf.prefix.map((id) => nameOf(ctx, id)).join("」「")}」と先頭が重なるので、待つ時間が過ぎるまで短いほうは実行されません`);
};

const row = (ctx: Ctx, c: Command, over: Map<string, string[]>) => {
  const user = c.id in ctx.config.keyBindings;
  // a binding that starts another or is started by one (docs/adr/0040)
  const mark = (b: Binding) => {
    const others = over.get(overlapKey(c.id, readBinding(b, ctx.config.leaderKey) ?? [], bindingContext(b)));
    return others
      ? `<span class="kbover" title="「${esc(others.map((id) => nameOf(ctx, id)).join("」「"))}」と先頭が重なります。待つ時間が過ぎるまで短いほうは実行されません">${icon("triangle-alert", 12)}</span>`
      : "";
  };
  const scopes = allowedContexts(c);
  const selector = (b: Binding, i: number) =>
    `<select aria-label="有効範囲" data-kb-context="${esc(c.id)}" data-kb-i="${i}">${scopes.map((scope) =>
      `<option value="${scope}"${bindingContext(b) === scope ? " selected" : ""}>${contextLabels[scope]}</option>`).join("")}</select>`;
  const hasEscape = bindingsOf(ctx, c).some((b) => readBinding(b, ctx.config.leaderKey)?.join(" ") === "Escape");
  const keys = bindingsOf(ctx, c)
    .map((b, i) => `<span class="kb"><kbd>${esc(labelOf(ctx, b))}</kbd>${mark(b)}${selector(b, i)}<span class="iconbtn" data-kb-rm="${esc(c.id)}" data-kb-i="${i}" title="外す">${icon("x", 11)}</span></span>`)
    .join("");
  return `<div class="kbrow" data-kb-row="${esc(c.id)}"><div class="d"><div>${esc(c.label)}</div><small>${esc(c.id)}</small></div><div class="keys">${keys}<span class="btn small" data-kb-add="${esc(c.id)}">＋</span>${c.id === "editor.dismissCompletion" && !hasEscape ? `<span class="btn small" data-kb-escape="${esc(c.id)}">Esc を追加</span>` : ""}${
    user ? `<span class="btn small" data-kb-reset="${esc(c.id)}">既定に戻す</span>` : ""
  }</div></div>`;
};

const renderSection = (ctx: Ctx) => {
  const q = filter.toLowerCase();
  const list = ctx.commands.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  const over = overlaps(effectiveBindings(ctx.commands, ctx.config.keyBindings, ctx.config.leaderKey));
  return (
    item("リーダーキー", `割り当ての Leader をこのキーに読み替えます。今は ${esc(keyLabel(ctx.config.leaderKey))}`, `<span class="btn" data-kb-leader>記録する</span>`) +
    item(
      "続けて押すキーを待つ時間",
      "打鍵の並びの途中で、次のキーを待つミリ秒（200 から 5000）",
      `<input class="field num" type="number" min="200" max="5000" step="100" data-kb-timeout value="${ctx.config.keySequenceTimeout}">`,
    ) +
    `<div class="kbhead"><input class="field" data-kb-filter placeholder="名前で絞り込む" value="${esc(filter)}"><span class="btn" data-kb-resetall>すべて既定に戻す</span></div>` +
    (over.size ? `<div class="kbwarn">${icon("triangle-alert", 12)} 先頭が重なる割り当て：${over.size}</div>` : "") +
    `<div class="kblist">${list.map((c) => row(ctx, c, over)).join("")}</div>`
  );
};

/** Drops the bindings in config.json that name no command; run once every command is registered. */
export const cleanKeyBindings = (ctx: Ctx) => {
  ctx.config.keyBindings = cleanBindings(ctx.config.keyBindings, ctx.commands);
};

/** The window's keys, the status bar item and the settings section (before the palette makes `settings.*` commands). */
export const mountKeybind = (ctx: Ctx) => {
  const focusIsEditor = (target: EventTarget | null) =>
    [...ctx.editors.values()].some((editor) => editor.edit?.view.content === target);
  window.addEventListener("compositionstart", () => setPending(ctx, null));
  window.addEventListener("focusin", (e) => keyContextChanged(ctx, focusIsEditor(e.target)));
  window.addEventListener("focusout", (e) => keyContextChanged(ctx, focusIsEditor(e.relatedTarget)));
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (dispatchKey(ctx, e, false)) e.preventDefault();
  });

  ctx.status.push(() => (pending ? `<span class="keyseq">${esc(keyLabel(pending.strokes.join(" ")))} …</span>` : ""));

  ctx.settings.push({
    id: SECTION,
    label: "キーの割り当て",
    group: "オプション",
    render: renderSection,
    onChange: async (el, c) => {
      if (el.dataset.kbContext) {
        const cmd = c.commands.find((command) => command.id === el.dataset.kbContext);
        const i = Number(el.dataset.kbI);
        const old = cmd && bindingsOf(c, cmd)[i];
        if (cmd && old) await assign(c, cmd, bindingKey(old), el.value as Scope, i);
        return true;
      }
      if (el.matches("[data-kb-filter]")) {
        filter = el.value;
        return true;
      }
      if (el.matches("[data-kb-timeout]")) {
        c.config.keySequenceTimeout = Math.min(5000, Math.max(200, Math.round(Number(el.value) || 1000)));
        await c.saveConfig();
        return true;
      }
      return false;
    },
    onClick: async (el, c) => {
      const t = el.closest<HTMLElement>("[data-kb-add],[data-kb-escape],[data-kb-rm],[data-kb-reset],[data-kb-resetall],[data-kb-leader]");
      if (!t) return false;
      const cmd = (id?: string) => c.commands.find((x) => x.id === id);
      if (t.dataset.kbEscape === "editor.dismissCompletion") {
        const target = cmd(t.dataset.kbEscape);
        if (target) await assign(c, target, "Escape", "all");
        return true;
      }
      if (t.dataset.kbAdd !== undefined) {
        const target = cmd(t.dataset.kbAdd);
        if (!target) return false;
        t.textContent = "キーを押す…";
        const strokes = await record(c, (s) => (t.textContent = s));
        if (!strokes) return true;
        const no = refusal(strokes);
        if (no) { c.toast(no); return true; }
        const scopes = allowedContexts(target);
        const selected = await choiceDialog("ショートカットの有効範囲", keyLabel(strokes.join(" ")), scopes.map((scope) => contextLabels[scope]));
        if (selected !== null) await assign(c, target, writtenBinding(strokes, c.config.leaderKey), scopes[selected]);
        return true;
      }
      if (t.dataset.kbRm !== undefined) {
        const target = cmd(t.dataset.kbRm);
        if (!target) return false;
        const i = Number(t.dataset.kbI);
        await saveBindings(c, setBinding(c.config.keyBindings, c.commands, target.id, bindingsOf(c, target).filter((_, k) => k !== i)));
        return true;
      }
      if (t.dataset.kbReset !== undefined) {
        await saveBindings(c, setBinding(c.config.keyBindings, c.commands, t.dataset.kbReset, null));
        return true;
      }
      if (t.dataset.kbResetall !== undefined) {
        if (!(await confirmDialog("すべての割り当てを既定に戻しますか", "戻す"))) return false;
        c.config.leaderKey = "Mod-;";
        await saveBindings(c, {});
        return true;
      }
      if (t.dataset.kbLeader !== undefined) {
        t.textContent = "キーを押す…";
        const strokes = await record(c, (s) => (t.textContent = s));
        if (!strokes) return true;
        const s = canonical(strokes[0])!;
        if (strokes.length > 1 || refusal([s])) c.toast("リーダーキーは ⌘、⌃、⌥ のどれかを含む一つのキーにしてください");
        else {
          c.config.leaderKey = s;
          await c.saveConfig();
        }
        return true;
      }
      return false;
    },
  });
};

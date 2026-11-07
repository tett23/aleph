// The keys (docs/adr/0034): one dispatcher for the window and the editors, the
// sequence shown in the status bar while it waits, and the settings section
// where the bindings and the leader key are changed. The rules are in keymap.ts.
import { keyedCommands, keyLabel, type Command } from "./commands.ts";
import type { Ctx } from "./ctx.ts";
import { isMac } from "./ed/keys.ts";
import { esc } from "./esc.ts";
import { icon } from "./icons.ts";
import { canonical, cleanBindings, conflicts, effectiveBindings, expire, press, readBinding, reservedKey, setBinding, strokeOf, takeAway, unusableFirst, writtenBinding, type Pending, type Stroke } from "./keymap.ts";
import { runCommand } from "./palette.ts";
import { confirmDialog } from "./ui/dom.ts";
import { item } from "./ui/settings.ts";

let pending: Pending = null;
let timer = 0;
const seen = new WeakSet<Event>();

/** A command's bindings now: the user's, or its defaults. */
export const bindingsOf = (ctx: Ctx, c: Command): string[] => ctx.config.keyBindings[c.id] ?? c.keys ?? [];

/** A binding as shown (the leader key in place of Leader). */
const labelOf = (ctx: Ctx, b: string) => {
  const s = readBinding(b, ctx.config.leaderKey);
  return s ? keyLabel(s.join(" ")) : b;
};

/** The label of a command's first binding, for the menu and the palette. */
export const hintOf = (ctx: Ctx, c: Command) => {
  const b = bindingsOf(ctx, c)[0];
  return b ? labelOf(ctx, b) : undefined;
};

const tableFor = (ctx: Ctx, editorFocused: boolean) =>
  effectiveBindings(keyedCommands(ctx.commands, ctx.store.get(), editorFocused), ctx.config.keyBindings, ctx.config.leaderKey);

const runIds = (ctx: Ctx, ids: string[]) => {
  for (const id of ids) {
    const c = ctx.commands.find((x) => x.id === id);
    if (c) void runCommand(ctx, c);
  }
};

const setPending = (ctx: Ctx, p: Pending, editorFocused: boolean) => {
  const was = pending;
  pending = p;
  clearTimeout(timer);
  if (p)
    timer = window.setTimeout(() => {
      const ids = expire(tableFor(ctx, editorFocused), pending);
      setPending(ctx, null, editorFocused);
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
  const stroke = composing ? null : strokeOf(e, isMac());
  // a modifier pressed alone keeps a sequence waiting
  if (!composing && stroke === null) return false;
  const st = press(tableFor(ctx, editorFocused), pending, stroke, performance.now(), ctx.config.keySequenceTimeout);
  setPending(ctx, st.pending, editorFocused);
  runIds(ctx, st.run);
  return st.take;
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

const saveBindings = async (ctx: Ctx, user: Record<string, string[]>) => {
  ctx.config.keyBindings = user;
  await ctx.saveConfig();
};

/** Adds a recorded binding to a command, after asking about a command that has it already. */
const addBinding = async (ctx: Ctx, c: Command, strokes: Stroke[]) => {
  const no = refusal(strokes);
  if (no) return ctx.toast(no);
  const b = writtenBinding(strokes, ctx.config.leaderKey);
  const all = effectiveBindings(ctx.commands, ctx.config.keyBindings, ctx.config.leaderKey);
  const cf = conflicts(all, readBinding(b, ctx.config.leaderKey)!, c.id);
  let user = ctx.config.keyBindings;
  if (cf.same.length) {
    if (!(await confirmDialog(`${labelOf(ctx, b)} は「${cf.same.map((id) => nameOf(ctx, id)).join("」「")}」に割り当て済みです。置き換えますか`, "置き換える"))) return;
    user = takeAway(user, ctx.commands, cf.same, readBinding(b, ctx.config.leaderKey)!, ctx.config.leaderKey);
  }
  const mine = user[c.id] ?? c.keys ?? [];
  if (!mine.includes(b)) user = setBinding(user, ctx.commands, c.id, [...mine, b]);
  await saveBindings(ctx, user);
  if (cf.prefix.length) ctx.toast(`「${cf.prefix.map((id) => nameOf(ctx, id)).join("」「")}」と先頭が重なるので、待つ時間が過ぎるまで短いほうは実行されません`);
};

const row = (ctx: Ctx, c: Command) => {
  const user = c.id in ctx.config.keyBindings;
  const keys = bindingsOf(ctx, c)
    .map((b, i) => `<span class="kb"><kbd>${esc(labelOf(ctx, b))}</kbd><span class="iconbtn" data-kb-rm="${esc(c.id)}" data-kb-i="${i}" title="外す">${icon("x", 11)}</span></span>`)
    .join("");
  return `<div class="kbrow" data-kb-row="${esc(c.id)}"><div class="d"><div>${esc(c.label)}</div><small>${esc(c.id)}</small></div><div class="keys">${keys}<span class="btn small" data-kb-add="${esc(c.id)}">＋</span>${
    user ? `<span class="btn small" data-kb-reset="${esc(c.id)}">既定に戻す</span>` : ""
  }</div></div>`;
};

const renderSection = (ctx: Ctx) => {
  const q = filter.toLowerCase();
  const list = ctx.commands.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  return (
    item("リーダーキー", `割り当ての Leader をこのキーに読み替えます。今は ${esc(keyLabel(ctx.config.leaderKey))}`, `<span class="btn" data-kb-leader>記録する</span>`) +
    item(
      "続けて押すキーを待つ時間",
      "打鍵の並びの途中で、次のキーを待つミリ秒（200 から 5000）",
      `<input class="field num" type="number" min="200" max="5000" step="100" data-kb-timeout value="${ctx.config.keySequenceTimeout}">`,
    ) +
    `<div class="kbhead"><input class="field" data-kb-filter placeholder="名前で絞り込む" value="${esc(filter)}"><span class="btn" data-kb-resetall>すべて既定に戻す</span></div>` +
    `<div class="kblist">${list.map((c) => row(ctx, c)).join("")}</div>`
  );
};

/** Drops the bindings in config.json that name no command; run once every command is registered. */
export const cleanKeyBindings = (ctx: Ctx) => {
  ctx.config.keyBindings = cleanBindings(ctx.config.keyBindings, new Set(ctx.commands.map((c) => c.id)));
};

/** The window's keys, the status bar item and the settings section (before the palette makes `settings.*` commands). */
export const mountKeybind = (ctx: Ctx) => {
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
      const t = el.closest<HTMLElement>("[data-kb-add],[data-kb-rm],[data-kb-reset],[data-kb-resetall],[data-kb-leader]");
      if (!t) return false;
      const cmd = (id?: string) => c.commands.find((x) => x.id === id);
      if (t.dataset.kbAdd !== undefined) {
        const target = cmd(t.dataset.kbAdd);
        if (!target) return false;
        t.textContent = "キーを押す…";
        const strokes = await record(c, (s) => (t.textContent = s));
        if (strokes) await addBinding(c, target, strokes);
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

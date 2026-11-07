// Key bindings that the user can change (docs/adr/0034): strokes, sequences of
// strokes with a leader key, and the machine that waits for the rest of a
// sequence. Pure, so that it is tested with node --test; the window's keys and
// the settings screen are in keybind.ts.
import type { KeyEvent } from "./ed/keys.ts";

/** One stroke, canonical: the modifiers in the order Mod, Ctrl, Shift, Alt, then the key ("Mod-Shift-k", "g", "F1"). */
export type Stroke = string;
/** A command's binding read into strokes. */
export type Bound = { id: string; strokes: Stroke[] };
/** The strokes pressed so far of a sequence, and when the last one was pressed. */
export type Pending = { strokes: Stroke[]; at: number } | null;

export const DEFAULT_LEADER = "Mod-;";
export const DEFAULT_TIMEOUT = 1000;
export const clampTimeout = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(5000, Math.max(200, Math.round(v))) : DEFAULT_TIMEOUT);

const MODS = ["Mod", "Ctrl", "Shift", "Alt"] as const;

// keys named by their place (KeyboardEvent.code) that print a character
const PUNCT: Record<string, string> = {
  Semicolon: ";", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", BracketLeft: "[", BracketRight: "]",
  Quote: "'", Backquote: "`", Equal: "=", Minus: "Minus", IntlYen: "¥", IntlRo: "_",
};
const MODIFIER_CODES = /^(Meta|Control|Alt|Shift|OS)(Left|Right)?$|^CapsLock$|^Fn$/;

/** The name of a key from its place: "a" for KeyA, "1" for Digit1, ";" for Semicolon, "Tab" for Tab. */
const nameOf = (code: string): string | null => {
  if (MODIFIER_CODES.test(code)) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  return PUNCT[code] ?? (code || null);
};

/** A key press as a stroke; null for a press of a modifier alone. */
export const strokeOf = (e: KeyEvent, mac: boolean): Stroke | null => {
  const name = nameOf(e.code) ?? (e.key && e.key.length === 1 ? e.key.toLowerCase() : null);
  if (!name) return null;
  const on = { Mod: mac ? e.metaKey : e.ctrlKey, Ctrl: mac && e.ctrlKey, Shift: e.shiftKey, Alt: e.altKey };
  return [...MODS.filter((m) => on[m]), name].join("-");
};

/** A stroke written in any order of modifiers ("Shift-Mod-K", "Cmd-s") made canonical; null when unreadable. */
export const canonical = (s: string): Stroke | null => {
  // a "-" key is written "Minus", so splitting on "-" is safe
  const parts = s.split("-");
  const name = parts.pop();
  if (!name) return null;
  const mods = new Set<string>();
  for (const p of parts) {
    const m = p === "Cmd" || p === "Meta" ? "Mod" : p === "Control" ? "Ctrl" : p === "Option" ? "Alt" : p;
    if (!(MODS as readonly string[]).includes(m)) return null;
    mods.add(m);
  }
  return [...MODS.filter((m) => mods.has(m)), name.length === 1 ? name.toLowerCase() : name].join("-");
};

/** A binding ("Mod-k Mod-s", "Leader g c") read into strokes with Leader replaced; null when unreadable. */
export const readBinding = (b: string, leader: Stroke): Stroke[] | null => {
  const words = b.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const strokes = words.map((w) => (w === "Leader" ? leader : canonical(w)));
  return strokes.every((s): s is Stroke => s !== null) ? strokes : null;
};

/**
 * Whether a stroke cannot start a binding: without ⌘, ⌃ or ⌥ it types a
 * character or edits (Enter, Backspace, the arrows), unless it is a function key.
 */
export const unusableFirst = (s: Stroke) => {
  const parts = s.split("-");
  const name = parts.pop()!;
  return !/^F\d{1,2}$/.test(name) && !parts.some((m) => m === "Mod" || m === "Ctrl" || m === "Alt");
};

/** The keys the app's menu owns (Quit, Hide, Minimize, Close, the clipboard, full screen). */
const RESERVED = new Set(["Mod-q", "Mod-w", "Mod-c", "Mod-v", "Mod-x", "Mod-m", "Mod-h", "Mod-Alt-h", "Mod-Ctrl-f"]);
export const reservedKey = (s: Stroke) => RESERVED.has(canonical(s) ?? s);

/** Whether a user binding can be used: its first stroke starts a binding and no stroke is the menu's. */
const usable = (strokes: Stroke[]) => !unusableFirst(strokes[0]) && !strokes.some(reservedKey);

export const leaderOf = (v: unknown): Stroke => {
  const s = typeof v === "string" ? canonical(v) : null;
  return s && !unusableFirst(s) && !reservedKey(s) ? s : DEFAULT_LEADER;
};

type Cmd = { id: string; keys?: string[] };

/** Every command's bindings: the user's where set (an empty list unbinds), the defaults otherwise. */
export const effectiveBindings = (cmds: Cmd[], user: Record<string, string[]>, leader: Stroke): Bound[] =>
  cmds.flatMap((c) => (user[c.id] ?? c.keys ?? []).flatMap((b) => {
    const strokes = readBinding(b, leader);
    return strokes ? [{ id: c.id, strokes }] : [];
  }));

/** The bindings as written in config.json, with unknown ids and bindings that cannot be used dropped. */
export const cleanBindings = (raw: unknown, known: Set<string>): Record<string, string[]> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([id, v]) => {
      if (!known.has(id) || !Array.isArray(v)) return [];
      const ok = v.flatMap((b) => {
        if (typeof b !== "string") return [];
        const words = b.trim().split(/\s+/);
        // checked with the default leader; a Leader stroke is always usable
        const strokes = readBinding(b, DEFAULT_LEADER);
        if (!strokes || !usable(strokes)) return [];
        return [words.map((w) => (w === "Leader" ? w : canonical(w)!)).join(" ")];
      });
      return [[id, ok]];
    }),
  );
};

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The user's bindings after setting a command's (null: back to the default); only what differs from the default is kept. */
export const setBinding = (user: Record<string, string[]>, cmds: Cmd[], id: string, keys: string[] | null): Record<string, string[]> => {
  const { [id]: _, ...rest } = user;
  const def = cmds.find((c) => c.id === id)?.keys ?? [];
  return keys === null || same(keys, def) ? rest : { ...rest, [id]: keys };
};

const startsWith = (long: Stroke[], short: Stroke[]) => short.length < long.length && short.every((s, i) => s === long[i]);

/** The other commands bound to the same strokes, and those whose binding starts this one or starts with it. */
export const conflicts = (bound: Bound[], strokes: Stroke[], id: string) => {
  const others = bound.filter((b) => b.id !== id);
  return {
    same: [...new Set(others.filter((b) => same(b.strokes, strokes)).map((b) => b.id))],
    prefix: [...new Set(others.filter((b) => startsWith(b.strokes, strokes) || startsWith(strokes, b.strokes)).map((b) => b.id))],
  };
};

/** The command an exact sequence names (the first bound, as the registry orders them). */
const exact = (table: Bound[], strokes: Stroke[]) => table.filter((b) => same(b.strokes, strokes)).map((b) => b.id).slice(0, 1);

/** What the waiting sequence runs when the time is up: an exact match, or nothing. */
export const expire = (table: Bound[], pending: Pending): string[] => (pending ? exact(table, pending.strokes) : []);

export type Step = {
  pending: Pending;
  /** The commands to run, in order. */
  run: string[];
  /** Whether the key is taken (not passed to the editor or the input method). */
  take: boolean;
  /** Whether a waiting sequence was dropped by this key (the status bar is cleared). */
  retry: boolean;
};

/**
 * One key press. `stroke` is null for a modifier alone or while the input
 * method composes, which stops the waiting and passes the key on.
 */
export const press = (table: Bound[], pending: Pending, stroke: Stroke | null, now: number, timeout: number): Step => {
  // the time ran out without the timer firing: settle the waiting sequence first
  if (pending && now - pending.at > timeout) {
    const before = expire(table, pending);
    const r = press(table, null, stroke, now, timeout);
    return { ...r, run: [...before, ...r.run] };
  }
  if (stroke === null) return { pending: null, run: [], take: false, retry: false };
  if (pending && stroke === "Escape") return { pending: null, run: [], take: true, retry: false };
  const strokes = pending ? [...pending.strokes, stroke] : [stroke];
  const cands = table.filter((b) => b.strokes.length >= strokes.length && strokes.every((s, i) => s === b.strokes[i]));
  if (!cands.length) {
    if (!pending) return { pending: null, run: [], take: false, retry: false };
    // the sequence is dropped and the key counts on its own
    return { ...press(table, null, stroke, now, timeout), retry: true };
  }
  if (cands.some((b) => b.strokes.length > strokes.length)) return { pending: { strokes, at: now }, run: [], take: true, retry: false };
  return { pending: null, run: exact(table, strokes), take: true, retry: false };
};

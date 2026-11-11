// Key bindings that the user can change (docs/adr/0034): strokes, sequences of
// strokes with a leader key, and the machine that waits for the rest of a
// sequence. Pure, so that it is tested with node --test; the window's keys and
// the settings screen are in keybind.ts.
import type { KeyEvent } from "./ed/keys.ts";

/** One stroke, canonical: the modifiers in the order Mod, Ctrl, Shift, Alt, then the key ("Mod-Shift-k", "g", "F1"). */
export type Stroke = string;
/** A command's binding read into strokes. */
export type BindingContext = "editor" | "completionVisible" | "completionHidden";
export type KeyContext = "outside" | "completionVisible" | "completionHidden";
export type Binding = string | { key: string; context: BindingContext };
export type Bound = { id: string; strokes: Stroke[]; context?: BindingContext; available?: KeyContext[] };
export type Cmd = { id: string; keys?: Binding[]; scope?: "editor"; keyContexts?: readonly BindingContext[] };
export const isBinding = (value: unknown): value is Binding => {
  if (typeof value === "string") return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { key, context } = value as Record<string, unknown>;
  return typeof key === "string" &&
    (context === "editor" || context === "completionVisible" || context === "completionHidden");
};
const ALL_CONTEXTS: KeyContext[] = ["outside", "completionVisible", "completionHidden"];
const EDITOR_CONTEXTS: KeyContext[] = ["completionVisible", "completionHidden"];
export const bindingContext = (binding: Binding): "all" | BindingContext =>
  typeof binding === "string" ? "all" : binding.context;
export const bindingKey = (binding: Binding): string =>
  typeof binding === "string" ? binding : binding.key;
const stateSet = (context: "all" | BindingContext): KeyContext[] =>
  context === "all" ? ALL_CONTEXTS : context === "editor" ? EDITOR_CONTEXTS : [context];
const allowedStates = (command: Cmd | undefined, context: "all" | BindingContext): KeyContext[] => {
  const scope = command?.scope === "editor" ? EDITOR_CONTEXTS : ALL_CONTEXTS;
  const conditions = command?.keyContexts?.length
    ? command.keyContexts.flatMap(stateSet)
    : ALL_CONTEXTS;
  return stateSet(context).filter((state) => scope.includes(state) && conditions.includes(state));
};
export const allowedContexts = (command: Cmd): ("all" | BindingContext)[] =>
  (["all", "editor", "completionVisible", "completionHidden"] as const)
    .filter((context) => allowedStates(command, context).length > 0);
export const overlapKey = (id: string, strokes: Stroke[], context: "all" | BindingContext = "all") =>
  `${id} ${strokes.join(" ")}${context === "all" ? "" : ` @${context}`}`;

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
export const readBinding = (b: Binding, leader: Stroke): Stroke[] | null => {
  const words = bindingKey(b).trim().split(/\s+/).filter(Boolean);
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

/** The keys the app's menu owns (Quit, Hide, Minimize, Close Window, the clipboard, full screen); ⌘W closes a tab (docs/adr/0024). */
const RESERVED = new Set(["Mod-q", "Mod-Shift-w", "Mod-c", "Mod-v", "Mod-x", "Mod-m", "Mod-h", "Mod-Alt-h", "Mod-Ctrl-f"]);
export const reservedKey = (s: Stroke) => RESERVED.has(canonical(s) ?? s);

/** Whether a user binding can be used: its first stroke starts a binding and no stroke is the menu's. */
const usable = (strokes: Stroke[]) => !unusableFirst(strokes[0]) && !strokes.some(reservedKey);

export const leaderOf = (v: unknown): Stroke => {
  const s = typeof v === "string" ? canonical(v) : null;
  return s && !unusableFirst(s) && !reservedKey(s) ? s : DEFAULT_LEADER;
};

/** Every command's bindings: the user's where set (an empty list unbinds), the defaults otherwise. */
export const effectiveBindings = (cmds: Cmd[], user: Record<string, Binding[]>, leader: Stroke): Bound[] =>
  [...cmds].sort((left, right) => Number(right.id in user) - Number(left.id in user))
    .flatMap((command) => (user[command.id] ?? command.keys ?? []).flatMap((binding) => {
    const strokes = readBinding(binding, leader);
    if (!strokes) return [];
    const context = bindingContext(binding);
    const available = allowedStates(command, context);
    return available.length ? [{ id: command.id, strokes, ...(context === "all" ? {} : { context }), available }] : [];
  }));

/** The bindings as written in config.json, with unknown ids and malformed contexts dropped. */
export const cleanBindings = (raw: unknown, known: Set<string> | Cmd[]): Record<string, Binding[]> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const commands = Array.isArray(known) ? known : null;
  const ids: Set<string> = commands ? new Set(commands.map((command) => command.id)) : known as Set<string>;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).flatMap(([id, value]) => {
      if (!ids.has(id) || !Array.isArray(value)) return [];
      const command = commands?.find((candidate) => candidate.id === id);
      const bindings: Binding[] = value.flatMap((item) => {
        if (!isBinding(item)) return [];
        const context = bindingContext(item);
        const key = bindingKey(item);
        const words = key.trim().split(/\s+/);
        const strokes = readBinding(item, DEFAULT_LEADER);
        if (!strokes || (!usable(strokes) && !(id === "editor.dismissCompletion" && strokes.length === 1 && strokes[0] === "Escape")) || !allowedStates(command, context).length)
          return [];
        const canonicalKey = words.map((word) => word === "Leader" ? word : canonical(word)!).join(" ");
        return [typeof item === "string" ? canonicalKey : { key: canonicalKey, context: item.context }];
      });
      return [[id, bindings]];
    }),
  );
};

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameBindings = (a: Binding[], b: Binding[]) =>
  a.length === b.length && a.every((binding, index) =>
    bindingKey(binding) === bindingKey(b[index]) && bindingContext(binding) === bindingContext(b[index]));

/** The user's bindings after setting a command's (null: back to the default); only what differs from the default is kept. */
export const setBinding = (user: Record<string, Binding[]>, cmds: Cmd[], id: string, keys: Binding[] | null): Record<string, Binding[]> => {
  const { [id]: _, ...rest } = user;
  const def = cmds.find((c) => c.id === id)?.keys ?? [];
  return keys === null || sameBindings(keys, def) ? rest : { ...rest, [id]: keys };
};

const startsWith = (long: Stroke[], short: Stroke[]) => short.length < long.length && short.every((s, i) => s === long[i]);

/** The other commands bound to the same strokes, and those whose binding starts this one or starts with it. */
export const conflicts = (bound: Bound[], strokes: Stroke[], id: string, context: "all" | BindingContext = "all", cmds?: Cmd[]) => {
  const current = allowedStates(cmds?.find((command) => command.id === id), context);
  const others = bound.filter((binding) => binding.id !== id &&
    (binding.available ?? ALL_CONTEXTS).some((state) => current.includes(state)));
  return {
    same: [...new Set(others.filter((binding) => same(binding.strokes, strokes)).map((binding) => binding.id))],
    prefix: [...new Set(others.filter((binding) =>
      startsWith(binding.strokes, strokes) || startsWith(strokes, binding.strokes)).map((binding) => binding.id))],
  };
};

/** The command an exact sequence names (the first bound, as the registry orders them). */
const exact = (table: Bound[], strokes: Stroke[]) => table.filter((b) => same(b.strokes, strokes)).map((b) => b.id).slice(0, 1);

/** What the waiting sequence runs when the time is up: an exact match, or nothing. */
export const expire = (table: Bound[], pending: Pending, context?: KeyContext): string[] => (pending ? exact(context ? table.filter((binding) => (binding.available ?? ALL_CONTEXTS).includes(context)) : table, pending.strokes) : []);

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
export const press = (table: Bound[], pending: Pending, stroke: Stroke | null, now: number, timeout: number, context?: KeyContext): Step => {
  if (context) table = table.filter((binding) => (binding.available ?? ALL_CONTEXTS).includes(context));
  // the time ran out without the timer firing: settle the waiting sequence first
  if (pending && now - pending.at > timeout) {
    const before = expire(table, pending);
    const r = press(table, null, stroke, now, timeout, context);
    return { ...r, run: [...before, ...r.run] };
  }
  if (stroke === null) return { pending: null, run: [], take: false, retry: false };
  if (pending && stroke === "Escape") return { pending: null, run: [], take: true, retry: false };
  const strokes = pending ? [...pending.strokes, stroke] : [stroke];
  const cands = table.filter((b) => b.strokes.length >= strokes.length && strokes.every((s, i) => s === b.strokes[i]));
  if (!cands.length) {
    if (!pending) return { pending: null, run: [], take: false, retry: false };
    // the sequence is dropped and the key counts on its own
    return { ...press(table, null, stroke, now, timeout, context), retry: true };
  }
  if (cands.some((b) => b.strokes.length > strokes.length)) return { pending: { strokes, at: now }, run: [], take: true, retry: false };
  return { pending: null, run: exact(table, strokes), take: true, retry: false };
};

/** A recorded sequence as written in config.json: a first stroke that is the leader key becomes Leader. */
export const writtenBinding = (strokes: Stroke[], leader: Stroke): string => strokes.map((s, i) => (i === 0 && s === leader ? "Leader" : s)).join(" ");

/** The user's bindings with `strokes` taken away from the other commands (replacing, docs/adr/0034). */
export const takeAway = (user: Record<string, Binding[]>, cmds: Cmd[], ids: string[], strokes: Stroke[], leader: Stroke, context: "all" | BindingContext = "all", destinationId?: string): Record<string, Binding[]> =>
  ids.reduce((updated, id) => {
    const command = cmds.find((candidate) => candidate.id === id);
    const source = updated[id] ?? command?.keys ?? [];
    const target = allowedStates(cmds.find((candidate) => candidate.id === destinationId), context);
    const kept = source.filter((binding) => {
      if (!same(readBinding(binding, leader) ?? [], strokes)) return true;
      const sourceStates = allowedStates(command, bindingContext(binding));
      return !sourceStates.some((state) => target.includes(state));
    });
    return setBinding(updated, cmds, id, kept);
  }, user);


/**
 * Every binding that starts another's or is started by one (docs/adr/0040),
 * keyed by "<id> <strokes>", with the other commands' ids.
 */
export const overlaps = (bound: Bound[]): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const b of bound) {
    const others = [...new Set(bound.filter((other) => other.id !== b.id &&
      (b.available ?? ALL_CONTEXTS).some((state) => (other.available ?? ALL_CONTEXTS).includes(state)) &&
      (startsWith(other.strokes, b.strokes) || startsWith(b.strokes, other.strokes)))
      .map((other) => other.id))];
    if (others.length) out.set(overlapKey(b.id, b.strokes, b.context ?? "all"), others);
  }
  return out;
};

// The command registry (docs/adr/0023): every action has an id, a name, a check
// for whether it can run, and default keys; the toolbar menu, the palette and
// the keys all read from it.
import { fuzzy } from "./fuzzy.ts";
import { isMac } from "./ed/keys.ts";
import type { Ctx } from "./ctx.ts";
import type { State } from "./store.ts";

export type Command = {
  id: string;
  label: string;
  icon?: string;
  when: (s: State) => boolean;
  run: (ctx: Ctx) => void | Promise<void>;
  /** Default key bindings (docs/adr/0034 may change them). */
  keys?: string[];
  /** Shown in the toolbar menu. */
  menu?: boolean;
  /** "editor": runs only while a text editor has the focus (its keys are taken by the editor). */
  scope?: "editor";
};

export const validId = (id: string) => /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9][\w-]*)+$/.test(id);

export const addCommand = (list: Command[], c: Command) => {
  if (!validId(c.id)) throw new Error(`bad command id: ${c.id}`);
  if (list.some((x) => x.id === c.id)) throw new Error(`command registered twice: ${c.id}`);
  list.push(c);
};

export const menuCommands = (list: Command[], s: State) => list.filter((c) => c.menu && c.when(s));

const SYMBOL: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Meta: "⌘", Cmd: "⌘" };
const ORDER = ["Ctrl", "Alt", "Shift", "Meta"];

/** A binding as macOS writes it: ⌃⌥⇧⌘ then the key; strokes of a sequence separated by spaces. */
export const keyLabel = (binding: string, mac = isMac()) =>
  binding
    .split(" ")
    .map((stroke) => {
      const parts = stroke.split("-");
      // "Mod--" style bindings are not used; a "-" key would be written "Minus"
      const name = parts.pop()!;
      const mods = parts.map((p) => (p === "Mod" ? (mac ? "Meta" : "Ctrl") : p === "Cmd" ? "Meta" : p));
      const sorted = ORDER.filter((m) => mods.includes(m));
      const key = name === "Minus" ? "-" : name;
      // a bare key (after a leader) is the character typed; with modifiers it is the key's cap
      return sorted.map((m) => (mac ? SYMBOL[m] : `${m}+`)).join("") + (key.length === 1 && sorted.length ? key.toUpperCase() : key);
    })
    .join(" ");

/** The commands the keys may run now: available ones, and editor commands only while the editor has the focus. */
export const keyedCommands = (list: Command[], s: State, editorFocused: boolean) => list.filter((c) => (c.scope !== "editor" || editorFocused) && c.when(s));

/** What the ⌘P box shows: commands after a leading ">", sheets otherwise. */
export const splitQuery = (input: string): { mode: "commands" | "files"; q: string } =>
  input.startsWith(">") ? { mode: "commands", q: input.slice(1).trimStart() } : { mode: "files", q: input };

/** The palette's list: recent first then by name for an empty query; by fuzzy score on the name or the id otherwise. */
export const rankCommands = (list: Command[], s: State, q: string, recent: string[]): Command[] => {
  const avail = list.filter((c) => c.when(s));
  if (!q) {
    const rec = recent.flatMap((id) => avail.filter((c) => c.id === id));
    const rest = avail.filter((c) => !recent.includes(c.id)).sort((a, b) => a.label.localeCompare(b.label, "ja"));
    return [...rec, ...rest];
  }
  return avail
    .flatMap((c) => {
      const scores = [fuzzy(q, c.label)?.score, fuzzy(q, c.id)?.score].filter((x): x is number => x !== undefined);
      return scores.length ? [{ c, score: Math.max(...scores) }] : [];
    })
    .sort((a, b) => b.score - a.score || a.c.label.localeCompare(b.c.label, "ja"))
    .map((x) => x.c);
};

export const RECENT_LIMIT = 20;
export const pushRecent = (recent: string[], id: string) => [id, ...recent.filter((x) => x !== id)].slice(0, RECENT_LIMIT);

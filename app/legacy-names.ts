// The old names of config.json read as the new ones (docs/adr/0082). This is the one place
// where the old names of the screen's state and of the command ids are written: the
// screen's elements were renamed to the glossary's names (docs/glossary.md), and a
// config.json written before keeps its state and key bindings. Only the new names are
// written back, so the old ones go away at the next write.

/** The keys of `ui` renamed: old → new. */
const UI_KEYS: Readonly<Record<string, string>> = {
  left: "sidebarPanel",
  showLeft: "showSidebar",
  right: "rightSidebarPanel",
  showRight: "showRightSidebar",
  side: "previewMode",
  showProblems: "showBottomPanel",
  problemsHeight: "bottomPanelHeight",
  problemsTab: "bottomPanelTab",
};

/** The values of `ui.bottomPanelTab` renamed: old → new. */
const TAB_VALUES: Readonly<Record<string, string>> = { notes: "notifications", build: "build-log" };

/** The command ids renamed: old → new. */
const COMMAND_IDS: Readonly<Record<string, string>> = {
  "view.toggleLeft": "view.toggleSidebar",
  "view.toggleRight": "view.toggleRightSidebar",
  "view.problems": "view.bottomPanel",
};

/** The prefixes of command ids renamed: old → new (the panels of the sidebar and the right sidebar). */
const COMMAND_PREFIXES: readonly [string, string][] = [
  ["view.left.", "view.sidebar."],
  ["view.right.", "view.rightSidebar."],
];

/** The key of `ui` that keeps the command palette's recent command ids (palette.ts). */
const RECENT_COMMANDS = "recentCommands";

/** A command id under its new name; an id that was not renamed stays as it is. */
export const commandId = (id: string): string => {
  if (id in COMMAND_IDS) return COMMAND_IDS[id];
  const p = COMMAND_PREFIXES.find(([from]) => id.startsWith(from));
  return p ? p[1] + id.slice(p[0].length) : id;
};

const isOld = (id: string) => commandId(id) !== id;

/**
 * `ui` with its old keys read as the new ones. A new key's value wins over its old key's.
 * The old tab values and the recent commands' old ids are read as the new ones too.
 */
export const readUi = (ui: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ui)) if (!(k in UI_KEYS)) out[k] = v;
  for (const [from, to] of Object.entries(UI_KEYS)) if (from in ui && !(to in ui)) out[to] = ui[from];
  const tab = out.bottomPanelTab;
  if (typeof tab === "string" && tab in TAB_VALUES) out.bottomPanelTab = TAB_VALUES[tab];
  const recent = out[RECENT_COMMANDS];
  if (Array.isArray(recent)) out[RECENT_COMMANDS] = [...new Set(recent.map((id) => (typeof id === "string" ? commandId(id) : id)))];
  return out;
};

/** Key bindings with the old command ids read as the new ones. A new id's binding wins over its old id's. */
export const readKeyBindings = <T>(bindings: Record<string, T>): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(bindings)) if (!isOld(id)) out[id] = v;
  for (const [id, v] of Object.entries(bindings)) if (isOld(id) && !(commandId(id) in out)) out[commandId(id)] = v;
  return out;
};

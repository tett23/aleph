// The app's context: the store, the settings and the registries through which
// each part (panels, views, status items, settings sections, commands) plugs in.
import type { Config } from "./config.ts";
import type { Handle, NotifyOpts } from "./notify.ts";
import type { Editor, EditorPlugin } from "./ed/editor.ts";
import type { Doc, LeftPanel, RightPanel, State, Store } from "./store.ts";

export type Panel = { icon: string; title: string; render: (el: HTMLElement, ctx: Ctx) => void | Promise<void> };

export type StatusItem = (s: State, ctx: Ctx) => string;

export type SettingsSection = {
  id: string;
  label: string;
  group: string;
  /** The HTML of the section's items. */
  render: (ctx: Ctx) => string | Promise<string>;
  /** Clicks and changes inside the section; return true to draw it again. */
  onClick?: (el: HTMLElement, ctx: Ctx) => boolean | Promise<boolean>;
  onChange?: (el: HTMLInputElement, ctx: Ctx) => boolean | Promise<boolean>;
};

export type { Command } from "./commands.ts";
import type { Command } from "./commands.ts";
import type { PaletteItem } from "./palette.ts";

/** The view of the editor pane and of the pane beside it. */
export type View = {
  /** Draws the open sheets into the editor pane; returns a cleanup. */
  main?: (el: HTMLElement, ctx: Ctx) => (() => void) | void;
  /** Draws the preview pane. */
  side?: (head: HTMLElement, body: HTMLElement, ctx: Ctx) => void;
  /** Draws the problems panel under the editor (docs/adr/0055). */
  problems?: (el: HTMLElement, ctx: Ctx) => void;
};

export type OpenOpts = { newTab?: boolean };

/** Where to put the caret after opening (1-based line, 0-based column). */
export type At = { line: number; col?: number };

export type Ctx = {
  store: Store;
  config: Config;
  saveConfig: () => Promise<void>;
  toast: (msg: string) => void;
  /** A notification of docs/adr/0064: timed or sticky, with buttons. */
  notify: (o: NotifyOpts) => Handle;
  left: Partial<Record<LeftPanel, Panel>>;
  right: Partial<Record<RightPanel, Panel>>;
  status: StatusItem[];
  /** What a click on a status item with `data-status="<key>"` does. */
  statusActions: Record<string, (ctx: Ctx) => void>;
  /** Run after git was checked again (docs/adr/0060). */
  gitChanged: (() => void)[];
  settings: SettingsSection[];
  commands: Command[];
  /** The sheets for the ⌘P box (docs/adr/0022); null until that finder is mounted. */
  findSheets: ((q: string) => PaletteItem[]) | null;
  view: View;
  /** Opens sheets: one, or several chapters together; a path may be taken by an opener (the plot). */
  /** With `newTab`, in a new tab after the selected one (docs/adr/0024); otherwise in place of the selected tab. */
  open: (paths: string[], at?: At, opts?: OpenOpts) => Promise<void>;
  /** Openers that take a path instead of the editor; return true when taken. */
  openers: ((path: string, ctx: Ctx, opts?: OpenOpts) => boolean | Promise<boolean>)[];
  /** Where to put the caret once the editor is ready. */
  pendingAt: At | null;
  /** Marks added to a file row of the tree (unsaved changes, goals). */
  decor: ((path: string, ctx: Ctx) => string)[];
  /** The first heading of each gm and md sheet, by path. */
  titles: Map<string, string>;
  /** Whether this is a debug build, marked on the screen (docs/adr/0052). */
  debug: boolean;
  /** The Golem projects of every workspace, refreshed with the tree. */
  projects: string[];
  /** Run after `golem new` made a project (to copy fonts from the library). */
  onNewProject: ((project: string, ctx: Ctx) => void | Promise<void>)[];
  /** Flushes writes that would otherwise target an old path after a rename. */
  beforeRename: ((from: string, to: string, ctx: Ctx) => void | Promise<void>)[];
  /** Prepare reference edits after the other flushes, and undo them if the disk rename fails. */
  prepareRename?: (from: string, to: string, ctx: Ctx) => Promise<{ rollback: () => Promise<void>; renamed: () => void | Promise<void> } | null>;
  /** Whether the just-completed rename's references were handled by Golem LSP. */
  renameReferencesHandled?: boolean;
  /** Run after a file is renamed in Aleph. */
  onRename: ((from: string, to: string, ctx: Ctx) => void | Promise<void>)[];
  /** The editors of the open sheets, by path. */
  editors: Map<string, Editor>;
  /** What each text editor gets for a sheet (the LSP adds its own). */
  editorPlugins: ((doc: Doc, ctx: Ctx) => EditorPlugin | null)[];
  /** Views that replace the editor for a kind (pdf, images, tables), drawing one sheet. */
  kindViews: Record<string, (el: HTMLElement, doc: Doc, ctx: Ctx) => Editor>;
  /** Saves the open sheets (those given, or all with changes). */
  save: (paths?: string[], opts?: { explicit?: boolean; intermediate?: boolean; beforeFormat?: string }) => Promise<Set<string>>;
  /** HEAD's text of a file, for the change marks; null when not in HEAD. */
  baseText: (doc: Doc) => Promise<string | null | false>;
  /** Draws the panels and the status bar again (after a change outside the store). */
  refresh: (what?: ("left" | "right" | "status" | "side" | "main" | "problems")[]) => void;
};

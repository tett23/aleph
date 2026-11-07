// The app's context: the store, the settings and the registries through which
// each part (panels, views, status items, settings sections, commands) plugs in.
import type { Config } from "./config.ts";
import type { LeftPanel, RightPanel, State, Store } from "./store.ts";

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

export type Command = { label: string; icon: string; when: (s: State) => boolean; run: (ctx: Ctx) => void | Promise<void> };

/** The view of the editor pane and of the pane beside it. */
export type View = {
  /** Draws the open sheets into the editor pane; returns a cleanup. */
  main?: (el: HTMLElement, ctx: Ctx) => (() => void) | void;
  /** Draws the preview pane. */
  side?: (head: HTMLElement, body: HTMLElement, ctx: Ctx) => void;
};

export type Ctx = {
  store: Store;
  config: Config;
  saveConfig: () => Promise<void>;
  toast: (msg: string) => void;
  left: Partial<Record<LeftPanel, Panel>>;
  right: Partial<Record<RightPanel, Panel>>;
  status: StatusItem[];
  settings: SettingsSection[];
  commands: Command[];
  view: View;
  /** Draws the panels and the status bar again (after a change outside the store). */
  refresh: (what?: ("left" | "right" | "status" | "side" | "main")[]) => void;
};

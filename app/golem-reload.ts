// Reloading the Golem and shem binaries from the settings (docs/adr/0112), apart from the
// DOM and Tauri: what a reload does, in which order, and when a path change reloads.
import type { Tool } from "./api.ts";

/** What a reload needs from the app; tests give their own. */
export type ReloadDeps = {
  /** A tree move or an outside move's reference update is running. */
  moving: () => boolean;
  /** The binary found now, by the setting and the search order; throws when there is none. */
  info: (tool: Tool) => Promise<{ version: string }>;
  /** Stops and drops every project connection of `golem lsp`. */
  resetLsp: () => void;
  /** Syncs the open LSP documents now: new connections with the binary found now. */
  resync: () => Promise<void>;
  /** Reads kinsoku again for the projects with a .gm editor and drops the others' values. */
  reread: () => Promise<void>;
  /** Forgets that "Golem LSP が移動後の参照の更新に対応していません" was told. */
  forget: () => void;
  /** Draws the settings section again: the rows' versions and paths. */
  redraw: () => void;
  notify: (message: string, level: "info" | "warning" | "error") => void;
};

const MOVING = "移動が終わってから読み込みなおしてください";
const NAME: Record<Tool, string> = { golem: "Golem", shem: "shem" };

/** The Golem reload (I1–I4, I6, I9, I10). */
export const reloadGolem = async (d: ReloadDeps) => {
  if (d.moving()) return d.notify(MOVING, "warning");
  d.resetLsp();
  let version: string;
  try {
    version = (await d.info("golem")).version;
  } catch (error) {
    // the connections stay stopped; the next sync tries again
    d.forget();
    d.redraw();
    return d.notify(error instanceof Error ? error.message : String(error), "error");
  }
  await d.resync();
  await d.reread();
  d.forget();
  d.redraw();
  d.notify(`${NAME.golem} を読み込みなおしました：${version}`, "info");
};

/** The shem reload: shem is found at every call, so only the row is drawn again (I5, I10). */
export const reloadShem = async (d: ReloadDeps) => {
  let version: string;
  try {
    version = (await d.info("shem")).version;
  } catch (error) {
    d.redraw();
    return d.notify(error instanceof Error ? error.message : String(error), "error");
  }
  d.redraw();
  d.notify(`${NAME.shem} を読み込みなおしました：${version}`, "info");
};

export const reload = (tool: Tool, d: ReloadDeps) => (tool === "golem" ? reloadGolem(d) : reloadShem(d));

/** Whether the row's path may change now: Golem's waits until a move is over (I6). */
export const mayChangePath = (tool: Tool, d: Pick<ReloadDeps, "moving" | "notify">) => {
  if (tool !== "golem" || !d.moving()) return true;
  d.notify(MOVING, "warning");
  return false;
};

/** After the path was asked to change: a change reloads its row once; a refusal only draws the row back (I8). */
export const afterPathChange = async (tool: Tool, changed: boolean, d: ReloadDeps) => {
  if (!changed) return d.redraw();
  await reload(tool, d);
};

/** "デフォルトに戻す" works only when a path is saved (I7). */
export const resetEnabled = (saved: string) => saved.trim() !== "";

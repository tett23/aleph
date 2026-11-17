// A sheet's title read again when it is saved (docs/adr/0079). No DOM and no Tauri here,
// so that node --test can run it; the tree passes the redraw and its treeReloaded hooks.
import { allDocs, type Action, type State } from "./store.ts";
import { kindOf, titleOf } from "./workspace.ts";

export type TitleHooks = {
  /** Draws the tree and the toolbar again. */
  redraw: () => void;
  /** Runs the treeReloaded hooks (the wikilink index, the sheets sent to the LSP). */
  reloaded: () => void | Promise<void>;
};

/**
 * After the store's `saved` changed an open sheet's `saved`, puts that sheet's title, read from
 * the saved text with the tree's `titleOf`, in `titles` (or drops it when there is none).
 * Redraws and runs the hooks once, only when the title changed; returns whether it did.
 */
export const readTitleOnSave = async (s: State, prev: State, action: Action, titles: Map<string, string>, hooks: TitleHooks): Promise<boolean> => {
  if (action.type !== "saved") return false;
  const path = action.path;
  const kind = kindOf(path);
  if (kind !== "gm" && kind !== "md") return false;
  const now = allDocs(s).find((d) => d.path === path);
  const before = allDocs(prev).find((d) => d.path === path);
  if (!now || now.saved === before?.saved) return false;
  const title = titleOf(kind, now.saved);
  if ((titles.get(path) ?? null) === title) return false;
  if (title) titles.set(path, title);
  else titles.delete(path);
  hooks.redraw();
  await hooks.reloaded();
  return true;
};

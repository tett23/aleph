// The tree can rename entries within a registered workspace, except a workspace root
// and the files Golem reads from a project's root (docs/adr/0070).
import { basename, dirname } from "./path.ts";
import { projectOf, workspaceOf } from "./workspace.ts";

export const canRenameTreeItem = (path: string, workspaces: string[], projects: string[]) => {
  const workspace = workspaceOf(path, workspaces);
  if (!workspace || path === workspace) return false;
  if (workspaces.some((registered) => registered.startsWith(`${path}/`))) return false;
  const project = projectOf(path, projects);
  return !project || dirname(path) !== project || !["plot.csv", "manifest.toml", "style.toml"].includes(basename(path));
};

/** A sibling path for exactly one file or folder. Invalid or unchanged names yield null. */
export const renameTarget = (from: string, name: string): string | null => {
  const next = name.trim();
  if (!next || next === basename(from) || next === "." || next === ".." || /[/\\]/.test(next)) return null;
  return `${dirname(from)}/${next}`;
};

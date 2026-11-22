// Path and ownership rules for a drop from a tree row (ADR 0100).
import { basename, dirname } from "./path.ts";
import { canRenameTreeItem } from "./tree-rename.ts";
import { projectOf, workspaceOf } from "./workspace.ts";

export const withinMove = (path: string, from: string) => path === from || path.startsWith(from + "/");
export const movedPath = (path: string, from: string, to: string) => withinMove(path, from) ? to + path.slice(from.length) : path;

export type TreeDrop = { kind: "move"; to: string } | { kind: "noop" } | { kind: "invalid"; reason: string };

export const treeDrop = (from: string, dir: string, workspace: string, workspaces: string[], projects: string[]): TreeDrop => {
  if (workspaceOf(from, workspaces) !== workspace || workspaceOf(dir, workspaces) !== workspace)
    return { kind: "invalid", reason: "同じワークスペース内で移動してください" };
  if (!canRenameTreeItem(from, workspaces, projects))
    return { kind: "invalid", reason: "ワークスペースとプロジェクト直下の設定ファイルは移動できません" };
  if (withinMove(dir, from)) return { kind: "invalid", reason: "項目自身やその子孫へは移動できません" };
  if (dirname(from) === dir) return { kind: "noop" };
  if ((projects.includes(dir) || projectOf(dir, projects)) && projects.some((p) => withinMove(p, from)))
    return { kind: "invalid", reason: "プロジェクトを入れ子にはできません" };
  return { kind: "move", to: dir + "/" + basename(from) };
};

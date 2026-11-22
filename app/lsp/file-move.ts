// Golem root ADR 0399, contract version 1 (Aleph ADR 0100).
import { pathOfFileUri, planFileRename, type Snapshot, type TextDocumentEdit } from "./file-rename.ts";

export type MoveProject = { uri: string; plotCsv: string | null };
export type MoveSheet = { uri: string; title: string | null };
export type MoveDocument = { uri: string; text: string; version: number | null };
export type MoveDirectory = { uri: string; entries: { uri: string; kind: "file" | "directory" | "symlink" }[] };
export type MoveInventory = { projects: MoveProject[]; wikiSheets: MoveSheet[] };
export type MoveRequest = MoveInventory & {
  workspaceUri: string; oldUri: string; newUri: string; inventoryComplete: boolean; documents: MoveDocument[];
};
export type MoveResponse = {
  complete: boolean;
  groups: { projectUri: string | null; edits: TextDocumentEdit[] }[];
  snapshot: MoveInventory & { documents: MoveDocument[]; directories: MoveDirectory[] };
  chapters: { oldUri: string; newUri: string; sourceProjectUri: string; destinationProjectUri: string | null; sourceIndices: number[] }[];
};

export const movePathOf = (workspace: string, uri: string) => {
  const path = pathOfFileUri(uri);
  const parts = path.split("/");
  if ((path !== workspace && !path.startsWith(workspace + "/")) || parts.slice(1).some((p) => !p || p === "." || p === ".." || p.includes("\0")))
    throw new Error(`ワークスペース外または不正な URI：${uri}`);
  return path;
};

export const planMoveEdits = (workspace: string, response: MoveResponse) => {
  if (response?.complete !== true) throw new Error("Move plan is not complete");
  const snapshots = new Map<string, Snapshot>();
  for (const { uri, text, version } of response.snapshot.documents) {
    const path = movePathOf(workspace, uri);
    if (snapshots.has(path) || typeof text !== "string" || (version !== null && !Number.isInteger(version)))
      throw new Error(`不正なスナップショット：${path}`);
    snapshots.set(path, { text, version });
  }
  const projects = new Set(response.snapshot.projects.map(({ uri }) => uri));
  const edits = response.groups.flatMap(({ projectUri, edits }) => {
    if (projectUri !== null && !projects.has(projectUri)) throw new Error(`検査外のプロジェクト：${projectUri}`);
    for (const edit of edits) movePathOf(workspace, edit.textDocument.uri);
    return edits;
  });
  return planFileRename(workspace, { documentChanges: edits }, snapshots);
};

// Validate the WorkspaceEdit returned before a tree rename (Golem ADR 0338).
import { applyChanges, editsToChanges, type Change, type Position, type TextEdit } from "./protocol.ts";

export type Snapshot = { text: string; version: number | null };
export type TextDocumentEdit = { textDocument: { uri: string; version: number | null }; edits: TextEdit[] };
export type WorkspaceEdit = { documentChanges?: (TextDocumentEdit | { kind: string; oldUri?: string; newUri?: string })[] };
export type FileEditPlan = { path: string; before: string; after: string; version: number | null; changes: Change[] };

export const pathOfFileUri = (uri: string): string => {
  const parsed = new URL(uri);
  if (parsed.protocol !== "file:" || parsed.hostname || parsed.search || parsed.hash) throw new Error(`Invalid file URI: ${uri}`);
  return decodeURIComponent(parsed.pathname);
};

const validPosition = (text: string, p: Position): boolean => {
  if (!Number.isInteger(p.line) || !Number.isInteger(p.character) || p.line < 0 || p.character < 0) return false;
  const line = text.split("\n")[p.line];
  if (line === undefined || p.character > line.length) return false;
  if (p.character > 0 && p.character < line.length) {
    const previous = line.charCodeAt(p.character - 1);
    const next = line.charCodeAt(p.character);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return false;
  }
  return true;
};

/** One plan per original URI, with edits checked against the exact text and version. */
export const planFileRename = (root: string, response: WorkspaceEdit | null, snapshots: ReadonlyMap<string, Snapshot>): FileEditPlan[] => {
  if (response === null) return [];
  if (!response.documentChanges) throw new Error("The server did not return documentChanges");
  const grouped = new Map<string, Change[]>();
  for (const item of response.documentChanges) {
    if (!("textDocument" in item)) throw new Error("The server returned a file operation");
    const path = pathOfFileUri(item.textDocument.uri);
    if (!path.startsWith(`${root}/`)) throw new Error(`Edit outside the project: ${path}`);
    const snapshot = snapshots.get(path);
    if (!snapshot) throw new Error(`Missing edit source: ${path}`);
    if (item.textDocument.version !== snapshot.version) throw new Error(`Stale edit version: ${path}`);
    for (const edit of item.edits) {
      if (!validPosition(snapshot.text, edit.range.start) || !validPosition(snapshot.text, edit.range.end)) throw new Error(`Invalid edit range: ${path}`);
    }
    grouped.set(path, [...(grouped.get(path) ?? []), ...editsToChanges(snapshot.text, item.edits)]);
  }
  return [...grouped].map(([path, all]) => {
    const snapshot = snapshots.get(path)!;
    const sorted = all.sort((a, b) => a.from - b.from || a.to - b.to || a.insert.localeCompare(b.insert));
    const changes: Change[] = [];
    for (const change of sorted) {
      const last = changes.at(-1);
      if (last && last.from === change.from && last.to === change.to && last.insert === change.insert) continue;
      if (change.from > change.to || (last && change.from < last.to) || (last && last.from === change.from && last.to === change.to)) throw new Error(`Conflicting edit range: ${path}`);
      changes.push(change);
    }
    return { path, before: snapshot.text, after: applyChanges(snapshot.text, changes), version: snapshot.version, changes };
  });
};

export type RenameIo = {
  read: (path: string) => Promise<string>;
  write: (path: string, text: string, plan: FileEditPlan) => Promise<void>;
};

/** Apply checked edits before the filesystem rename, with an undo for a failed rename. */
export const applyFileRenamePlans = async (plans: FileEditPlan[], io: RenameIo): Promise<() => Promise<void>> => {
  const applied: FileEditPlan[] = [];
  const rollback = async () => {
    const errors: Error[] = [];
    for (const plan of [...applied].reverse()) {
      try {
        if (await io.read(plan.path) !== plan.after) throw new Error(`The edited document changed: ${plan.path}`);
        await io.write(plan.path, plan.before, plan);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length) throw new AggregateError(errors, "Could not roll back all rename edits");
  };
  try {
    for (const plan of plans) {
      if (await io.read(plan.path) !== plan.before) throw new Error(`The source document changed: ${plan.path}`);
      try {
        await io.write(plan.path, plan.after, plan);
        applied.push(plan);
      } catch (error) {
        if (await io.read(plan.path) === plan.after) applied.push(plan);
        throw error;
      }
    }
  } catch (error) {
    try { await rollback(); }
    catch (undoError) { throw new AggregateError([error, undoError], "Rename edits failed and rollback was incomplete"); }
    throw error;
  }
  return rollback;
};

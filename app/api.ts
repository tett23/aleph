// Thin wrappers over the Rust commands (docs/adr/0003).
import { invoke } from "@tauri-apps/api/core";
import type { Outcome } from "./dropin.ts";
import type { ModelInfo } from "./assistant/models.ts";

export type Entry = { path: string; name: string; dir: boolean; children: Entry[] };
export type TreeMoveInventory = { entries: Entry[]; projects: string[] };
export type TreeMoveDiskPlan = {
  workspace: string; from: string; to: string;
  documents: { path: string; text: string }[];
  directories: { path: string; entries: { path: string; kind: "file" | "directory" | "symlink" }[] }[];
  writes: { path: string; before: string | null; after: string }[];
};
export type TreeMoveOutcome = { moved: boolean; error: string | null; remainingWrites: string[] };
export type Out = { code: number; stdout: string; stderr: string };

export type Hit = { path: string; line: number; column: number; text: string; start: number; end: number };
export type Found = { hits: Hit[]; truncated: boolean };
export type Spot = { line: number; column: number; matched: string };
export type SearchArgs = { roots: string[]; pattern: string; regex: boolean; case_sensitive: boolean; kinds: string[]; limit: number };

export type ToolInfo = { path: string; version: string; bundled: string };

/** A message of the local connector's chat (app/assistant/prompt.ts). */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
/** The local model's answer: its JSON as written, the model's name, and the time it took. */
export type LocalAnswer = { content: string; model: string; ms: number };
/** The assistant's connectors (docs/adr/0081). */
export type ConnectorId = "local" | "claude" | "codex";
/** Whether a connector is found and approved; the local connector always is. */
export type ConnectorInfo = { id: ConnectorId; name: string; found: boolean; approved: boolean };
/** Why Claude Code or Codex failed and the local connector answered instead (I8). */
export type FallbackReason = { from: ConnectorId; kind: "start" | "exit" | "schema" | "timeout"; message: string };
/** An answer's JSON, the connector that gave it, the local model's name, the time it took, and why it fell back. */
export type Answered = { answer: string; connector: ConnectorId; model: string | null; ms: number; fallbackReason: FallbackReason | null };
export type Tool = "golem" | "shem";

export const api = {
  exportChapters: (parts: { path: string; live: string | null }[]) => invoke<boolean>("export_chapters", { parts }),
  configLoad: () => invoke<string>("config_load"),
  configSave: (json: string) => invoke<void>("config_save", { json }),
  listTree: (root: string, options?: { showHidden: boolean; showIgnored: boolean }) => invoke<Entry[]>("list_tree", { root, showHidden: options?.showHidden ?? false, showIgnored: options?.showIgnored ?? true }),
  readText: (path: string) => invoke<string>("read_text", { path }),
  /** The English words spelled wrong, by macOS (docs/adr/0030). */
  spellCheck: (words: string[]) => invoke<string[]>("spell_check", { words }),
  readBytes: (path: string) => invoke<ArrayBuffer>("read_bytes", { path }),
  writeText: (path: string, content: string, createNew = false) => invoke<void>("write_text", { path, content, createNew }),
  exists: (path: string) => invoke<boolean>("exists", { path }),
  initializeWorkspaceProject: (root: string) => invoke<void>("initialize_workspace_project", { root }),
  createEntry: (path: string, dir: boolean) => invoke<void>("create_entry", { path, dir }),
  makeDir: (path: string) => invoke<void>("make_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  treeMoveInventory: (workspace: string) => invoke<TreeMoveInventory>("tree_move_inventory", { workspace }),
  treeMoveRead: (workspace: string, path: string) => invoke<string | null>("tree_move_read", { workspace, path }),
  treeMoveApply: (plan: TreeMoveDiskPlan) => invoke<TreeMoveOutcome>("tree_move_apply", { plan }),
  copyFile: (from: string, to: string, newIn?: string) => invoke<void>("copy_file", { from, to, newIn }),
  /** Copies what was dropped on the tree into `target` (docs/adr/0078); progress comes as `aleph:copy-progress` with `id`. */
  copyDropped: (id: number, target: string, paths: string[]) => invoke<Outcome[]>("copy_dropped", { id, target, paths }),
  /** The trash (docs/adr/0033): its folder, and moving or removing a file or folder. */
  trashDir: () => invoke<string>("trash_dir"),
  movePath: (from: string, to: string) => invoke<void>("move_path", { from, to }),
  removePath: (path: string) => invoke<void>("remove_path", { path }),
  /** Writes bytes as they are (a pasted image, docs/adr/0031); the path goes in a header. */
  writeBytes: (path: string, bytes: Uint8Array) => invoke<void>("write_bytes", bytes, { headers: { path: encodeURIComponent(path) } }),
  listDir: (path: string) => invoke<string[]>("list_dir", { path }),
  tempDir: (name: string) => invoke<string>("temp_dir", { name }),
  // the programs come from the settings Rust keeps (docs/adr/0042)
  tool: (name: Tool, cwd: string, args: string[]) => invoke<Out>("tool", { name, cwd, args }),
  toolInfo: (name: Tool) => invoke<ToolInfo>("tool_info", { name }),
  /** The git in use and its version; rejected with the reason when it cannot be used (docs/adr/0060). */
  gitInfo: () => invoke<{ path: string; version: string }>("git_info"),
  /** Watches the workspaces and the shared library with FSEvents again (docs/adr/0063); false when it could not. */
  watchRoots: () => invoke<boolean>("watch_roots"),
  lspStart: (id: string, cwd: string) => invoke<void>("lsp_start", { id, cwd }),
  lspSend: (id: string, message: string) => invoke<void>("lsp_send", { id, message }),
  lspStop: (id: string) => invoke<void>("lsp_stop", { id }),
  /** Opens an http(s) link in the default browser (docs/adr/0044). */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  pluginsDir: () => invoke<string>("plugins_dir"),
  /** Plugins added and removed through native dialogs (docs/adr/0042); null or false when the writer stopped. */
  installPlugin: () => invoke<string | null>("install_plugin"),
  removePlugin: (name: string) => invoke<boolean>("remove_plugin", { name }),
  openPluginsFolder: () => invoke<void>("open_plugins_folder"),
  /** Shows a file or folder in Finder, selected (docs/adr/0053). */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  /** Handing the tree's files outside (docs/adr/0077): a folder's zip entries as on disk, the zip written where the writer picks (null when stopped), the pasteboard, a drag out of the window. */
  zipEntries: (dir: string) => invoke<string[]>("zip_entries", { dir }),
  zipFolder: (dir: string, names: [string, string][]) => invoke<string | null>("zip_folder", { dir, names }),
  copyFiles: (paths: string[]) => invoke<void>("copy_files", { paths }),
  dragOut: (paths: string[]) => invoke<void>("drag_out", { paths }),
  /** Paths the writer picks in native dialogs (docs/adr/0050): the settings written, or null. */
  addWorkspace: () => invoke<string | null>("add_workspace"),
  chooseLibrary: (make: boolean) => invoke<string | null>("choose_library", { make }),
  chooseBinary: (name: "git" | Tool) => invoke<string | null>("choose_binary", { name }),
  setBinary: (name: "git" | Tool, path: string) => invoke<string | null>("set_binary", { name, path }),
  search: (args: SearchArgs) => invoke<Found>("search_files", { args }),
  /** Replacing across files (docs/adr/0032); the open sheets in `leave` are replaced in their editors. */
  replaceFiles: (args: Omit<SearchArgs, "limit"> & { with: string; only: Record<string, Spot[]> | null; leave: string[] }) =>
    invoke<{ path: string; replaced: number; skipped: number }[]>("replace_files", { args }),
  replaceText: (a: { text: string; pattern: string; regex: boolean; caseSensitive: boolean; with: string; only: Spot[] | null }) =>
    invoke<{ text: string; replaced: number; skipped: number }>("replace_text", a),
  replacePreview: (a: { matched: string[]; pattern: string; regex: boolean; caseSensitive: boolean; with: string }) => invoke<string[]>("replace_preview", a),
  git: (cwd: string, args: string[]) => invoke<Out>("git", { cwd, args }),
  // the assistant's local models and inference (docs/adr/0081); Rust keeps the list, the files and the choice
  assistantModels: () => invoke<ModelInfo[]>("assistant_models"),
  assistantDownloadModel: (id: string) => invoke<void>("assistant_download_model", { id }),
  assistantDeleteModel: (id: string) => invoke<boolean>("assistant_delete_model", { id }),
  /** Returns the settings written. */
  assistantChooseModel: (id: string) => invoke<string>("assistant_choose_model", { id }),
  assistantLocalAsk: (messages: ChatMessage[]) => invoke<LocalAnswer>("assistant_local_ask", { messages }),
  assistantLocalCount: (texts: string[]) => invoke<number[]>("assistant_local_count", { texts }),
  assistantLocalTemplateCount: (messages: ChatMessage[]) => invoke<number>("assistant_local_template_count", { messages }),
  /** The connectors, found and approved; Rust finds the CLIs and keeps the approvals. */
  assistantConnectors: () => invoke<ConnectorInfo[]>("assistant_connectors"),
  /** Revokes the approval of Claude Code or Codex (docs/adr/0089); the next request asks again. */
  assistantRevoke: (connector: ConnectorId) => invoke<void>("assistant_revoke", { connector }),
  /** Asks a connector; Rust asks for the approval in a native dialog the first time (I6) and falls back to the local connector once (I8). */
  assistantAsk: (connector: ConnectorId, messages: ChatMessage[]) => invoke<Answered>("assistant_ask", { connector, messages }),
  /** A bundled chapter of the Golem manual for the material: "03-markup", "04-manifest" or "05-style". */
  assistantManual: (chapter: string) => invoke<string>("assistant_manual", { chapter }),
  /** golem check --format json of each text in place of `file`, in a copy of `project` in the cache. */
  assistantGolemCheck: (project: string, file: string, texts: string[]) => invoke<Out[]>("assistant_golem_check", { project, file, texts }),
};

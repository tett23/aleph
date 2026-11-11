// Thin wrappers over the Rust commands (docs/adr/0003).
import { invoke } from "@tauri-apps/api/core";

export type Entry = { path: string; name: string; dir: boolean; children: Entry[] };
export type Out = { code: number; stdout: string; stderr: string };

export type Hit = { path: string; line: number; column: number; text: string; start: number; end: number };
export type Found = { hits: Hit[]; truncated: boolean };
export type Spot = { line: number; column: number; matched: string };
export type SearchArgs = { roots: string[]; pattern: string; regex: boolean; case_sensitive: boolean; kinds: string[]; limit: number };

export type ToolInfo = { path: string; version: string; bundled: string };
export type Tool = "golem" | "shem";

export const api = {
  configLoad: () => invoke<string>("config_load"),
  configSave: (json: string) => invoke<void>("config_save", { json }),
  listTree: (root: string) => invoke<Entry[]>("list_tree", { root }),
  readText: (path: string) => invoke<string>("read_text", { path }),
  /** The English words spelled wrong, by macOS (docs/adr/0030). */
  spellCheck: (words: string[]) => invoke<string[]>("spell_check", { words }),
  readBytes: (path: string) => invoke<ArrayBuffer>("read_bytes", { path }),
  writeText: (path: string, content: string) => invoke<void>("write_text", { path, content }),
  exists: (path: string) => invoke<boolean>("exists", { path }),
  createEntry: (path: string, dir: boolean) => invoke<void>("create_entry", { path, dir }),
  makeDir: (path: string) => invoke<void>("make_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  copyFile: (from: string, to: string) => invoke<void>("copy_file", { from, to }),
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
};

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
  makeDir: (path: string) => invoke<void>("make_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  copyFile: (from: string, to: string) => invoke<void>("copy_file", { from, to }),
  listDir: (path: string) => invoke<string[]>("list_dir", { path }),
  tempDir: (name: string) => invoke<string>("temp_dir", { name }),
  tool: (name: Tool, bin: string | undefined, cwd: string, args: string[]) => invoke<Out>("tool", { name, bin, cwd, args }),
  toolInfo: (name: Tool, bin: string | undefined) => invoke<ToolInfo>("tool_info", { name, bin }),
  lspStart: (id: string, bin: string | undefined, cwd: string) => invoke<void>("lsp_start", { id, bin, cwd }),
  lspSend: (id: string, message: string) => invoke<void>("lsp_send", { id, message }),
  lspStop: (id: string) => invoke<void>("lsp_stop", { id }),
  pluginsDir: () => invoke<string>("plugins_dir"),
  search: (args: SearchArgs) => invoke<Found>("search_files", { args }),
  /** Replacing across files (docs/adr/0032); the open sheets in `leave` are replaced in their editors. */
  replaceFiles: (args: Omit<SearchArgs, "limit"> & { with: string; only: Record<string, Spot[]> | null; leave: string[] }) =>
    invoke<{ path: string; replaced: number; skipped: number }[]>("replace_files", { args }),
  replaceText: (a: { text: string; pattern: string; regex: boolean; caseSensitive: boolean; with: string; only: Spot[] | null }) =>
    invoke<{ text: string; replaced: number; skipped: number }>("replace_text", a),
  replacePreview: (a: { matched: string[]; pattern: string; regex: boolean; caseSensitive: boolean; with: string }) => invoke<string[]>("replace_preview", a),
  git: (bin: string | undefined, cwd: string, args: string[]) => invoke<Out>("git", { bin, cwd, args }),
};

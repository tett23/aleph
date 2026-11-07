// Thin wrappers over the Rust commands.
import { invoke } from "@tauri-apps/api/core";

export type Entry = { path: string; name: string; dir: boolean; children: Entry[] };
export type Out = { code: number; stdout: string; stderr: string };
export type Hit = { path: string; line: number; text: string; ranges: [number, number][] };

export const api = {
  configLoad: () => invoke<string>("config_load"),
  configSave: (json: string) => invoke<void>("config_save", { json }),
  pluginsDir: () => invoke<string>("plugins_dir"),
  listTree: (root: string) => invoke<Entry[]>("list_tree", { root }),
  readText: (path: string) => invoke<string>("read_text", { path }),
  readBytes: (path: string) => invoke<ArrayBuffer>("read_bytes", { path }),
  writeText: (path: string, content: string) => invoke<void>("write_text", { path, content }),
  exists: (path: string) => invoke<boolean>("exists", { path }),
  makeDir: (path: string) => invoke<void>("make_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  copyFile: (from: string, to: string) => invoke<void>("copy_file", { from, to }),
  listDir: (path: string) => invoke<string[]>("list_dir", { path }),
  search: (roots: string[], pattern: string, regex: boolean, caseSensitive: boolean) =>
    invoke<Hit[]>("search", { roots, pattern, regex, caseSensitive }),
  git: (cwd: string, args: string[]) => invoke<Out>("git", { cwd, args }),
  tool: (name: "golem" | "shem", bin: string | undefined, cwd: string, args: string[]) =>
    invoke<Out>("tool", { name, bin, cwd, args }),
  toolVersion: (name: "golem" | "shem", bin: string | undefined) => invoke<string>("tool_version", { name, bin }),
  tempDir: (name: string) => invoke<string>("temp_dir", { name }),
  lspStart: (id: string, bin: string | undefined, cwd: string) => invoke<void>("lsp_start", { id, bin, cwd }),
  lspSend: (id: string, message: string) => invoke<void>("lsp_send", { id, message }),
  lspStop: (id: string) => invoke<void>("lsp_stop", { id }),
};

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string) => p.slice(0, p.lastIndexOf("/"));
export const ext = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i < 0 ? "" : b.slice(i + 1).toLowerCase();
};
export const stem = (p: string) => {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? b : b.slice(0, i);
};
export const rel = (root: string, p: string) => (p.startsWith(root + "/") ? p.slice(root.length + 1) : p);

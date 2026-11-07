// Thin wrappers over the Rust commands (docs/adr/0003).
import { invoke } from "@tauri-apps/api/core";

export type Entry = { path: string; name: string; dir: boolean; children: Entry[] };
export type Out = { code: number; stdout: string; stderr: string };

export const api = {
  configLoad: () => invoke<string>("config_load"),
  configSave: (json: string) => invoke<void>("config_save", { json }),
  listTree: (root: string) => invoke<Entry[]>("list_tree", { root }),
  readText: (path: string) => invoke<string>("read_text", { path }),
  readBytes: (path: string) => invoke<ArrayBuffer>("read_bytes", { path }),
  writeText: (path: string, content: string) => invoke<void>("write_text", { path, content }),
  exists: (path: string) => invoke<boolean>("exists", { path }),
  makeDir: (path: string) => invoke<void>("make_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  copyFile: (from: string, to: string) => invoke<void>("copy_file", { from, to }),
  listDir: (path: string) => invoke<string[]>("list_dir", { path }),
  tempDir: (name: string) => invoke<string>("temp_dir", { name }),
  git: (bin: string | undefined, cwd: string, args: string[]) => invoke<Out>("git", { bin, cwd, args }),
};

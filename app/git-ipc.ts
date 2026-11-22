import { invoke } from "@tauri-apps/api/core";

export type GitRepository = {
  root: string; gitDir: string; linked: boolean; branch: string | null; hasHead: boolean; conflicted: boolean;
};
export type GitStatus = { xy: string; path: string; from?: string | null };
export type GitHead = { kind: "notRepository" | "unborn" | "missing" } | { kind: "text"; text: string };
export type GitCommit = { id: string; summary: string };
export type GitDiffSpan = { kind: "same" | "removed" | "added"; text: string };
export type GitDiff = {
  body: "lines" | "binary" | "folder" | "empty";
  hunks: readonly { heading: string; lines: readonly GitDiffSpan[] }[];
  added: number;
  removed: number;
};
export type GitLogin = { username: string; password: string };
export type GitCredentials = GitLogin & { target: string };
export type IdentityKey = "name" | "email";
export type IdentityValue = { value: string; source: string };
export type GitIdentity = {
  target: string; exists: boolean; repository?: GitRepository | null;
  local: Record<IdentityKey, string | null>;
  inherited: Record<IdentityKey, IdentityValue | null>;
  effective: Record<IdentityKey, IdentityValue | null>;
  missing: IdentityKey[];
};
type IdentityInput = { target: string; name: string; email: string };
type NoInput = Record<string, never>;
type Operations = {
  repository: [NoInput, GitRepository | null];
  status: [NoInput, GitStatus[]];
  head: [{ path: string }, GitHead];
  history: [NoInput, GitCommit[]];
  diff: [{ path: string; from?: string }, GitDiff];
  initialize: [NoInput, GitRepository];
  identity: [NoInput, GitIdentity | null];
  saveIdentity: [IdentityInput, GitIdentity];
  commit: [{ message: string; automatic: boolean; scope?: "workspace" | "repository" }, GitCommit | null];
  push: [{ credentials?: GitCredentials }, null];
  pull: [{ credentials?: GitCredentials }, null];
};
export const gitOperation = <K extends keyof Operations>(cwd: string, kind: K, input: Operations[NoInfer<K>][0]) =>
  invoke<Operations[K][1]>("git_operation", { cwd, operation: { kind, ...input } });

export const globalIdentity = () => invoke<GitIdentity>("git_global_identity");
export const saveGlobalIdentity = (input: IdentityInput) => invoke<GitIdentity>("git_save_global_identity", input);

export type GitFailure = { kind: string; message: string; repository?: string; missing?: IdentityKey[]; authTarget?: string };
export const gitFailure = (failure: unknown): GitFailure =>
  failure !== null && typeof failure === "object" && "kind" in failure && "message" in failure
    ? failure as GitFailure
    : { kind: "read", message: String(failure) };

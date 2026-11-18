// The pure parts of the assistant's tab (docs/adr/0081, 下部パネルのタブ): what the request is about
// (the selection of the focused sheet, or the whole sheet), the file named in the prompt, the key that
// sends, the answer's JSON, the changed lines shown before 「適用」 and the connectors offered.
// No DOM and no Tauri here, so that node --test can run it.
import type { ConnectorInfo } from "../api.ts";
import type { Edit, Scope } from "./edits.ts";

/** The sheet a request is about, and its scope; `from` and `to` are where the selection was. */
export type Target = { path: string; scope: Scope; from: number; to: number };

export const targetOf = (path: string, text: string, range: { from: number; to: number } | null): Target =>
  range && range.from < range.to
    ? { path, scope: { kind: "selection", text: text.slice(range.from, range.to) }, from: range.from, to: range.to }
    : { path, scope: { kind: "sheet" }, from: 0, to: text.length };

/** The text sent as the target: the selection's, or the whole sheet's. */
export const targetText = (t: Target, sheet: string) => (t.scope.kind === "selection" ? t.scope.text : sheet);

export const targetLabel = (t: Target) => (t.scope.kind === "selection" ? `選択の範囲（${[...t.scope.text].length} 字）` : "シートの全体");

const under = (path: string, dir: string | null) => (dir !== null && path.startsWith(dir.endsWith("/") ? dir : `${dir}/`) ? path.slice(dir.replace(/\/$/, "").length + 1) : null);

/** The file named in the prompt: its path from the project, else from the workspace, else its name. */
export const promptFile = (path: string, project: string | null, workspace: string | null) =>
  under(path, project) ?? under(path, workspace) ?? path.slice(path.lastIndexOf("/") + 1);

/** ⌘↩ (Ctrl-↩ elsewhere), not while composing. */
export const isSendKey = (e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; isComposing: boolean }) =>
  e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.isComposing;

export type Answer = { explanation: string; edits: Edit[] };

/** The answer's JSON of docs/adr/0081, or why it is not. */
export const parseAnswer = (raw: string): { ok: true; answer: Answer } | { ok: false; reason: string } => {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "答えが JSON ではありません" };
  }
  const o = v as { explanation?: unknown; edits?: unknown };
  if (typeof v !== "object" || v === null || Array.isArray(v) || typeof o.explanation !== "string" || !Array.isArray(o.edits))
    return { ok: false, reason: "答えが explanation と edits を持つ形ではありません" };
  const bad = o.edits.findIndex((e) => typeof e !== "object" || e === null || typeof (e as Edit).find !== "string" || typeof (e as Edit).replace !== "string");
  if (bad >= 0) return { ok: false, reason: `${bad + 1} 番目の案の形が正しくありません` };
  return { ok: true, answer: { explanation: o.explanation, edits: (o.edits as Edit[]).map((e) => ({ find: e.find, replace: e.replace })) } };
};

/** A line of the diff: kept, removed, added, or "…" for kept lines left out. */
export type DiffLine = { op: " " | "-" | "+" | "…"; text: string };

/** Above this many cells, the middle is shown as all removed then all added. */
const LCS_LIMIT = 4_000_000;

/** The removed and added lines of `after` against `before`, with `context` kept lines around each run. */
export const lineDiff = (before: string, after: string, context = 1): DiffLine[] => {
  if (before === after) return [];
  const b = before.split("\n");
  const a = after.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let eb = b.length;
  let ea = a.length;
  while (eb > s && ea > s && a[ea - 1] === b[eb - 1]) {
    eb--;
    ea--;
  }
  const B = b.slice(s, eb);
  const A = a.slice(s, ea);
  const middle: DiffLine[] = [];
  if (A.length * B.length > LCS_LIMIT) middle.push(...B.map((text) => ({ op: "-" as const, text })), ...A.map((text) => ({ op: "+" as const, text })));
  else {
    const dp = Array.from({ length: B.length + 1 }, () => new Uint32Array(A.length + 1));
    for (let i = B.length - 1; i >= 0; i--) for (let j = A.length - 1; j >= 0; j--) dp[i][j] = B[i] === A[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < B.length || j < A.length) {
      if (i < B.length && j < A.length && B[i] === A[j]) {
        middle.push({ op: " ", text: B[i] });
        i++;
        j++;
      } else if (i < B.length && (j >= A.length || dp[i + 1][j] >= dp[i][j + 1])) middle.push({ op: "-", text: B[i++] });
      else middle.push({ op: "+", text: A[j++] });
    }
  }
  const all: DiffLine[] = [...b.slice(0, s).map((text) => ({ op: " " as const, text })), ...middle, ...b.slice(eb).map((text) => ({ op: " " as const, text }))];
  // keep the changed lines and `context` kept lines around them; the rest becomes one "…" per gap
  const near = all.map((_, k) => all.slice(Math.max(0, k - context), k + context + 1).some((l) => l.op !== " "));
  return all.flatMap((l, k) => (near[k] ? [l] : k > 0 && near[k - 1] && all.slice(k).some((x) => x.op !== " ") ? [{ op: "…" as const, text: "" }] : []));
};

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

const LOCAL: ConnectorInfo = { id: "local", name: "ローカル", found: true, approved: true };

/** The connectors to choose from: the local one always, and Claude Code and Codex when found. */
export const connectorChoices = (infos: readonly ConnectorInfo[]): ConnectorInfo[] => {
  const found = infos.filter((c) => c.id !== "local" && c.found);
  return [infos.find((c) => c.id === "local") ?? LOCAL, ...found];
};

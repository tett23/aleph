// Asking the assistant (docs/adr/0081): the prompt of docs/adr/0086 with its material chosen within
// the limit (I9), and, for a Golem project's .gm, style.toml and manifest.toml, golem check of the
// answer against the text before it, asked again once with the added diagnostics when the errors
// of the target file increase. The calls to Rust come in as functions, so node --test can run it.
import { parseDiagnostics, type Diagnostic } from "../diag/parse.ts";
import { applyToSheet } from "./edits.ts";
import { joinMaterial, materialLimit, rankSections, selectMaterial, SEPARATOR, terms, type Section } from "./material.ts";
import { commandList, messages, type Command, type Message } from "./prompt.ts";
import { parseAnswer, type Answer, type Target } from "./tab.ts";

/** The context of the local connector (docs/adr/0086; llama.rs CONTEXT): the material's limit is counted from it for every connector, since Claude Code and Codex fall back to it (I8). */
export const LOCAL_CONTEXT = 4096;

/** The local model's counts: the messages with the chat template, and plain texts. */
export type Counters = { template: (ms: Message[]) => Promise<number>; texts: (ts: string[]) => Promise<number[]> };

/**
 * The messages of a request: the fixed part counted with the material left empty, the limit from it
 * (materialLimit), then the command list and the ranked sections, each while it fits (I9).
 */
export const buildPrompt = async (o: {
  commands: readonly Command[];
  sections: readonly Section[];
  request: string;
  file: string;
  target: string;
  context: number;
  count: Counters;
}): Promise<{ messages: Message[]; fixed: number; limit: number; material: string }> => {
  const build = (material: string) => messages(material, o.request, o.file, o.target);
  const fixed = await o.count.template(build(""));
  const limit = materialLimit(o.context, fixed);
  const items = [commandList(o.commands), ...rankSections(o.sections, terms(o.request, o.target)).map((s) => s.text)];
  const costs = await o.count.texts(items.map((x) => x + SEPARATOR));
  const cost = new Map(items.map((x, k) => [x + SEPARATOR, costs[k]] as const));
  const chosen = selectMaterial(items[0], items.slice(1), limit, (x) => cost.get(x) ?? Infinity);
  const material = joinMaterial(chosen);
  return { messages: build(material), fixed, limit, material };
};

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();

/** The target file's path from its project, when golem check reads it: a project's .gm, style.toml or manifest.toml. */
export const checkedFile = (doc: { path: string; kind: string; project: string | null }): string | null => {
  if (!doc.project || !doc.path.startsWith(`${doc.project.replace(/\/$/, "")}/`)) return null;
  const name = base(doc.path);
  if (!(name.endsWith(".gm") || name === "style.toml" || name === "manifest.toml")) return null;
  return doc.path.slice(doc.project.replace(/\/$/, "").length + 1);
};

/** The errors of golem check in one file of the project. */
export const errorsIn = (ds: readonly Diagnostic[], file: string): Diagnostic[] => ds.filter((d) => d.severity === "error" && d.span?.file === file);

const keyOf = (d: Diagnostic) => `${d.code}\n${d.message}`;

/** The errors in `file` after the edit beyond those before it, compared by code and message, each counted. */
export const addedErrors = (before: readonly Diagnostic[], after: readonly Diagnostic[], file: string): Diagnostic[] => {
  const left = new Map<string, number>();
  for (const d of errorsIn(before, file)) left.set(keyOf(d), (left.get(keyOf(d)) ?? 0) + 1);
  return errorsIn(after, file).filter((d) => {
    const n = left.get(keyOf(d)) ?? 0;
    if (n > 0) left.set(keyOf(d), n - 1);
    return n === 0;
  });
};

/** The request asked again, with the diagnostics the answer added. */
export const retryRequest = (request: string, added: readonly Diagnostic[]) =>
  `${request}\n\n前の案を当てると、golem check のエラーが増えました。次のエラーが出ない案にしてください。\n${added
    .map((d) => `- ${d.span ? `${d.span.line} 行 ${d.span.column} 列：` : ""}${d.message}（${d.code}）`)
    .join("\n")}`;

/** golem check's diagnostics: the JSON on standard output, or on standard error when the output is empty (golem writes there when there is an error); null when neither is a JSON array. */
export const checkDiagnostics = (o: { code: number; stdout: string; stderr: string }): Diagnostic[] | null => {
  const r = parseDiagnostics(o.stdout.trim() !== "" ? o.stdout : o.stderr);
  return r.raw === null ? r.items : null;
};

/** golem check of each text in place of the target file: its diagnostics, or null when it could not run. */
export type CheckRun = (texts: string[]) => Promise<(Diagnostic[] | null)[]>;

/** The check's result: the errors before and after, those added, and whether the request was asked again; or why it did not run. */
export type Checked = { before: number; after: number; added: Diagnostic[]; retried: boolean } | { failed: string };

export type Outcome<T> = {
  /** The answer shown: the connector's reply as it came. */
  answered: T;
  answer: Answer | null;
  /** The sheet's text with the edits applied; null when there are no edits or they do not apply. */
  after: string | null;
  /** Why the answer is not shown as an edit: not the JSON of the form, or edits that do not apply. */
  reason: string | null;
  check: Checked | null;
};

const evaluate = <T extends { answer: string }>(answered: T, sheet: string, target: Target): Outcome<T> => {
  const p = parseAnswer(answered.answer);
  if (!p.ok) return { answered, answer: null, after: null, reason: p.reason, check: null };
  if (p.answer.edits.length === 0) return { answered, answer: p.answer, after: null, reason: null, check: null };
  const r = applyToSheet(sheet, target.scope, p.answer.edits);
  return r.ok ? { answered, answer: p.answer, after: r.text, reason: null, check: null } : { answered, answer: p.answer, after: null, reason: r.reason, check: null };
};

/**
 * Asks, then checks a Golem file's answer with golem check: when the errors of the file increase,
 * asks once more with the added diagnostics; when they still increase, the answer is shown with them.
 * Nothing here changes the sheet (I4): `sheet` is the text at the request, and the check runs on a copy.
 */
export const askChecked = async <T extends { answer: string }>(o: {
  ask: (request: string) => Promise<T>;
  request: string;
  sheet: string;
  target: Target;
  /** The target file's path from its project, or null when it is not checked. */
  file: string | null;
  check: CheckRun;
}): Promise<Outcome<T>> => {
  const first = evaluate(await o.ask(o.request), o.sheet, o.target);
  if (o.file === null || first.after === null) return first;
  const file = o.file;
  const [before, after] = await o.check([o.sheet, first.after]);
  if (!before || !after) return { ...first, check: { failed: "golem check を走らせられませんでした" } };
  const nb = errorsIn(before, file).length;
  const na = errorsIn(after, file).length;
  if (na <= nb) return { ...first, check: { before: nb, after: na, added: [], retried: false } };
  const added = addedErrors(before, after, file);
  const keep = { ...first, check: { before: nb, after: na, added, retried: true } };
  const again = await o.ask(retryRequest(o.request, added)).catch(() => null);
  const second = again && evaluate(again, o.sheet, o.target);
  if (!second || second.after === null) return keep;
  const [after2] = await o.check([second.after]);
  if (!after2) return { ...second, check: { failed: "golem check を走らせられませんでした" } };
  const n2 = errorsIn(after2, file).length;
  return { ...second, check: { before: nb, after: n2, added: n2 <= nb ? [] : addedErrors(before, after2, file), retried: true } };
};

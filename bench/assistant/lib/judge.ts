// Judging an answer to a task of the benchmark (docs/adr/0081, 既定のモデルの選び方).
import { applyEdits, type Edit } from "../../../app/assistant/edits.ts";

export type Answer = { explanation: string; edits: Edit[] };
export type Verdict = { pass: boolean; reason: string; text?: string };

// The JSON Schema the model's answer is bound to
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    explanation: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: { find: { type: "string" }, replace: { type: "string" } },
        required: ["find", "replace"],
        additionalProperties: false,
      },
    },
  },
  required: ["explanation", "edits"],
  additionalProperties: false,
} as const;

export const parseAnswer = (raw: string): { ok: true; answer: Answer } | { ok: false; reason: string } => {
  const value = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (typeof value !== "object" || value === null) return { ok: false, reason: "答えが JSON のオブジェクトではありません" };
  const v = value as Record<string, unknown>;
  if (typeof v.explanation !== "string") return { ok: false, reason: "explanation がありません" };
  if (!Array.isArray(v.edits)) return { ok: false, reason: "edits がありません" };
  const edits = v.edits as unknown[];
  if (!edits.every((e) => typeof e === "object" && e !== null && typeof (e as Edit).find === "string" && typeof (e as Edit).replace === "string"))
    return { ok: false, reason: "edits の形が正しくありません" };
  return { ok: true, answer: { explanation: v.explanation, edits: edits as Edit[] } };
};

// A rewrite: the edits apply to the target, and the text after them is one of
// the expected texts
export const judgeEdit = (target: string, answer: Answer, expected: readonly string[]): Verdict => {
  const applied = applyEdits(target, answer.edits);
  if (!applied.ok) return { pass: false, reason: `適用できません: ${applied.reason}` };
  if (!expected.includes(applied.text)) return { pass: false, reason: "適用した後のテキストが正解と違います", text: applied.text };
  return { pass: true, reason: "", text: applied.text };
};

// A question about a command: no edits, and the explanation names the command
// by its id or its label
export const judgeCommand = (answer: Answer, id: string, label: string): Verdict => {
  if (answer.edits.length > 0) return { pass: false, reason: "edits が空ではありません" };
  if (!answer.explanation.includes(id) && !answer.explanation.includes(label)) return { pass: false, reason: `説明に ${id} も「${label}」もありません` };
  return { pass: true, reason: "" };
};

type Diagnostic = { severity?: unknown; span?: { file?: unknown } };

// The errors of `golem check --format json` in one file of the project
export const errorsIn = (diagnostics: unknown, file: string): number =>
  Array.isArray(diagnostics) ? (diagnostics as Diagnostic[]).filter((d) => d?.severity === "error" && d?.span?.file === file).length : 0;

// The answer to a Golem file also must not add errors of golem check
export const judgeGolem = (verdict: Verdict, before: number, after: number): Verdict =>
  !verdict.pass || after <= before ? verdict : { ...verdict, pass: false, reason: `golem check のエラーが ${before} から ${after} に増えました` };

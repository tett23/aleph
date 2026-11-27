import { applyEdits, type Edit } from "./edits.ts";

export type ManuscriptChapter = { file: string; text: string };
export type ManuscriptRange = ManuscriptChapter & { from: number; to: number };
type ChapterEdit = Edit & { file: string };
export type ManuscriptAnswer = { explanation: string; edits: ChapterEdit[] };
type Finding = { ranges: ManuscriptRange[]; explanation: string; edits: ChapterEdit[] };
type Failure = { range: ManuscriptRange; reason: string };
export type ManuscriptRun = {
  chapters: (ManuscriptChapter & { edits: Edit[] })[];
  findings: Finding[];
  failed: Failure[];
  rejected: string[];
  reconciliation: string;
  splitReasons: string[];
};

export const parseManuscriptAnswer = (raw: string): ManuscriptAnswer => {
  const value = JSON.parse(raw);
  if (!value || typeof value.explanation !== "string" || !Array.isArray(value.edits)
    || value.edits.some((edit: ChapterEdit | null) => !edit || typeof edit.file !== "string" || typeof edit.find !== "string" || typeof edit.replace !== "string")) {
    throw new Error("章を指定した編集案の形が正しくありません");
  }
  return value;
};

export const rangeLabel = ({ file, from, to }: ManuscriptRange) => from === to ? file : `${file}（本文の範囲 ${from + 1}〜${to}）`;
const overContext = (reason: string) => /コンテキスト上限を超えました|長いコンテキストで起動できません|finish_reason: length/.test(reason);

const split = (ranges: ManuscriptRange[]): [ManuscriptRange[], ManuscriptRange[]] | null => {
  if (ranges.length > 1) {
    const mid = Math.ceil(ranges.length / 2);
    return [ranges.slice(0, mid), ranges.slice(mid)];
  }
  const [range] = ranges;
  if (!range || range.text.length < 2) return null;
  const mid = Math.floor(range.text.length / 2);
  const breaks = [...range.text.matchAll(/\r?\n[ \t]*\r?\n/g)]
    .map((line) => line.index + line[0].length)
    .filter((offset) => offset > 0 && offset < range.text.length);
  let at = breaks.reduce((closest, offset) => Math.abs(offset - mid) < Math.abs(closest - mid) ? offset : closest, Infinity);
  if (!Number.isFinite(at)) {
    at = mid;
    if (/[\uDC00-\uDFFF]/.test(range.text[at])) at -= 1;
    if (range.text[at - 1] === "\r" && range.text[at] === "\n") at -= 1;
  }
  if (at <= 0 || at >= range.text.length) return null;
  const offset = range.from + at;
  return [
    [{ ...range, text: range.text.slice(0, at), to: offset }],
    [{ ...range, text: range.text.slice(at), from: offset }],
  ];
};

export const runManuscript = async (
  chapters: ManuscriptChapter[],
  ask: (ranges: ManuscriptRange[], reconciliation?: Finding[]) => Promise<ManuscriptAnswer>,
  progress: (note: string) => void,
): Promise<ManuscriptRun> => {
  const findings: Finding[] = [];
  const failed: Failure[] = [];
  const rejected: string[] = [];
  const splitReasons = new Set<string>();
  const pending = [chapters.map((chapter) => ({ ...chapter, from: 0, to: chapter.text.length }))];
  while (pending.length) {
    const ranges = pending.shift()!;
    progress(`${findings.length} 件の範囲を処理済み。処理中 ${ranges.map(rangeLabel).join("、")}`);
    try {
      const answer = await ask(ranges);
      const edits = answer.edits.filter((edit) => {
        const range = ranges.find((range) => range.file === edit.file);
        const applied = range && applyEdits(range.text, [edit]);
        if (applied?.ok) return true;
        rejected.push(`${edit.file} の案を確認できませんでした。`);
        return false;
      });
      findings.push({ ranges, explanation: answer.explanation, edits });
    } catch (error) {
      const reason = String(error);
      const parts = overContext(reason) ? split(ranges) : null;
      if (parts) {
        splitReasons.add(reason);
        progress(`原稿を分割します。理由 ${reason}`);
        pending.unshift(...parts);
      } else {
        failed.push(...ranges.map((range) => ({ range, reason })));
      }
    }
  }

  let reconciliation = "";
  let combined: ChapterEdit[] = [];
  if (findings.length > 1 || (findings.length && failed.length)) {
    progress(`${findings.length} 件の結果を照合しています。`);
    try {
      const result = await ask([], findings);
      reconciliation = result.explanation;
      combined = result.edits.filter((edit) => {
        const available = findings.some((finding) => finding.ranges.some((range) => range.file === edit.file && applyEdits(range.text, [edit]).ok));
        if (!available) rejected.push(`${edit.file} の照合から出た案を確認できませんでした。`);
        return available;
      });
    } catch (error) {
      reconciliation = `結果を照合できませんでした。 ${String(error)}`;
    }
  }
  const edits = [...findings.flatMap((finding) => finding.edits), ...combined];
  return {
    findings, failed, rejected, reconciliation, splitReasons: [...splitReasons],
    chapters: chapters.map((chapter) => {
      const choices = edits.filter((edit) => edit.file === chapter.file);
      const unique = [...new Map(choices.map((edit) => [JSON.stringify([edit.find, edit.replace]), edit])).values()];
      const checked = applyEdits(chapter.text, unique);
      if (!checked.ok) {
        rejected.push(`${chapter.file} の案を適用できません。 ${checked.reason}`);
        return { ...chapter, edits: [] };
      }
      return { ...chapter, edits: unique };
    }),
  };
};

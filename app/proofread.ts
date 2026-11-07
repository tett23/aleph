// Checking the writing (docs/adr/0030): the ranges of a sheet that are prose,
// and rules that need no morphological analysis (ら抜き言葉, 表記ゆれ, runs of
// punctuation, full-width letters, half-width katakana), plus English spelling
// with a checker passed in. Pure, so that node --test can run it.
import type { Diag } from "./ed/diag.ts";
import { startState, tokenizeLine } from "./gm.ts";

export type RuleId = "raNuki" | "variants" | "punctuation" | "fullwidth" | "halfwidthKana" | "spelling";
export type ProofreadConfig = { enabled: boolean; rules: Record<RuleId, boolean>; ignoreWords: string[] };

export const RULES: [RuleId, string, string][] = [
  ["raNuki", "ら抜き言葉", "見れる、来れる、食べれる など、決まった一覧の動詞"],
  ["variants", "表記ゆれ", "出来る と できる、サーバー と サーバ など、一つのシートの中の二つの書き方"],
  ["punctuation", "句読点の連続", "、、 。。 、。 。、 と、全角のカンマとピリオドの同じ並び"],
  ["fullwidth", "全角の英数字", "Ａ〜Ｚ、ａ〜ｚ、０〜９"],
  ["halfwidthKana", "半角の片仮名", "半角の片仮名と、半角の濁点と半濁点"],
  ["spelling", "英語の綴り", "2 文字以上のラテン文字の語を、macOS の英語の辞書で"],
];

export const defaultProofread = (): ProofreadConfig => ({
  enabled: true,
  rules: { raNuki: true, variants: true, punctuation: true, fullwidth: true, halfwidthKana: true, spelling: true },
  ignoreWords: [],
});

/** The setting as read from config.json: unknown or missing values back to the defaults. */
export const readProofread = (v: unknown): ProofreadConfig => {
  const d = defaultProofread();
  const r = (v && typeof v === "object" ? v : {}) as Partial<ProofreadConfig>;
  const rules = (r.rules && typeof r.rules === "object" ? r.rules : {}) as Partial<Record<RuleId, unknown>>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    rules: Object.fromEntries(Object.entries(d.rules).map(([k, on]) => [k, typeof rules[k as RuleId] === "boolean" ? rules[k as RuleId] : on])) as Record<RuleId, boolean>,
    ignoreWords: Array.isArray(r.ignoreWords) ? r.ignoreWords.filter((w): w is string => typeof w === "string" && w.trim() !== "").map((w) => w.trim()) : d.ignoreWords,
  };
};

export type Segment = { from: number; to: number };

/** The prose of a line: the ranges not covered by `out` (positions in the line). */
const gaps = (len: number, out: Segment[]): Segment[] => {
  const sorted = [...out].sort((a, b) => a.from - b.from);
  const r: Segment[] = [];
  let at = 0;
  for (const o of sorted) {
    if (o.from > at) r.push({ from: at, to: o.from });
    at = Math.max(at, o.to);
  }
  if (at < len) r.push({ from: at, to: len });
  return r;
};

const mdOut = (line: string): Segment[] => {
  const out: Segment[] = [];
  for (const m of line.matchAll(/`+[^`]*`+/g)) out.push({ from: m.index!, to: m.index! + m[0].length });
  for (const m of line.matchAll(/\]\([^)]*\)/g)) out.push({ from: m.index!, to: m.index! + m[0].length });
  for (const m of line.matchAll(/\[\[([^[\]|]*)/g)) out.push({ from: m.index! + 2, to: m.index! + 2 + m[1].length });
  return out;
};

/** The ranges of a sheet that are checked, in the document's UTF-16 positions. */
export const segments = (kind: string, text: string): Segment[] => {
  const out: Segment[] = [];
  let offset = 0;
  let gm = startState();
  let fence = false;
  for (const line of text.split("\n")) {
    let skip: Segment[] = [];
    if (kind === "gm") {
      const r = tokenizeLine(line, gm);
      gm = r.state;
      skip = r.tokens.filter((t) => t.type !== "heading").map((t) => ({ from: t.from, to: t.to }));
    } else if (kind === "md") {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        skip = [{ from: 0, to: line.length }];
      } else skip = fence ? [{ from: 0, to: line.length }] : mdOut(line);
    }
    for (const g of gaps(line.length, skip)) if (g.to > g.from) out.push({ from: offset + g.from, to: offset + g.to });
    offset += line.length + 1;
  }
  return out;
};

// ---- the rules ----

type Hit = { from: number; to: number; message: string };
type Rule = (text: string, segs: Segment[]) => Hit[];

const each = (re: RegExp, text: string, segs: Segment[], f: (m: RegExpMatchArray, from: number) => Hit | null): Hit[] =>
  segs.flatMap((s) => [...text.slice(s.from, s.to).matchAll(re)].flatMap((m) => f(m, s.from + m.index!) ?? []));

const RA_NUKI_VERBS = "見|来|食べ|出|寝|着|起き|考え|決め|変え|投げ|借り|生き|信じ|逃げ|覚え|教え|答え|開け|閉め|受け|続け|調べ|止め|やめ|伸び|居|こ";
const RA_NUKI = new RegExp(`(${RA_NUKI_VERBS})れ(る|な(?:い|かっ)|た|ま(?:す|せ|し)|て)`, "g");

const raNuki: Rule = (text, segs) =>
  each(RA_NUKI, text, segs, (m, from) => ({
    from,
    to: from + m[1].length + 2,
    message: `ら抜き言葉：${m[1]}れる → ${m[1]}られる`,
  }));

const PAIRS: [string, string][] = [
  ["出来る", "できる"],
  ["出来な", "できな"],
  ["出来た", "できた"],
  ["下さい", "ください"],
  ["頂く", "いただく"],
  ["頂き", "いただき"],
  ["致し", "いたし"],
  ["致す", "いたす"],
  ["様に", "ように"],
  ["事が", "ことが"],
  ["時に", "ときに"],
];

const variants: Rule = (text, segs) => {
  const found = new Map<string, Hit[]>();
  const add = (form: string, h: Hit) => found.set(form, [...(found.get(form) ?? []), h]);
  for (const [a, b] of PAIRS) for (const f of [a, b]) for (const h of each(new RegExp(f, "g"), text, segs, (m, from) => ({ from, to: from + f.length, message: "" }))) add(f, h);
  const groups: [string, string][] = [...PAIRS];
  // katakana words with and without a final long mark
  const kata = new Map<string, Set<string>>();
  for (const h of each(/[ァ-ヴ][ァ-ヴー]+/g, text, segs, (m, from) => ({ from, to: from + m[0].length, message: m[0] }))) {
    add(h.message, h);
    const base = h.message.replace(/ー$/, "");
    kata.set(base, (kata.get(base) ?? new Set()).add(h.message));
  }
  for (const [base, forms] of kata) if (forms.size > 1 && forms.has(base) && forms.has(base + "ー")) groups.push([base + "ー", base]);
  return groups.flatMap(([a, b]) => {
    const ha = found.get(a) ?? [];
    const hb = found.get(b) ?? [];
    if (!ha.length || !hb.length) return [];
    // the fewer; with as many of each, the one that came later
    const [few, many, manyForm] = ha.length < hb.length || (ha.length === hb.length && ha[0].from > hb[0].from) ? [ha, hb, b] : [hb, ha, a];
    const fewForm = manyForm === a ? b : a;
    return few.map((h) => ({ ...h, message: `表記ゆれ：${fewForm}（このシートでは ${manyForm} が ${many.length} 回）` }));
  });
};

const punctuation: Rule = (text, segs) => each(/[、。]{2,}|[，．]{2,}/g, text, segs, (m, from) => ({ from, to: from + m[0].length, message: `句読点の連続：${m[0]}` }));
const fullwidth: Rule = (text, segs) => each(/[Ａ-Ｚａ-ｚ０-９]+/g, text, segs, (m, from) => ({ from, to: from + m[0].length, message: `全角の英数字：${m[0]}` }));
const halfwidthKana: Rule = (text, segs) => each(/[･-ﾟ]+/g, text, segs, (m, from) => ({ from, to: from + m[0].length, message: `半角の片仮名：${m[0]}` }));

const RULE_FNS: [RuleId, Rule, Diag["severity"]][] = [
  ["raNuki", raNuki, "info"],
  ["variants", variants, "info"],
  ["punctuation", punctuation, "warning"],
  ["fullwidth", fullwidth, "info"],
  ["halfwidthKana", halfwidthKana, "warning"],
];

/** The diagnostics of the rules that need no spelling checker. */
export const checkText = (kind: string, text: string, cfg: ProofreadConfig): Diag[] => {
  if (!cfg.enabled) return [];
  const segs = segments(kind, text);
  return RULE_FNS.filter(([id]) => cfg.rules[id]).flatMap(([id, f, severity]) => f(text, segs).map((h) => ({ ...h, severity, source: id })));
};

// ---- English spelling ----

export type Word = { from: number; to: number; word: string };

/** The Latin words of two or more letters (apostrophes inside) in the checked ranges. */
export const englishWords = (segs: Segment[], text: string): Word[] =>
  segs.flatMap((s) => [...text.slice(s.from, s.to).matchAll(/[A-Za-z]+(?:'[A-Za-z]+)*/g)].filter((m) => m[0].length >= 2).map((m) => ({ from: s.from + m.index!, to: s.from + m.index! + m[0].length, word: m[0] })));

/** The diagnostics of the misspelled words, leaving out those to ignore. */
export const spellDiags = (words: Word[], misspelled: Set<string>, ignore: string[]): Diag[] => {
  const skip = new Set(ignore.map((w) => w.toLowerCase()));
  return words
    .filter((w) => misspelled.has(w.word) && !skip.has(w.word.toLowerCase()))
    .map((w) => ({ from: w.from, to: w.to, severity: "info" as const, message: `英語の綴り：${w.word}`, source: "spelling" }));
};

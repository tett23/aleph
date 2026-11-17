// The material passed to the assistant with a request (docs/adr/0081, I9): the
// list of Aleph's commands first, then the sections of the Golem manual's
// chapter for the kind of the target, ranked by the terms they share with the
// request and the target, within a budget of tokens. A section that does not
// fit is skipped whole, and the next one is tried.

export type Section = { title: string; text: string };
export type Chapter = "03-markup" | "04-manifest" | "05-style";
export type CountTokens = (text: string) => number;

export const ANSWER_TOKENS = 1024;
export const SEPARATOR = "\n\n";

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1).toLowerCase();

export const chapterFor = (path: string): Chapter | null => {
  const name = base(path);
  if (name.endsWith(".gm") || name.endsWith(".md")) return "03-markup";
  if (name === "manifest.toml") return "04-manifest";
  if (name === "style.toml") return "05-style";
  return null;
};

// Splits a chapter at its headings (# to ######). A line in a fenced code
// block is never a heading. The text before the first heading is a section
// with an empty title. Joining the texts with "\n" gives the chapter back.
export const splitSections = (chapter: string): Section[] => {
  const lines = chapter.split("\n");
  // whether each line is inside a fence: a fence line flips the state after it
  const fenced = lines.reduce<{ inside: boolean; marks: boolean[] }>(
    (acc, line) => ({ inside: isFence(line) ? !acc.inside : acc.inside, marks: [...acc.marks, acc.inside || isFence(line)] }),
    { inside: false, marks: [] },
  ).marks;
  const starts = lines.flatMap((line, i) => (!fenced[i] && heading(line) !== null ? [i] : []));
  const bounds = starts[0] === 0 ? starts : [0, ...starts];
  return bounds.map((start, k) => {
    const end = k + 1 < bounds.length ? bounds[k + 1] : lines.length;
    return { title: heading(lines[start]) ?? "", text: lines.slice(start, end).join("\n") };
  });
};

const isFence = (line: string) => /^\s*```/.test(line);
const heading = (line: string): string | null => {
  const m = /^#{1,6}\s+(.*)$/.exec(line);
  return m ? m[1].trim() : null;
};

const unique = (xs: string[]) => [...new Set(xs)];
const identifiers = (s: string) => s.match(/[A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9]/g) ?? [];

// The terms of a request: the identifiers in it, and each pair of neighbouring
// characters of it that has a kanji or katakana in it. The terms of a target:
// the keys and table names of TOML, and the commands of Golem's markup.
export const terms = (request: string, target: string): string[] => {
  const chars = [...request];
  const pairs = chars
    .slice(0, -1)
    .map((c, i) => c + chars[i + 1])
    .filter((p) => /^[\p{L}\p{N}ー]{2}$/u.test(p) && /[\p{Script=Han}\p{Script=Katakana}]/u.test(p));
  const keys = [...target.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
  const tables = [...target.matchAll(/^\s*\[+\s*([^\]\n]+?)\s*\]+\s*$/gm)].flatMap((m) => m[1].split(".").map((s) => s.trim().replace(/^"|"$/g, "")));
  const blocks = [...target.matchAll(/^\s*@([a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
  const inline = [...target.matchAll(/\[([a-z][a-z0-9-]*)[\s:\]]/g)].map((m) => m[1]);
  return unique([...identifiers(request), ...pairs, ...keys, ...tables, ...blocks, ...inline].filter((t) => t.length >= 2));
};

const score = (section: Section, ts: readonly string[]) => ts.filter((t) => section.text.includes(t)).length;

// Highest score first; equal scores keep the order of the chapter
export const rankSections = (sections: readonly Section[], ts: readonly string[]): Section[] =>
  sections
    .map((s, i) => ({ s, i, n: score(s, ts) }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.s);

export const materialLimit = (context: number, fixed: number) => Math.max(0, context - fixed - ANSWER_TOKENS);

// The items that go in: the command list, then the ranked sections, each while
// it fits in what is left of the limit. An item costs its tokens with the
// separator that joins it to the next.
export const selectMaterial = (commands: string, sections: readonly string[], limit: number, count: CountTokens): string[] =>
  [commands, ...sections].reduce<{ left: number; taken: string[] }>(
    (acc, item) => {
      const cost = count(item + SEPARATOR);
      return cost <= acc.left ? { left: acc.left - cost, taken: [...acc.taken, item] } : acc;
    },
    { left: limit, taken: [] },
  ).taken;

export const joinMaterial = (items: readonly string[]) => items.map((s) => s + SEPARATOR).join("");

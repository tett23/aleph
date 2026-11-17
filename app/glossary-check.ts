// Pure helpers for the checks of the glossary (docs/adr/0082): reading the tables of
// docs/glossary.md and of the ADR, taking the UI strings out of a source, and finding
// old code names. Used only by tests; no DOM and no Tauri.

/** The rows of the first Markdown table after `heading` (or in the whole text), as cells by column name. */
export const parseTable = (md: string, heading?: string): Record<string, string>[] => {
  const lines = md.split("\n");
  const start = heading === undefined ? 0 : lines.findIndex((l) => /^#+\s/.test(l) && l.replace(/^#+\s+/, "").trim() === heading);
  if (start < 0) return [];
  const from = lines.slice(start + (heading === undefined ? 0 : 1));
  const first = from.findIndex((l) => l.trimStart().startsWith("|"));
  if (first < 0) return [];
  const rows = from.slice(first);
  const end = rows.findIndex((l) => !l.trimStart().startsWith("|"));
  const table = (end < 0 ? rows : rows.slice(0, end)).map(cells);
  const [head, , ...body] = table;
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h, r[k] ?? ""])));
};

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** The strings in 「」 of a cell; none for 「(無し)」 or a cell without them. */
export const quoted = (cell: string): string[] => [...cell.matchAll(/「([^」]*)」/g)].map((m) => m[1]);

/** The names in backquotes of a cell. */
export const codeNames = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** The source without its comments (line and block comments, and HTML comments). */
export const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Drops `${…}` (with nested braces) from a template's text. */
const dropInterpolations = (s: string): string => {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "{") {
      let depth = 0;
      for (; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}" && --depth === 0) break;
      }
      continue;
    }
    out += s[i];
  }
  return out;
};

/** The value of an attribute or key that starts at `from` (just after its opening quote), up to the closing `quote`, skipping `${…}`. */
const valueAt = (src: string, from: number, quote: string): string => {
  let depth = 0;
  let i = from;
  for (; i < src.length; i++) {
    if (src[i] === "$" && src[i + 1] === "{") depth++, i++;
    else if (depth && src[i] === "}") depth--;
    else if (!depth && src[i] === quote) break;
  }
  return src.slice(from, i);
};

/**
 * The UI strings of a TypeScript source (docs/adr/0082): the values of `title="…"`,
 * `label: "…"` and `placeholder="…"`, and the text outside the tags of HTML templates.
 * Comments, class names and attribute names are not UI strings. `${…}` is dropped.
 */
export const uiStrings = (source: string): string[] => {
  const src = stripComments(source);
  const values = [...src.matchAll(/(?<![\w-])(?:title=|placeholder=|label:\s*)(["'`])/g)].map((m) =>
    dropInterpolations(valueAt(src, m.index! + m[0].length, m[1])),
  );
  // a stretch with a backquote runs out of its template into the code (or into a nested template's edge)
  const texts = [...src.matchAll(/<\/?[a-zA-Z][^<>]*>([^<>`]+)(?=<)/g)].map((m) => dropInterpolations(m[1]).trim());
  return [...values, ...texts].filter((s) => s !== "");
};

const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The class names in `class="…"` values of a source (template parts dropped). */
const classTokens = (src: string): string[] =>
  [...src.matchAll(/class=(["'])/g)].flatMap((m) => dropInterpolations(valueAt(src, m.index! + m[0].length, m[1])).split(/\s+/).filter(Boolean));

/** The selectors of a style sheet: the text outside its blocks, without comments. */
export const cssSelectors = (css: string): string => {
  let s = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let prev = ""; prev !== s; ) (prev = s), (s = s.replace(/\{[^{}]*\}/g, ";"));
  return s;
};

/**
 * Where an old code name of the glossary or of the ADR's renaming table is still used in a
 * source. `kind` is "ts" for TypeScript, "rs" for Rust (where `.name` is a method, so only `class="…"`
 * counts for a class) and "css" for a style sheet.
 */
export const usesOf = (name: string, src: string, kind: "ts" | "rs" | "css"): string[] => {
  const text = kind === "css" ? cssSelectors(src) : stripComments(src);
  const found = (r: RegExp) => [...text.matchAll(r)].map((m) => m[0]);
  // a CSS class: `.name`
  if (/^\.[\w-]+$/.test(name)) {
    const cls = name.slice(1);
    const sel = new RegExp(`(?<=^|[\\s"'\`,(>+~])\\.${re(cls)}(?![\\w-])`, "gm");
    if (kind === "css") return found(sel);
    if (kind === "rs") return classTokens(text).filter((t) => t === cls).map((t) => `class="${t}"`);
    return [
      ...classTokens(text).filter((t) => t === cls).map((t) => `class="${t}"`),
      ...found(sel),
      ...found(new RegExp(`classList\\.\\w+\\(\\s*["'\`]${re(cls)}["'\`]`, "g")),
      ...found(new RegExp(`className\\s*=\\s*["'\`]${re(cls)}(?![\\w-])`, "g")),
    ];
  }
  if (kind === "css") return [];
  // an attribute and its value: `data-x="v"` (also as `dataset.x === "v"`)
  const attr = /^(data-[\w-]+)="([^"]*)"$/.exec(name);
  if (attr) {
    const camel = attr[1].slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    return [...found(new RegExp(re(name), "g")), ...found(new RegExp(`dataset\\.${camel}\\s*===?\\s*["'\`]${re(attr[2])}["'\`]`, "g"))];
  }
  // a key of ctx: `ctx.a.b`, also through the short name `c` when a key of it follows (`c.a.b.x`, `c.a.b[k]`)
  if (name.startsWith("ctx.")) return found(new RegExp(`\\b(?:ctx\\.${re(name.slice(4))}(?![\\w-])|c\\.${re(name.slice(4))}(?=[.[]))`, "g"));
  // a command id with a placeholder: `view.x.<…>`
  if (/<[^>]*>$/.test(name)) return found(new RegExp(`(?<![\\w.])${re(name.replace(/<[^>]*>$/, ""))}`, "g"));
  // a command id: `area.action`
  if (name.includes(".")) return found(new RegExp(`(?<![\\w.])${re(name)}(?![\\w-])`, "g"));
  // a one-word name of the state or of a value (left, notes): as a field of the state, an action type, or a tab
  if (/^[a-z]+$/.test(name))
    return [
      ...found(new RegExp(`\\b(?:s|st|state|prev)\\.${name}\\b`, "g")),
      ...found(new RegExp(`\\.get\\(\\)\\.${name}\\b`, "g")),
      ...found(new RegExp(`type: "${name}"`, "g")),
      ...found(new RegExp(`data-tab="${name}"`, "g")),
      ...found(new RegExp(`dataset\\.tab\\s*===?\\s*"${name}"`, "g")),
    ];
  // an identifier: a type, a function, a key
  return found(new RegExp(`\\b${re(name)}\\b`, "g"));
};

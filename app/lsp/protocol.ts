// The parts of the LSP that are pure data: URIs, positions, formatting edits and
// semantic tokens (docs/adr/0009). Positions are in UTF-16 units, as CodeMirror's are.

export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type TextEdit = { range: Range; newText: string };
export type Change = { from: number; to: number; insert: string };
export type Legend = { tokenTypes: string[]; tokenModifiers: string[] };
export type SemanticToken = { line: number; start: number; length: number; type: string; modifiers: string[] };
export type TokenClass = "cmd" | "expr" | "comment" | "escape" | "mark" | "heading";
export type TokenRange = { from: number; to: number; cls: TokenClass };

/** The file URI of a path, each part percent-encoded (golem lsp finds Japanese paths only so). */
export const uriOf = (path: string) => "file://" + path.split("/").map(encodeURIComponent).join("/");

/** The offset of a position in `text`; a line or character past the end is clamped. */
export const offsetOf = (text: string, p: Position): number => {
  let at = 0;
  for (let l = 0; l < p.line; l++) {
    const nl = text.indexOf("\n", at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  const end = text.indexOf("\n", at);
  return Math.min(at + p.character, end < 0 ? text.length : end);
};

/** Formatting edits as changes against the original text, sorted; edits that change nothing are left out. */
export const editsToChanges = (text: string, edits: TextEdit[]): Change[] =>
  edits
    .map((e) => ({ from: offsetOf(text, e.range.start), to: offsetOf(text, e.range.end), insert: e.newText }))
    .filter((c) => text.slice(c.from, c.to) !== c.insert)
    .sort((a, b) => a.from - b.from || a.to - b.to);

/** Applies sorted, non-overlapping changes made against `text`. */
export const applyChanges = (text: string, changes: Change[]): string =>
  [...changes].reverse().reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), text);

/** The server's numbers (5 per token, positions relative to the previous token) as absolute tokens. */
export const decodeSemanticTokens = (data: number[], legend: Legend): SemanticToken[] => {
  const out: SemanticToken[] = [];
  let line = 0;
  let start = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const [dl, ds, length, ti, mods] = data.slice(i, i + 5);
    line += dl;
    start = dl ? ds : start + ds;
    const type = legend.tokenTypes[ti];
    if (!type) continue;
    out.push({ line, start, length, type, modifiers: legend.tokenModifiers.filter((_, b) => mods & (1 << b)) });
  }
  return out;
};

/**
 * The class a token type is drawn with, after Golem's tools/editors/README.md:
 * the parts of commands are command-coloured, values expression-coloured, the
 * heading's # a faint mark and its text the heading; macro is an escape in .gm.
 */
export const classOf = (type: string, text: string, kind = "gm"): TokenClass | null => {
  if (type === "keyword" && /^#+$/.test(text)) return "mark";
  if (type === "namespace" && kind === "gm") return "heading";
  if (type === "comment") return "comment";
  if (type === "macro") return kind === "gm" ? "escape" : "cmd";
  if (["keyword", "function", "decorator", "operator", "namespace"].includes(type)) return "cmd";
  if (["string", "number", "variable", "parameter", "type", "typeParameter", "enumMember", "property"].includes(type)) return "expr";
  return null;
};

/** Tokens as ranges of the editor's document, each with its class. */
export const tokenRanges = (text: string, tokens: SemanticToken[], kind = "gm"): TokenRange[] =>
  tokens.flatMap((t) => {
    const from = offsetOf(text, { line: t.line, character: t.start });
    const to = offsetOf(text, { line: t.line, character: t.start + t.length });
    const cls = classOf(t.type, text.slice(from, to), kind);
    return cls && to > from ? [{ from, to, cls }] : [];
  });

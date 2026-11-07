// Reading each kind of sheet into coloured tokens, one line at a time
// (docs/adr/0019). A language takes a line and the state at its start, and
// gives the line's tokens and the state at its end. The highlighter keeps the
// states and reads again only from a changed line until the states agree.
import { startState as gmStart, tokenizeLine as gmLine, type LineState } from "../gm.ts";
import type { Text } from "./text.ts";

export type Token = { from: number; to: number; cls: string };
export type Language<S> = { start: () => S; line: (text: string, state: S) => { tokens: Token[]; state: S } };

/** A small scanner over one line. */
const scan = (text: string) => {
  let pos = 0;
  const out: Token[] = [];
  const s = {
    get pos() {
      return pos;
    },
    eol: () => pos >= text.length,
    sol: () => pos === 0,
    /** Matches `re` at the position; on success moves past it and, with a class, adds a token. */
    match: (re: RegExp, cls?: string): RegExpExecArray | null => {
      const r = new RegExp(re.source, re.flags.includes("y") ? re.flags : re.flags + "y");
      r.lastIndex = pos;
      const m = r.exec(text);
      if (!m || !m[0].length) return null;
      if (cls) s.push(pos, pos + m[0].length, cls);
      pos += m[0].length;
      return m;
    },
    push: (from: number, to: number, cls: string) => {
      const last = out[out.length - 1];
      if (last && last.cls === cls && last.to === from) last.to = to;
      else if (to > from) out.push({ from, to, cls });
    },
    skip: (n = 1) => void (pos = Math.min(text.length, pos + n)),
    rest: (cls: string) => {
      s.push(pos, text.length, cls);
      pos = text.length;
    },
    tokens: () => out,
  };
  return s;
};

// ---- .gm, from gm.ts ----

const GM_CLASS: Record<string, string> = {
  command: "t-cmd",
  expression: "t-expr",
  comment: "t-comment",
  heading: "t-heading",
  headingMark: "t-mark",
  escape: "t-escape",
  fence: "t-meta",
  code: "t-code",
};

const gm: Language<LineState> = {
  start: gmStart,
  line: (text, state) => {
    const r = gmLine(text, state);
    return { tokens: r.tokens.map((t) => ({ from: t.from, to: t.to, cls: GM_CLASS[t.type] })), state: r.state };
  },
};

// ---- .emet (Haskell-like) ----

const EMET_KEYWORDS = /(pub|inline|block|filter|fn|import|as|where|case|of|let|in|if|then|else|data|type|otherwise)\b/;

const emet: Language<{ comment: boolean }> = {
  start: () => ({ comment: false }),
  line: (text, state) => {
    const s = scan(text);
    let comment = state.comment;
    while (!s.eol()) {
      if (comment) {
        if (s.match(/.*?-\}/, "t-comment")) comment = false;
        else s.rest("t-comment");
        continue;
      }
      if (s.match(/\s+/)) continue;
      if (s.match(/\{-/, "t-comment")) {
        comment = true;
        continue;
      }
      if (s.match(/--.*/, "t-comment")) continue;
      if (s.match(/"(?:[^"\\]|\\.)*"?/, "t-string")) continue;
      if (s.match(/\d+(\.\d+)?/, "t-number")) continue;
      if (s.match(EMET_KEYWORDS, "t-keyword")) continue;
      if (s.match(/[A-Z][\w']*/, "t-type")) continue;
      if (s.match(/::|->|=>|==|\/=|<=|>=|&&|\|\||[=\\|+\-*/<>.]/, "t-operator")) continue;
      if (s.match(/[a-z_][\w']*/, "t-var")) continue;
      s.skip();
    }
    return { tokens: s.tokens(), state: { comment } };
  },
};

// ---- Markdown ----

const md: Language<{ fence: boolean }> = {
  start: () => ({ fence: false }),
  line: (text, state) => {
    const s = scan(text);
    if (/^\s*(```|~~~)/.test(text)) {
      s.rest("t-meta");
      return { tokens: s.tokens(), state: { fence: !state.fence } };
    }
    if (state.fence) {
      s.rest("t-code");
      return { tokens: s.tokens(), state };
    }
    if (s.match(/#{1,6}\s.*/, "t-heading")) return { tokens: s.tokens(), state };
    s.match(/\s*([-*+]|\d+[.)])\s/, "t-keyword") || s.match(/\s*>/, "t-quote");
    while (!s.eol()) {
      if (s.match(/`[^`]*`/, "t-code")) continue;
      if (s.match(/(\*\*|__)(?=\S).*?\S\1/, "t-strong")) continue;
      if (s.match(/(\*|_)(?=\S).*?\S\1/, "t-em")) continue;
      if (s.match(/!?\[[^\]]*\]\([^)]*\)/, "t-link")) continue;
      s.skip();
    }
    return { tokens: s.tokens(), state };
  },
};

// ---- TOML ----

const toml: Language<{ multi: string | null }> = {
  start: () => ({ multi: null }),
  line: (text, state) => {
    const s = scan(text);
    let multi = state.multi;
    if (multi) {
      const end = text.indexOf(multi);
      if (end < 0) {
        s.rest("t-string");
        return { tokens: s.tokens(), state };
      }
      s.push(0, end + 3, "t-string");
      s.skip(end + 3);
      multi = null;
    }
    if (s.sol() && s.match(/\s*\[\[?[^\]]*\]\]?/, "t-heading")) {
      s.match(/\s*#.*/, "t-comment");
      return { tokens: s.tokens(), state: { multi } };
    }
    let afterEq = false;
    while (!s.eol()) {
      if (s.match(/\s+/)) continue;
      if (s.match(/#.*/, "t-comment")) continue;
      const m = s.match(/"""|'''/);
      if (m) {
        const close = text.indexOf(m[0], s.pos);
        if (close < 0) {
          s.push(s.pos - 3, text.length, "t-string");
          return { tokens: s.tokens(), state: { multi: m[0] } };
        }
        s.push(s.pos - 3, close + 3, "t-string");
        s.skip(close + 3 - s.pos);
        continue;
      }
      if (s.match(/"(?:[^"\\]|\\.)*"?|'[^']*'?/, afterEq ? "t-string" : "t-attr")) continue;
      if (s.match(/=/, "t-operator")) {
        afterEq = true;
        continue;
      }
      if (afterEq && s.match(/(true|false)\b/, "t-keyword")) continue;
      if (afterEq && s.match(/[+-]?\d[\d_:.eE+-]*(T[\d:.]+)?Z?/, "t-number")) continue;
      if (!afterEq && s.match(/[\w.-]+/, "t-attr")) continue;
      if (s.match(/[,{}[\]]/)) {
        if (/[{,]/.test(text[s.pos - 1])) afterEq = false;
        continue;
      }
      s.skip();
    }
    return { tokens: s.tokens(), state: { multi } };
  },
};

// ---- XML (SVG) ----

const xml: Language<{ comment: boolean; inTag: boolean }> = {
  start: () => ({ comment: false, inTag: false }),
  line: (text, state) => {
    const s = scan(text);
    let { comment, inTag } = state;
    while (!s.eol()) {
      if (comment) {
        if (s.match(/.*?-->/, "t-comment")) comment = false;
        else s.rest("t-comment");
        continue;
      }
      if (inTag) {
        if (s.match(/\s+/)) continue;
        if (s.match(/\/?>|\?>/, "t-tag")) {
          inTag = false;
          continue;
        }
        if (s.match(/[\w:.-]+/, "t-attr")) continue;
        if (s.match(/=/, "t-operator")) continue;
        if (s.match(/"[^"]*"?|'[^']*'?/, "t-string")) continue;
        s.skip();
        continue;
      }
      if (s.match(/<!--/, "t-comment")) {
        comment = true;
        continue;
      }
      if (s.match(/<\/?[\w:.-]+|<\?[\w-]+|<!\w+/, "t-tag")) {
        inTag = true;
        continue;
      }
      s.skip();
    }
    return { tokens: s.tokens(), state: { comment, inTag } };
  },
};

// ---- Mermaid ----

const mermaid: Language<null> = {
  start: () => null,
  line: (text) => {
    const s = scan(text);
    s.match(/\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context)\b/, "t-keyword");
    while (!s.eol()) {
      if (s.match(/%%.*/, "t-comment")) continue;
      if (s.match(/(subgraph|end|participant|actor|section|title|dateFormat|class|state|note|loop|alt|else|opt|par|and|rect|direction)\b/, "t-keyword")) continue;
      if (s.match(/"(?:[^"\\]|\\.)*"/, "t-string")) continue;
      if (s.match(/\|[^|]*\|/, "t-string")) continue;
      if (s.match(/-{2,}>?|={2,}>|-\.+->?|<-+>?|->>|-->>|-x|--o|:::?/, "t-operator")) continue;
      if (s.match(/[[({][^\])}]*[\])}]/, "t-string")) continue;
      s.skip();
    }
    return { tokens: s.tokens(), state: null };
  },
};

const none: Language<null> = { start: () => null, line: () => ({ tokens: [], state: null }) };

export const languageOf = (kind: string): Language<any> => ({ gm, emet, md, toml, svg: xml, mmd: mermaid })[kind] ?? none;

// ---- the highlighter ----

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Tokens of the lines of a document, read lazily. `changed(line, removed, added)`
 * says which lines a change replaced; reading starts again from the first of them
 * and stops once a line ends in the state it ended in before.
 */
export const createHighlighter = (lang: Language<any>) => {
  // ends[i]: the state at the end of line i+1; toks[i]: its tokens; valid: lines read and still right
  let ends: unknown[] = [];
  let toks: Token[][] = [];
  let valid = 0;
  let dirtyTo = 0; // the last changed line: reading goes at least this far before trusting old states
  let read = 0;
  const readUpTo = (doc: Text, n: number) => {
    const target = Math.min(n, doc.lines);
    while (valid < target) {
      const i = valid;
      const startState = i === 0 ? lang.start() : ends[i - 1];
      const r = lang.line(doc.line(i + 1).text, startState);
      read++;
      const before = ends[i];
      ends[i] = r.state;
      toks[i] = r.tokens;
      valid = i + 1;
      // past the changed lines with the same end state: the rest is still right
      if (valid >= dirtyTo && before !== undefined && same(before, r.state) && ends.length > valid) {
        valid = Math.min(ends.length, doc.lines);
        dirtyTo = 0;
      }
    }
  };
  return {
    tokens: (doc: Text, line: number): Token[] => {
      readUpTo(doc, line);
      return toks[line - 1] ?? [];
    },
    /** Lines `line`..`line+removed-1` were replaced by `added` lines (default: one line changed). */
    changed: (line: number, removed = 1, added = removed) => {
      // lines changed in place keep their old end states for the comparison; inserted lines have none
      if (removed !== added) {
        ends.splice(line - 1, removed, ...new Array(added).fill(undefined));
        toks.splice(line - 1, removed, ...new Array(added).fill([]));
      }
      // the line after the changed ones keeps its old end state for the comparison
      valid = Math.min(valid, line - 1);
      dirtyTo = Math.max(dirtyTo, line - 1 + added);
    },
    reset: () => {
      ends = [];
      toks = [];
      valid = 0;
      dirtyTo = 0;
    },
    stats: () => ({ read }),
  };
};

export type Highlighter = ReturnType<typeof createHighlighter>;

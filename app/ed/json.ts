// JSON, JSONC, JSON5 and JSON Lines (docs/adr/0021): our own lexer, a checker
// that reports the first error (and warnings) at UTF-16 offsets, and a
// formatter that only rewrites the space between tokens, so numbers, strings,
// comments, bare keys and trailing commas stay as written.
import type { Diag } from "./diag.ts";

export type Flavor = "json" | "jsonc" | "json5" | "jsonl";

export const JSON_KINDS: Flavor[] = ["json", "jsonc", "json5", "jsonl"];
export const isJsonKind = (kind: string): kind is Flavor => (JSON_KINDS as string[]).includes(kind);

type Err = { at: number; message: string };
export type Tok =
  | { t: "punct"; from: number; to: number; text: string; err?: Err }
  | { t: "string"; from: number; to: number; text: string; value: string; err?: Err }
  | { t: "number" | "word" | "comment" | "bad"; from: number; to: number; text: string; err?: Err };

const JSON_SPACE = /[ \t\n\r]/;
// JSON5 whitespace: also vertical tab, form feed, NBSP, line and paragraph separators, BOM and Zs
const JSON5_SPACE = /[ \t\n\r\v\f\u00a0\u2028\u2029\ufeff\p{Zs}]/u;
const WORD = /[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/uy;
const NUMBER = /[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]*|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d*)?)?/y;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const JSON5_NUMBER = /^[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;
const LEADING_ZERO = /^[+-]?0\d/;
const JSON_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const JSON5_ESCAPES: Record<string, string> = { ...JSON_ESCAPES, "'": "'", v: "\v" };
const isLineEnd = (c: string, json5: boolean) => c === "\n" || c === "\r" || (json5 && (c === "\u2028" || c === "\u2029"));
const HEX = /^[0-9a-fA-F]+$/;

const lexString = (src: string, from: number, json5: boolean, flavorJson: boolean): Tok => {
  const q = src[from];
  let i = from + 1;
  let value = "";
  let err: Err | undefined = !json5 && q === "'" ? { at: from, message: "単一引用符は JSON では使えない" } : undefined;
  const fail = (at: number, message: string) => void (err ??= { at, message });
  for (;;) {
    if (i >= src.length || (isLineEnd(src[i], false) && !(json5 && src[i - 1] === "\\"))) {
      // unterminated: the token runs to the end of the line
      return { t: "string", from, to: i, text: src.slice(from, i), value, err: { at: from, message: "閉じていない文字列" } };
    }
    const c = src[i];
    if (c === q) return { t: "string", from, to: i + 1, text: src.slice(from, i + 1), value, err };
    if (c === "\\") {
      const n = src[i + 1] ?? "";
      if (json5 && isLineEnd(n, true)) {
        i += n === "\r" && src[i + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (n === "u") {
        const h = src.slice(i + 2, i + 6);
        if (h.length === 4 && HEX.test(h)) value += String.fromCharCode(parseInt(h, 16));
        else fail(i, "使えないエスケープ");
        i += 6;
        continue;
      }
      if (json5 && n === "x") {
        const h = src.slice(i + 2, i + 4);
        if (h.length === 2 && HEX.test(h)) value += String.fromCharCode(parseInt(h, 16));
        else fail(i, "使えないエスケープ");
        i += 4;
        continue;
      }
      if (json5 && n === "0" && !/\d/.test(src[i + 2] ?? "")) {
        value += "\0";
        i += 2;
        continue;
      }
      const table = json5 ? JSON5_ESCAPES : JSON_ESCAPES;
      if (n in table) value += table[n];
      else if (json5 && n !== "" && !/\d/.test(n)) value += n; // JSON5 keeps an unknown escaped character
      else fail(i, "使えないエスケープ");
      i += 2;
      continue;
    }
    if (flavorJson && c.charCodeAt(0) < 0x20) fail(i, "文字列の中の制御文字");
    value += c;
    i++;
  }
};

/** The tokens of a document (comments included); errors ride on the tokens and are reported in order by the checker. */
export const lex = (src: string, flavor: Flavor): Tok[] => {
  const json5 = flavor === "json5";
  const space = json5 ? JSON5_SPACE : JSON_SPACE;
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (space.test(c)) {
      i++;
      continue;
    }
    if ("{}[]:,".includes(c)) {
      out.push({ t: "punct", from: i, to: i + 1, text: c });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const s = lexString(src, i, json5, !json5);
      out.push(s);
      i = s.to;
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      let to: number;
      let err: Err | undefined;
      if (src[i + 1] === "/") {
        to = i + 2;
        while (to < src.length && !isLineEnd(src[to], json5)) to++;
      } else {
        const end = src.indexOf("*/", i + 2);
        if (end < 0) {
          to = src.length;
          err = { at: i, message: "閉じていないコメント" };
        } else to = end + 2;
      }
      out.push({ t: "comment", from: i, to, text: src.slice(i, to), err });
      i = to;
      continue;
    }
    if (/[\d.+-]/.test(c)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src)![0] || c;
      const ok = json5 ? JSON5_NUMBER : JSON_NUMBER;
      const err = ok.test(m) ? undefined : { at: i, message: LEADING_ZERO.test(m) ? "先頭に 0 が続く数" : "数の書き方の誤り" };
      out.push({ t: "number", from: i, to: i + m.length, text: m, err });
      i += m.length;
      continue;
    }
    WORD.lastIndex = i;
    const w = WORD.exec(src);
    if (w) {
      out.push({ t: "word", from: i, to: i + w[0].length, text: w[0] });
      i += w[0].length;
      continue;
    }
    const cp = String.fromCodePoint(src.codePointAt(i)!);
    out.push({ t: "bad", from: i, to: i + cp.length, text: cp, err: { at: i, message: "使えない文字" } });
    i += cp.length;
  }
  return out;
};

// ---- the checker ----

const MAX_DEPTH = 1000;

const checkOne = (src: string, flavor: Exclude<Flavor, "jsonl">, base = 0): Diag[] => {
  const toks = lex(src, flavor);
  const diags: Diag[] = [];
  const warn = (at: number, len: number, message: string) => diags.push({ from: base + at, to: base + at + len, severity: "warning", message });
  let p = 0;
  type Stop = { stop: Err };
  const stop = (at: number, message: string): Stop => ({ stop: { at, message } });
  const literalOk = (w: string) => w === "true" || w === "false" || w === "null" || (flavor === "json5" && (w === "Infinity" || w === "NaN"));

  /** The next token that is not a comment (comments are refused in JSON). */
  const next = (consume: boolean): Tok | null => {
    let k = p;
    for (; k < toks.length; k++) {
      const t = toks[k];
      if (t.t !== "comment") break;
      if (t.err) throw stop(t.err.at, t.err.message);
      if (flavor === "json") throw stop(t.from, "コメントは JSON では使えない");
    }
    const t = toks[k] ?? null;
    if (consume) p = k + 1;
    return t;
  };
  const errOf = (t: Tok) => {
    if (t.err) throw stop(t.err.at, t.err.message);
  };

  const value = (depth: number): void => {
    if (depth > MAX_DEPTH) throw stop(src.length, "入れ子が深すぎる");
    const t = next(true);
    if (!t) throw stop(src.length, "閉じていない括弧");
    errOf(t);
    if (t.t === "punct" && t.text === "{") return object(depth);
    if (t.t === "punct" && t.text === "[") return array(depth);
    if (t.t === "string" || t.t === "number") return;
    if (t.t === "word" && literalOk(t.text)) return;
    if (t.t === "punct") throw stop(t.from, "値がない");
    throw stop(t.from, "使えない文字");
  };

  /** After a comma: a closing bracket here is a trailing comma. */
  const trailing = (comma: Tok, close: string): boolean => {
    const t = next(false);
    if (!(t && t.t === "punct" && t.text === close)) return false;
    if (flavor === "json") throw stop(comma.from, "末尾のカンマ");
    if (flavor === "jsonc") warn(comma.from, 1, "末尾のカンマ");
    next(true);
    return true;
  };

  const object = (depth: number): void => {
    const seen = new Set<string>();
    const first = next(false);
    if (first && first.t === "punct" && first.text === "}") return void next(true);
    for (;;) {
      const k = next(true);
      if (!k) throw stop(src.length, "閉じていない括弧");
      errOf(k);
      let key: string;
      if (k.t === "string") key = k.value;
      else if (k.t === "word" && flavor === "json5") key = k.text;
      else if (k.t === "punct" && k.text !== "{" && k.text !== "[") throw stop(k.from, "値がない");
      else throw stop(k.from, flavor === "json5" ? "キーが文字列か名前でない" : "キーが文字列でない");
      if (seen.has(key)) warn(k.from, k.to - k.from, "キーが重なっている");
      seen.add(key);
      const colon = next(true);
      if (!colon) throw stop(src.length, "閉じていない括弧");
      if (!(colon.t === "punct" && colon.text === ":")) throw stop(colon.from, "コロンがない");
      value(depth + 1);
      const sep = next(true);
      if (!sep) throw stop(src.length, "閉じていない括弧");
      errOf(sep);
      if (sep.t === "punct" && sep.text === "}") return;
      if (!(sep.t === "punct" && sep.text === ",")) throw stop(sep.from, "カンマか閉じ括弧がない");
      if (trailing(sep, "}")) return;
    }
  };

  const array = (depth: number): void => {
    const first = next(false);
    if (first && first.t === "punct" && first.text === "]") return void next(true);
    for (;;) {
      value(depth + 1);
      const sep = next(true);
      if (!sep) throw stop(src.length, "閉じていない括弧");
      errOf(sep);
      if (sep.t === "punct" && sep.text === "]") return;
      if (!(sep.t === "punct" && sep.text === ",")) throw stop(sep.from, "カンマか閉じ括弧がない");
      if (trailing(sep, "]")) return;
    }
  };

  try {
    if (!next(false)) throw stop(src.length, "空の文書");
    value(0);
    const rest = next(true);
    if (rest) throw stop(rest.from, "値の後に余計な文字がある");
  } catch (e) {
    if (!(e && typeof e === "object" && "stop" in e)) throw e;
    const s = (e as Stop).stop;
    diags.push({ from: base + s.at, to: base + Math.min(src.length, s.at + 1), severity: "error", message: s.message });
  }
  return diags;
};

/** The lines of a JSON Lines document with their offsets; the empty piece after the final line break is not a line. */
const jsonLines = (src: string) => {
  const parts = src.split("\n");
  let at = 0;
  return parts.flatMap((raw, i) => {
    const from = at;
    at += raw.length + 1;
    if (i === parts.length - 1 && raw === "") return [];
    return [{ from, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw }];
  });
};

/** Errors (the first one; for JSON Lines, the first of each line) and warnings of a document. */
export const checkJson = (src: string, flavor: Flavor): Diag[] => {
  if (flavor !== "jsonl") return checkOne(src, flavor);
  return jsonLines(src).flatMap((l) =>
    l.text.trim() === "" ? [{ from: l.from, to: l.from, severity: "error" as const, message: "空の行" }] : checkOne(l.text, "json", l.from),
  );
};

// ---- the formatter ----

const INDENT = "  ";
const newlines = (s: string) => (s.match(/\n/g) ?? []).length;

/** One value on one line, a space after each colon and comma (for JSON Lines). */
const compact = (toks: Tok[]) =>
  toks
    .map((t, i) => {
      const n = toks[i + 1];
      return t.t === "punct" && (t.text === ":" || t.text === ",") && n ? t.text + " " : t.text;
    })
    .join("");

/** The document with its tokens laid out again, or null when it has an error. */
export const formatJson = (src: string, flavor: Flavor): string | null => {
  if (checkJson(src, flavor).some((d) => d.severity === "error")) return null;
  if (flavor === "jsonl") return jsonLines(src).map((l) => compact(lex(l.text, "json"))).join("\n") + "\n";
  const toks = lex(src, flavor);
  const lines: string[] = [];
  let cur = "";
  let depth = 0;
  let needBreak = false;
  let afterColon = false;
  const startsLine = () => cur === "";
  const breakLine = () => {
    if (cur !== "") lines.push(cur);
    cur = "";
  };
  const open = (gap: string) => {
    breakLine();
    if (newlines(gap) >= 2 && lines.length) lines.push("");
    cur = INDENT.repeat(depth);
  };
  const sig = (k: number) => {
    for (let j = k; j < toks.length; j++) if (toks[j].t !== "comment") return toks[j];
    return null;
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];
    const gap = prev ? src.slice(prev.to, t.from) : "";
    if (t.t === "comment") {
      if (prev && newlines(gap) === 0 && !startsLine()) cur += " " + t.text;
      else {
        open(gap);
        cur += t.text;
      }
      needBreak = true;
      afterColon = false;
      continue;
    }
    const isClose = t.t === "punct" && (t.text === "}" || t.text === "]");
    if (isClose) {
      depth--;
      const emptied = prev && prev.t === "punct" && (prev.text === "{" || prev.text === "[") && cur.endsWith(prev.text) && !needBreakFromComment(toks, k);
      if (emptied) {
        cur += t.text;
        needBreak = false;
      } else {
        open(gap);
        cur += t.text;
        needBreak = false;
      }
      afterColon = false;
      continue;
    }
    if (needBreak) {
      open(gap);
      needBreak = false;
    } else if (afterColon) cur += " ";
    afterColon = false;
    cur += t.text;
    if (t.t === "punct" && (t.text === "{" || t.text === "[")) {
      depth++;
      const n = sig(k + 1);
      const closesNext = n && n.t === "punct" && n.text === (t.text === "{" ? "}" : "]") && toks[k + 1] === n;
      needBreak = !closesNext;
    } else if (t.t === "punct" && t.text === ",") needBreak = true;
    else if (t.t === "punct" && t.text === ":") afterColon = true;
  }
  breakLine();
  return lines.join("\n") + "\n";
};

/** Whether a comment stands between an opening bracket and the token at k. */
const needBreakFromComment = (toks: Tok[], k: number) => toks[k - 1]?.t === "comment";

// ---- ⌘S ----

/** ⌘S: formats first when the setting is on (with the same notices as ⌥⇧F), then saves either way. */
export const formatThenSave = async (o: {
  formatOnSave: boolean;
  /** A save the writer asked for (⌘S); an autosave (false) never formats (docs/adr/0021). */
  explicit?: boolean;
  format: () => "changed" | "same" | "error";
  save: () => Promise<unknown>;
  notify: (message: string) => void;
}) => {
  if (o.formatOnSave && o.explicit !== false) {
    const r = o.format();
    o.notify(r === "error" ? "JSON に誤りがあるため整形しません" : r === "changed" ? "整形しました" : "変更はありません");
  }
  await o.save();
};

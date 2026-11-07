// Wikilinks in Markdown sheets (docs/adr/0027): reading [[target#heading|label]],
// finding the target among the workspace's sheets, the index of links and
// backlinks, completion after [[ and #, and the edits a rename asks for.
// Pure, so that node --test can run it.

export type Wikilink = {
  /** The whole link, `[[` to `]]`, in UTF-16 units of the text. */
  from: number;
  to: number;
  /** The target as written (trimmed); "" for a heading of the same sheet. */
  target: string;
  targetFrom: number;
  targetTo: number;
  heading: string | null;
  label: string | null;
};

/** A sheet the links can point at: its path, and its name (first heading) where it has one. */
export type Sheet = { path: string; title?: string };

// the text kinds, and the images an embed shows (docs/adr/0029)
const TEXT_EXT = /\.(md|gm|emet|txt|toml|csv|tsv|svg|mmd|json|jsonc|json5|jsonl|png|jpe?g|gif|webp)$/i;

/** The links of one line (not inside a code span). */
const lineLinks = (line: string, offset: number): Wikilink[] => {
  const out: Wikilink[] = [];
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = /^`+/.exec(line.slice(i))![0];
      const end = line.indexOf(run, i + run.length);
      i = end < 0 ? i + run.length : end + run.length;
      continue;
    }
    if (c === "[" && line[i + 1] === "[") {
      const close = line.indexOf("]]", i + 2);
      const inner = close < 0 ? "" : line.slice(i + 2, close);
      if (close < 0 || !inner.trim() || inner.includes("[") || inner.includes("]")) {
        i += 2;
        continue;
      }
      const bar = inner.indexOf("|");
      const dest = bar < 0 ? inner : inner.slice(0, bar);
      const label = bar < 0 ? null : inner.slice(bar + 1).trim() || null;
      const hash = dest.indexOf("#");
      const rawTarget = hash < 0 ? dest : dest.slice(0, hash);
      const heading = hash < 0 ? null : dest.slice(hash + 1).trim() || null;
      const lead = rawTarget.length - rawTarget.trimStart().length;
      const target = rawTarget.trim();
      if (!target && !heading) {
        i = close + 2;
        continue;
      }
      const targetFrom = offset + i + 2 + lead;
      out.push({ from: offset + i, to: offset + close + 2, target, targetFrom, targetTo: targetFrom + target.length, heading, label });
      i = close + 2;
      continue;
    }
    i++;
  }
  return out;
};

/** Every link of a Markdown text, skipping fenced code blocks. */
export const parseWikilinks = (text: string): Wikilink[] => {
  const out: Wikilink[] = [];
  let fence = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence) out.push(...lineLinks(line, offset));
    offset += line.length + 1;
  }
  return out;
};

const nfc = (s: string) => s.normalize("NFC");
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stemOf = (p: string) => baseOf(p).replace(/\.[^.]+$/, "");

/** Folders between two paths: steps up from `a` to the common ancestor, then down to `b`. */
const distance = (a: string, b: string) => {
  const x = dirOf(a).split("/");
  const y = dirOf(b).split("/");
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k]) k++;
  return x.length - k + (y.length - k);
};

/** Resolves "a/../b" and "./" in a path. */
const normalizePath = (p: string) => {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return "/" + out.join("/");
};

const KIND_ORDER = (p: string) => (p.endsWith(".md") ? 0 : p.endsWith(".gm") ? 1 : 2);

type Detail = { path: string | null; ambiguous: boolean; via: "path" | "name" | "title" | null; relative: boolean };

/** Picks among candidates: the linking sheet's folder, then the nearest, then by path. */
const pick = (cands: string[], from: string, byKind: boolean) => {
  const sorted = [...cands].sort(
    (a, b) => (byKind ? KIND_ORDER(a) - KIND_ORDER(b) : 0) || distance(from, a) - distance(from, b) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const best = sorted[0];
  const tie = sorted.filter((p) => (!byKind || KIND_ORDER(p) === KIND_ORDER(best)) && distance(from, p) === distance(from, best));
  return { path: best, ambiguous: tie.length > 1 };
};

const resolveDetail = (target: string, from: string, sheets: Sheet[], ws: string): Detail => {
  const t = nfc(target);
  const paths = new Map(sheets.map((s) => [nfc(s.path), s.path]));
  if (t.includes("/") || TEXT_EXT.test(t)) {
    const withExt = TEXT_EXT.test(t) ? t : `${t}.md`;
    const rel = normalizePath(`${dirOf(from)}/${withExt}`);
    if (paths.has(rel)) return { path: paths.get(rel)!, ambiguous: false, via: "path", relative: true };
    const root = normalizePath(`${ws}/${withExt}`);
    if (paths.has(root)) return { path: paths.get(root)!, ambiguous: false, via: "path", relative: false };
    return { path: null, ambiguous: false, via: null, relative: false };
  }
  const byName = sheets.filter((s) => nfc(stemOf(s.path)) === t).map((s) => s.path);
  if (byName.length) return { ...pick(byName, from, true), via: "name", relative: false };
  const byTitle = sheets.filter((s) => s.title !== undefined && nfc(s.title) === t).map((s) => s.path);
  if (byTitle.length) return { ...pick(byTitle, from, false), via: "title", relative: false };
  return { path: null, ambiguous: false, via: null, relative: false };
};

/** The sheet a link's target points at; `ambiguous` when several matched equally (the first by path is taken). */
export const resolveLink = (target: string, from: string, sheets: Sheet[], ws: string): { path: string | null; ambiguous: boolean } => {
  const d = resolveDetail(target, from, sheets, ws);
  return { path: d.path, ambiguous: d.ambiguous };
};

/** The 1-based line of a heading with that text (`#` lines of .md outside code, heading lines of .gm), or null. */
export const findHeading = (text: string, kind: string, heading: string): number | null => {
  const want = nfc(heading.trim());
  let fence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (m && nfc(m[1]) === want) return i + 1;
    // .gm headings are written the same way (docs/adr/0019's lexer marks them t-heading)
    if (kind !== "md" && kind !== "gm") break;
  }
  return null;
};

// ---- the index ----

export type Link = { from: string; line: number; text: string; link: Wikilink; to: string | null; ambiguous: boolean };
export type Index = { links: Link[] };

/** The links of every Markdown sheet, resolved. */
export const buildIndex = (texts: Map<string, string>, sheets: Sheet[], ws: string): Index => ({
  links: [...texts].flatMap(([from, text]) => {
    const lines = text.split("\n");
    const starts: number[] = [];
    let o = 0;
    for (const l of lines) starts.push(o), (o += l.length + 1);
    return parseWikilinks(text).map((link) => {
      let n = starts.length - 1;
      while (n > 0 && starts[n] > link.from) n--;
      const r = link.target ? resolveLink(link.target, from, sheets, ws) : { path: from, ambiguous: false };
      return { from, line: n + 1, text: lines[n], link, to: r.path, ambiguous: r.ambiguous };
    });
  }),
});

/** The links pointing at a sheet from other sheets, by sheet and line. */
export const backlinks = (idx: Index, path: string): Link[] =>
  idx.links.filter((l) => l.to === path && l.from !== path).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line));

/** The links going out of a sheet. */
export const outlinks = (idx: Index, path: string): Link[] => idx.links.filter((l) => l.from === path);

// ---- completion ----

export type Item = { label: string; detail?: string; apply: string };

/**
 * Completion at a position: after `[[`, the sheets' file names and names
 * starting with what was typed; after `[[target#`, the target's headings.
 */
export const completeAt = (text: string, pos: number, sheets: Sheet[], read: (path: string) => string, from = "", ws = ""): { from: number; items: Item[] } | null => {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const open = before.lastIndexOf("[[");
  if (open < 0 || before.slice(open).includes("]]") || before.slice(open).includes("|")) return null;
  const typed = before.slice(open + 2);
  const closed = text.startsWith("]]", pos);
  const end = closed ? "" : "]]";
  const hash = typed.indexOf("#");
  if (hash >= 0) {
    const target = typed.slice(0, hash).trim();
    const q = typed.slice(hash + 1);
    const path = target ? resolveLink(target, from, sheets, ws).path : from;
    if (!path) return null;
    const kind = path.slice(path.lastIndexOf(".") + 1);
    const heads = read(path)
      .split("\n")
      .flatMap((l) => {
        const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
        return m && (kind === "md" || kind === "gm") ? [m[1]] : [];
      });
    const items = [...new Set(heads)].filter((h) => h.startsWith(q)).map((h) => ({ label: h, apply: h + end }));
    return { from: lineStart + open + 2 + hash + 1, items };
  }
  const names = new Map<string, string>();
  for (const s of sheets) {
    const stem = stemOf(s.path);
    if (stem.startsWith(typed) && !names.has(stem)) names.set(stem, s.path);
    if (s.title && s.title.startsWith(typed) && !names.has(s.title)) names.set(s.title, s.path);
  }
  const items = [...names].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([label, path]) => ({ label, detail: path, apply: label + end }));
  return { from: lineStart + open + 2, items };
};

// ---- renames ----

/**
 * The edits that make a sheet's links follow a renamed file: links by path
 * get the new path (written from the same base, with an extension only if
 * they had one), links by file name the new file name. Links by sheet name,
 * labels and headings stay.
 */
export const renameEdits = (text: string, from: string, oldPath: string, newPath: string, sheets: Sheet[], ws: string): { from: number; to: number; insert: string }[] =>
  parseWikilinks(text).flatMap((l) => {
    if (!l.target) return [];
    const d = resolveDetail(l.target, from, sheets, ws);
    if (d.path !== oldPath || (d.via !== "path" && d.via !== "name")) return [];
    let insert: string;
    if (d.via === "name") insert = stemOf(newPath);
    else {
      const base = d.relative ? dirOf(from) : ws;
      const rel = relPath(base, newPath);
      insert = TEXT_EXT.test(l.target) ? rel : rel.replace(/\.md$/, "");
    }
    return insert === l.target ? [] : [{ from: l.targetFrom, to: l.targetTo, insert }];
  });

/** A path from a folder, with ../ where it has to climb. */
const relPath = (dir: string, path: string) => {
  const a = dir.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  let k = 0;
  while (k < a.length && k < b.length - 1 && a[k] === b[k]) k++;
  return [...Array(a.length - k).fill(".."), ...b.slice(k)].join("/");
};

const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** The preview's wikilinks whose target is not found get the class `missing` (docs/adr/0027). */
export const markMissing = (html: string, found: (target: string) => boolean): string =>
  html.replace(/<a class="wikilink" data-wikilink="([^"]*)"/g, (m, t: string) => (!t || found(unesc(t)) ? m : `<a class="wikilink missing" data-wikilink="${t}"`));

export type BacklinkGroup = { from: string; count: number; lines: { line: number; text: string }[] };

/** Backlinks by linking sheet (path order), each line once (line order), with the counts of sheets and links (docs/adr/0038). */
export const groupBacklinks = (links: Link[]): { groups: BacklinkGroup[]; sheets: number; links: number } => {
  const by = new Map<string, BacklinkGroup>();
  for (const l of links) {
    const g = by.get(l.from) ?? { from: l.from, count: 0, lines: [] };
    g.count++;
    if (!g.lines.some((x) => x.line === l.line)) g.lines.push({ line: l.line, text: l.text });
    by.set(l.from, g);
  }
  const groups = [...by.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)).map((g) => ({ ...g, lines: g.lines.sort((a, b) => a.line - b.line) }));
  return { groups, sheets: groups.length, links: links.length };
};

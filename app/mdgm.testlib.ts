// What the tests of the conversion to gm share (docs/adr/0061): a seeded generator of
// Markdown, the boundary inputs, golem (bundled, or on PATH), and the visible text the
// Markdown should keep. Only tests import this file.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseMarkdown, wikiText, type Block, type Inline } from "./md.ts";
import { golemUrl, placeImage } from "./mdgm.ts";

/** A seeded pseudo-random generator (mulberry32). */
export const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const FRAGMENTS = [
  "#", "# ", "## ", "- ", "1. ", "3) ", "> ", "|", "|---", "| a | b |\n|---|---|\n", "```", "~~~", "`", "*", "**", "_", "__", "~~",
  "[", "]", "[[", "]]", "![", "](", ")", "(", "\\", "%", "%%", "##1", "@", "=", "&amp;", "&#x41;", "&nbsp;", "http://x.y/", "https://例.jp/a b",
  "www.a.b", "あ", "漢字", "x.png", "img.gif", "\r\n", "﻿", "[ ] ", "[x] ", " ", "  ", "    ", "\t", "\n", "\n\n", "\u0007", "\u0000", "￿",
  "a", "word", "Title\n===\n", "---\n", "[r]: https://r.example/x\n", "[r]", "<https://a.b>", "<a@b.c>", '"', "'", ":", "+", "!", ">", "<",
];

/** A Markdown text of up to `n` fragments. */
export const generate = (r: () => number, n = 24): string => {
  const k = 1 + Math.floor(r() * n);
  let s = "";
  for (let i = 0; i < k; i++) s += FRAGMENTS[Math.floor(r() * FRAGMENTS.length)];
  return s;
};

/** The boundary inputs of docs/adr/0061's table. */
export const BOUNDARY: string[] = [
  "", "\n\n\n", "   \n  ", "﻿", "﻿# 見出し\n", "一つの段落", "一行",
  "%", "%%", "%%%", "\\%%%",
  "| a |\n|---|\n| 1 |\n", "| a | b |\n|---|---|\n", "| a | b | c |\n|---|---|---|\n| 1 |\n", "| a |\n|---|\n| 1 | 2 | 3 |\n", "| a | b |\n|---|---|\n|  |  |\n",
  "```\na\n```\nb\n```\n", "````\n```\n````\n", "```\n```   \n", "```\n開いたまま", "```\na\n`````\n",
  "- \n", "- \n  - \n", "-\n", "0. a\n", "1. a\n", "2. a\n", "999999999. a\n",
  "![a](x.png)\n", "# 見出し\n\n![a](x.png)\n", "![](x.png)\n", "![a\\\\](x.png)\n",
  "> 一行\n", "> ```\n> コード\n> ```\n", "> > 入れ子\n",
  "hello\nworld\n", "日本\n語の文\n", "word\n日本語\nword\n",
  "a\u0000b\n", "a\u0007b\n", "a\u000Bb\n", "a\u001Fb\n", "a￾b\n", "a￿b\n",
  "Setext\n======\n", "Setext 2\n---\n", "    indented code\n", "---\ntitle: x\n---\n本文\n",
  "[a][r]\n\n[r]: https://example.com/r\n", "&amp; &copy; &#x3042; &bogus;\n", "***x***\n", "**a\nb**\n", "```code```\n",
  "[link](https://x.y/[x])\n", "[link](https://x.y/a%20b)\n", "<http://例.jp/>\n", "![外](https://example.com/a.png)\n", "![動](a.gif)\n", "![上](/abs.png)\n",
  "[a](b \"t\") [c](<d e>)\n", "- a\n\n  段落\n\n- b\n", "- a\n  ```\n  x\n  ```\n", "1. a\n   1. b\n",
];

const LONG_UNITS = ["[", "![a", "[a](", "[[a", "_a ", "*a "];
/** The six one-line inputs of about 1 MB for I9. */
export const longLines = () => LONG_UNITS.map((u) => u.repeat(Math.ceil(1_000_000 / u.length)));

// ---- golem ----

const bundled = path.join(import.meta.dirname, "..", "src-tauri", "resources", "golem");
/** The golem to run: the bundled one, or the one on PATH; null when there is none. */
export const golemBin = (): string | null => {
  for (const g of [bundled, "golem"]) if (spawnSync(g, ["--version"]).status === 0) return g;
  return null;
};

/** In CI a missing golem fails the tests; elsewhere they are skipped (docs/adr/0061). */
export const golemSkip = (g: string | null) => (g || process.env.CI ? false : "golem is not installed");

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

export type Checked = { errors: { code: string; message: string; line: number }[]; text: string | null };

/**
 * Each gm as a chapter of one project (with its paragraph style): golem check's errors per chapter (G02033, a
 * missing file, aside), and the text build of the chapters without errors.
 */
export const checkAll = (golem: string, docs: { gm: string; sep: "blank-line" | "line" }[]): Checked[] => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "aleph-mdgm-"));
  if (spawnSync(golem, ["new", "p", "--no-fonts"], { cwd: d }).status !== 0) throw new Error("golem new failed");
  const p = path.join(d, "p");
  const name = (i: number) => `chapters/c${String(i).padStart(5, "0")}.gm`;
  const manifest = fs.readFileSync(path.join(p, "manifest.toml"), "utf8");
  const write = (ids: number[]) =>
    fs.writeFileSync(
      path.join(p, "manifest.toml"),
      manifest.replace(/^chapters = .*$/m, `chapters = [${ids.map((i) => `{ file = "${name(i)}", paragraph-separator = "${docs[i].sep}" }`).join(", ")}]`),
    );
  docs.forEach((x, i) => {
    fs.writeFileSync(path.join(p, name(i)), x.gm);
    // the images the figures name exist
    for (const m of x.gm.matchAll(/^\s*@figure "((?:[^"\\]|\\.)*)"/gm)) {
      const f = path.join(p, m[1].replace(/\\(.)/g, "$1"));
      if (!path.resolve(f).startsWith(p + path.sep)) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      if (!fs.existsSync(f)) fs.writeFileSync(f, f.toLowerCase().endsWith(".svg") ? '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' : PNG);
    }
  });
  write(docs.map((_, i) => i));
  const r = spawnSync(golem, ["check", "--format", "json"], { cwd: p, encoding: "utf8", maxBuffer: 1 << 28 });
  const all = JSON.parse(r.stderr.trim() || "[]") as { code: string; severity: string; message: string; span?: { file: string; line: number } }[];
  const out: Checked[] = docs.map(() => ({ errors: [], text: null }));
  for (const x of all) {
    const m = x.span && /^chapters\/c(\d+)\.gm$/.exec(x.span.file);
    if (m && x.severity === "error" && x.code !== "G02033") out[Number(m[1])].errors.push({ code: x.code, message: x.message, line: x.span!.line });
  }
  let ok = docs.map((_, i) => i).filter((i) => !out[i].errors.length);
  // a chapter the build rejects (an error check does not see) is an error of its own; the rest are built again
  for (let tries = 0; ok.length && tries < 20; tries++) {
    write(ok);
    const b = spawnSync(golem, ["build", "--target", "text", "--no-notices"], { cwd: p, encoding: "utf8", maxBuffer: 1 << 28 });
    if (process.env.ALEPH_MDGM_DEBUG) console.error("build", b.status, b.stderr.slice(0, 2000), p);
    if (b.status === 0) break;
    const bad = [...b.stderr.matchAll(/chapters\/c(\d+)\.gm:(\d+):\d+: error\[(G\d+)\]: (.*)/g)];
    if (!bad.length) throw new Error(`golem build failed: ${b.stderr.slice(0, 500)}`);
    for (const m of bad) out[Number(m[1])].errors.push({ code: m[3], message: m[4], line: Number(m[2]) });
    ok = ok.filter((i) => !out[i].errors.length);
  }
  if (ok.length) {
    for (const i of ok) {
      const f = path.join(p, "build", "text", "horizontal", name(i).replace(/\.gm$/, ".txt"));
      out[i].text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    }
  }
  if (!process.env.ALEPH_MDGM_DEBUG) fs.rmSync(d, { recursive: true, force: true });
  return out;
};

// ---- visible characters (I4) ----

/** Golem's text output without the numbers it puts before headings (list marks and link URLs are counted on the Markdown side). */
export const golemVisible = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^(?:第[一二三四五六七八九十百千〇零]+[章節項]|\d+(?:\.\d+)+)　/, ""))
    .join("\n");

/**
 * The characters of the Markdown the gm must keep: what the preview shows, with what docs/adr/0061 lets the
 * conversion change (figures print nothing, links show their URL after the text, task marks are characters,
 * front matter goes).
 */
export const mdVisible = (md: string, dir: string | null, resolveEmbed: (t: string) => string | null = () => null): string => {
  const inl = (xs: Inline[]): string =>
    xs
      .map((x) => {
        switch (x.t) {
          case "text":
          case "code":
            return x.v;
          case "image":
            return x.alt;
          case "wikilink":
            return wikiText(x);
          case "softbreak":
          case "hardbreak":
            return " ";
          case "link": {
            const u = golemUrl(x.href);
            const t = inl(x.c);
            if (!u) return t;
            if (!t.trim()) return "";
            return t === x.href && u === x.href && x.c.length === 1 ? u : `${t}（${u}）`;
          }
          default:
            return inl(x.c);
        }
      })
      .join("");
  const blk = (b: Block): string => {
    switch (b.t) {
      case "heading":
      case "para":
        return inl(b.c);
      case "quote":
        return b.c.map(blk).join(" ");
      case "list":
        // Golem's text output marks each item: ・, or its number
        return b.items
          .map((it, k) => (b.ordered ? `${b.start + k}.` : "・") + (it.checked === undefined ? "" : it.checked ? "☑" : "☐") + it.c.map(blk).join(" "))
          .join(" ");
      case "code":
        return b.text;
      case "table":
        return [b.head, ...b.rows].map((r) => r.map(inl).join(" ")).join(" ");
      case "image": {
        const at = placeImage(b.src, dir);
        return at.k === "figure" ? "" : at.k === "link" ? (b.alt.trim() ? `${b.alt}（${at.url}）` : at.url) : b.alt;
      }
      case "embed": {
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(b.target)) {
          const f = resolveEmbed(b.target);
          return f && /\.(png|jpe?g|svg)$/i.test(f) ? "" : (b.target.split("/").pop() ?? "").replace(/\.[^.]*$/, "");
        }
        return b.target || b.heading || "";
      }
      default:
        return "";
    }
  };
  return parseMarkdown(md.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFEFF\uFFFE\uFFFF]/g, ""))
    .map(blk)
    .join(" ");
};

/** The characters of `s` without white space, sorted: a multiset to compare. */
export const multiset = (s: string) => [...s.replace(/[\s　]/g, "")].sort().join("");

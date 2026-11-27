import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "./api.ts";
import { expandEmbeds, sectionOf } from "./embed.ts";
import type { Block } from "./md.ts";

// Fixed ASTs for embed rendering tests; Rust parser equivalence is tested in mdgm/tests.rs.
const ast: Record<string, Block[]> = {
  "# A\n![[b]]": [{ t: "heading", level: 1, c: [{ t: "text", v: "A" }] }, { t: "embed", target: "b", heading: null }],
  "# B\nびー\n![[c]]": [{ t: "heading", level: 1, c: [{ t: "text", v: "B" }] }, { t: "para", lines: [{ c: [{ t: "text", v: "びー" }], hard: false }] }, { t: "embed", target: "c", heading: null }],
  "# C\n![[d]]": [{ t: "heading", level: 1, c: [{ t: "text", v: "C" }] }, { t: "embed", target: "d", heading: null }],
  "# D\n![[e]]": [{ t: "heading", level: 1, c: [{ t: "text", v: "D" }] }, { t: "embed", target: "e", heading: null }],
  "# E": [{ t: "heading", level: 1, c: [{ t: "text", v: "E" }] }],
  "![[self]]": [{ t: "embed", target: "self", heading: null }],
  "![[y]]": [{ t: "embed", target: "y", heading: null }],
  "![[x]]": [{ t: "embed", target: "x", heading: null }],
  "![[ch.gm]]\n\n![[data.toml]]\n\n![[pic.png]]\n\n![[nope]]\n\n![[b#ない]]": (["ch.gm", "data.toml", "pic.png", "nope"].map((target): Block => ({ t: "embed", target, heading: null }))).concat([{ t: "embed", target: "b", heading: "ない" }]),
  "![[p]]": [{ t: "embed", target: "p", heading: null }],
  "一\n二": [{ t: "para", lines: [{ c: [{ t: "text", v: "一" }], hard: false }, { c: [{ t: "text", v: "二" }], hard: false }] }],
};
api.parseMarkdown = async (text) => ast[text] ?? (text.startsWith("あ") ? [{ t: "para", lines: [{ c: [{ t: "text", v: text }], hard: false }] }] : []);

const files: Record<string, string> = {
  "/w/a.md": "# A\n![[b]]", "/w/b.md": "# B\nびー\n![[c]]", "/w/c.md": "# C\n![[d]]", "/w/d.md": "# D\n![[e]]", "/w/e.md": "# E",
  "/w/self.md": "![[self]]", "/w/x.md": "![[y]]", "/w/y.md": "![[x]]", "/w/ch.gm": "# 霧笛\n[ruby: 父|ちち]は言った。", "/w/data.toml": "a = 1", "/w/pic.png": "", "/w/long.md": "あ".repeat(150_000),
};
const io = {
  resolve: (t: string) => (`/w/${t}` in files ? `/w/${t}` : `/w/${t}.md` in files ? `/w/${t}.md` : null),
  read: (p: string) => files[p] ?? null,
  plain: (src: string) => `<p>PLAIN:${src.length}</p>`,
};

test("heading section stops at the next equal heading and ignores code fences", () => {
  const md = "# 題\n## 家族\n父\n### 母\n母のこと\n## 友\n友のこと";
  assert.equal(sectionOf(md, "md", "家族"), "## 家族\n父\n### 母\n母のこと");
  assert.equal(sectionOf("## a\n```\n# 中\n```\nx\n## b", "md", "a"), "## a\n```\n# 中\n```\nx");
});

test("embeds nest three levels and reject cycles", async () => {
  const html = await expandEmbeds(files["/w/a.md"], "/w/a.md", io);
  assert.match(html, /びー/);
  assert.match(html, /<h1>D<\/h1>/);
  assert.doesNotMatch(html, /<h1>E<\/h1>/);
  assert.match(html, /入れ子が深すぎる/);
  assert.match(await expandEmbeds(files["/w/self.md"], "/w/self.md", io), /循環のため埋め込みません/);
});

test("other file kinds, image and missing targets retain their frames", async () => {
  const html = await expandEmbeds("![[ch.gm]]\n\n![[data.toml]]\n\n![[pic.png]]\n\n![[nope]]\n\n![[b#ない]]", "/w/z.md", io);
  assert.match(html, /PLAIN:/);
  assert.match(html, /<pre>a = 1<\/pre>/);
  assert.match(html, /data-src="\/w\/pic.png"/);
  assert.match(html, /見つかりません：nope/);
  assert.match(html, /見出しが見つかりません：ない/);
});

test("line-break preference applies to an embedded Markdown sheet", async () => {
  const io2 = { resolve: (t: string) => (t === "p" ? "/w/p.md" : null), read: () => "一\n二", plain: (s: string) => s };
  assert.match(await expandEmbeds("![[p]]", "/w/a.md", { ...io2, breaks: "newline" }), /一<br>二/);
  assert.match(await expandEmbeds("![[p]]", "/w/a.md", { ...io2, breaks: "blank-line" }), /一二/);
});

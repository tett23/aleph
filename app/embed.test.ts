import { test } from "node:test";
import assert from "node:assert/strict";
import { embedOf, expandEmbeds, sectionOf } from "./embed.ts";
import { parseMarkdown } from "./md.ts";
import { mdToGm } from "./mdgm.ts";

test("only a whole line ![[…]] is an embed; in a line it stays a wikilink", () => {
  assert.deepEqual(embedOf("![[人物]]"), { target: "人物", heading: null });
  assert.deepEqual(embedOf("  ![[人物#家族]] "), { target: "人物", heading: "家族" });
  assert.deepEqual(embedOf("![[images/a.png]]"), { target: "images/a.png", heading: null });
  assert.equal(embedOf("見て ![[人物]]"), null);
  assert.deepEqual(parseMarkdown("![[人物]]"), [{ t: "embed", target: "人物", heading: null }]);
  assert.deepEqual(parseMarkdown("a ![[人物]]")[0].t, "para");
});

test("a heading's section runs to the next heading of the same or a higher level", () => {
  const md = "# 題\n## 家族\n父\n### 母\n母のこと\n## 友\n友のこと";
  assert.equal(sectionOf(md, "md", "家族"), "## 家族\n父\n### 母\n母のこと");
  assert.equal(sectionOf(md, "md", "友"), "## 友\n友のこと");
  assert.equal(sectionOf(md, "md", "ない"), null);
  assert.equal(sectionOf("## a\n```\n# 中\n```\nx\n## b", "md", "a"), "## a\n```\n# 中\n```\nx");
});

const files: Record<string, string> = {
  "/w/a.md": "# A\n![[b]]",
  "/w/b.md": "# B\nびー\n![[c]]",
  "/w/c.md": "# C\n![[d]]",
  "/w/d.md": "# D\n![[e]]",
  "/w/e.md": "# E",
  "/w/self.md": "![[self]]",
  "/w/x.md": "![[y]]",
  "/w/y.md": "![[x]]",
  "/w/ch.gm": "# 霧笛\n[ruby: 父|ちち]は言った。",
  "/w/data.toml": "a = 1",
  "/w/pic.png": "",
  "/w/long.md": "あ".repeat(150_000),
};
const io = {
  resolve: (t: string) => (`/w/${t}` in files ? `/w/${t}` : `/w/${t}.md` in files ? `/w/${t}.md` : null),
  read: (p: string) => files[p] ?? null,
  plain: (src: string) => `<p>PLAIN:${src.length}</p>`,
};

test("embeds nest up to three levels; deeper ones are only noted", () => {
  const html = expandEmbeds(files["/w/a.md"], "/w/a.md", io);
  assert.ok(html.includes("びー"));
  assert.ok(html.includes("<h1>C</h1>"));
  assert.ok(html.includes("<h1>D</h1>"));
  assert.ok(!html.includes("<h1>E</h1>"));
  assert.ok(html.includes("（入れ子が深すぎるため埋め込みません）"));
});

test("a sheet embedding itself or its ancestor is noted as a loop", () => {
  assert.ok(expandEmbeds(files["/w/self.md"], "/w/self.md", io).includes("（循環のため埋め込みません）"));
  const xy = expandEmbeds(files["/w/x.md"], "/w/x.md", io);
  assert.equal(xy.split("（循環のため埋め込みません）").length - 1, 1);
});

test("each kind: .gm through plainHtml, other text in <pre>, images as images, missing noted", () => {
  const html = expandEmbeds("![[ch.gm]]\n\n![[data.toml]]\n\n![[pic.png]]\n\n![[nope]]\n\n![[b#ない]]", "/w/z.md", io);
  assert.ok(html.includes("PLAIN:"));
  assert.ok(html.includes("<pre>a = 1</pre>"));
  assert.ok(html.includes('<img data-src="/w/pic.png"'));
  assert.ok(html.includes("（見つかりません：nope）"));
  assert.ok(html.includes("（見出しが見つかりません：ない）"));
  assert.ok(html.includes('data-embed-open="/w/b.md"'));
});

test("the embedded text has a limit of 200,000 characters per preview", () => {
  const html = expandEmbeds("![[long]]\n\n![[long]]", "/w/z.md", io);
  assert.equal(html.split("あ".repeat(1000)).length > 100, true);
  assert.ok(html.includes("（長すぎるため省きました）"));
});

test("converted to gm: an image embed becomes @figure, a sheet embed its name only", () => {
  assert.equal(mdToGm("![[images/a.png]]\n\n![[人物#家族]]", "blank-line"), "@figure images/a.png\n\n人物\n");
});

test("the embedded Markdown follows the line-break setting (docs/adr/0035)", () => {
  const io2 = { resolve: (t: string) => (t === "p" ? "/w/p.md" : null), read: () => "一\n二", plain: (s: string) => s };
  assert.ok(expandEmbeds("![[p]]", "/w/a.md", { ...io2, breaks: "newline" }).includes("一<br>二"));
  assert.ok(expandEmbeds("![[p]]", "/w/a.md", { ...io2, breaks: "blank-line" }).includes("一二"));
});

test("an embed's frame is titled by the sheet's name, the written target beside it when different (docs/adr/0039)", () => {
  const names: Record<string, string> = { "/w/c.md": "C の章", "/w/b.md": "b" };
  const io3 = { ...io, name: (p: string) => names[p] ?? null };
  const head = (src: string) => /<div class="embed-head"[^>]*>(.*?)<\/div>/.exec(expandEmbeds(src, "/w/z.md", io3))![1];
  assert.equal(head("![[c]]"), 'C の章<small class="embed-target">c</small>');
  assert.equal(head("![[b]]"), "b");
  assert.equal(head("![[b#B]]"), "b &gt; B");
  assert.equal(head("![[e]]"), "e");
  assert.equal(head("![[nope]]"), "nope");
  assert.equal(head("![[pic.png]]"), "pic.png");
});

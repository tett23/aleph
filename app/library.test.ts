import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addPluginDecl, copyFonts, figureInsert, fontsWanted, freeName, installItem, libraryFiles, libSubdir, stateOf, type Fs } from "./library.ts";

/** The app's file operations over node:fs, for tests in a temporary directory. */
const nodeFs: Fs = {
  exists: async (p) => fs.existsSync(p),
  readBytes: async (p) => {
    const b = fs.readFileSync(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  },
  readText: async (p) => fs.readFileSync(p, "utf8"),
  writeText: async (p, t) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, t)),
  copyFile: async (a, b) => (fs.mkdirSync(path.dirname(b), { recursive: true }), fs.copyFileSync(a, b)),
  listDir: async (p) => (fs.existsSync(p) ? fs.readdirSync(p).map((n) => path.join(p, n)).sort() : []),
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aleph-lib-"));
const put = (p: string, t: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, t));

test("state: the same bytes, different bytes, absent", async () => {
  const d = tmp();
  put(`${d}/lib/plugins/x.wasm`, "abc");
  put(`${d}/p1/plugins/x.wasm`, "abc");
  put(`${d}/p2/plugins/x.wasm`, "abd");
  assert.equal(await stateOf(nodeFs, `${d}/lib/plugins/x.wasm`, `${d}/p1/plugins/x.wasm`), "same");
  assert.equal(await stateOf(nodeFs, `${d}/lib/plugins/x.wasm`, `${d}/p2/plugins/x.wasm`), "changed");
  assert.equal(await stateOf(nodeFs, `${d}/lib/plugins/x.wasm`, `${d}/p3/plugins/x.wasm`), "absent");
});

test("the library's files by kind", async () => {
  const d = tmp();
  put(`${d}/fonts/A.otf`, "f");
  put(`${d}/fonts/LICENSE-A.txt`, "l");
  put(`${d}/plugins/ruby.wasm`, "w");
  put(`${d}/plugins/readme.md`, "r");
  put(`${d}/functions/book.emet`, "e");
  assert.deepEqual(
    (await libraryFiles(nodeFs, d)).map((f) => [f.kind, f.name]),
    [["font", "A.otf"], ["plugin", "ruby.wasm"], ["function", "book.emet"]],
  );
});

test("a plugin's declaration is added once, also to a manifest without a final newline", () => {
  assert.equal(addPluginDecl('chapters = ["a.gm"]\n', "ruby"), 'chapters = ["a.gm"]\n\n[plugins.ruby]\npath = "plugins/ruby.wasm"\n');
  assert.equal(addPluginDecl('chapters = ["a.gm"]', "ruby"), 'chapters = ["a.gm"]\n\n[plugins.ruby]\npath = "plugins/ruby.wasm"\n');
  const has = 'chapters = []\n\n[plugins.ruby]\npath = "plugins/ruby.wasm"\n';
  assert.equal(addPluginDecl(has, "ruby"), has);
});

test("installing copies the file; a plugin is declared in manifest.toml", async () => {
  const d = tmp();
  put(`${d}/lib/plugins/ruby.wasm`, "w");
  put(`${d}/p/manifest.toml`, 'chapters = ["a.gm"]\n');
  const [f] = await libraryFiles(nodeFs, `${d}/lib`);
  await installItem(nodeFs, `${d}/p`, f);
  assert.equal(fs.readFileSync(`${d}/p/plugins/ruby.wasm`, "utf8"), "w");
  assert.match(fs.readFileSync(`${d}/p/manifest.toml`, "utf8"), /\[plugins\.ruby\]\npath = "plugins\/ruby\.wasm"/);
});

test("fonts: only those style.toml names and the project lacks, with the licenses", async () => {
  const d = tmp();
  put(`${d}/lib/fonts/NotoSerifJP-Regular.otf`, "a");
  put(`${d}/lib/fonts/Mono.ttf`, "b");
  put(`${d}/lib/fonts/LICENSE-OFL.txt`, "l");
  put(`${d}/p/style.toml`, '[fonts.body]\nja = "fonts/NotoSerifJP-Regular.otf"\n[fonts.code]\nlatin = "fonts/Mono.ttf"\n[fonts.x]\nja = "fonts/Missing.otf"\n');
  put(`${d}/p/fonts/Mono.ttf`, "mine");
  assert.deepEqual(fontsWanted(fs.readFileSync(`${d}/p/style.toml`, "utf8")), ["fonts/NotoSerifJP-Regular.otf", "fonts/Mono.ttf", "fonts/Missing.otf"]);
  assert.deepEqual(await copyFonts(nodeFs, `${d}/lib`, `${d}/p`), ["fonts/NotoSerifJP-Regular.otf"]);
  assert.equal(fs.readFileSync(`${d}/p/fonts/Mono.ttf`, "utf8"), "mine");
  assert.ok(fs.existsSync(`${d}/p/fonts/LICENSE-OFL.txt`));
});

test("names that do not overwrite: -2, -3", async () => {
  const d = tmp();
  assert.equal(await freeName(nodeFs, d, "灯台.png"), "灯台.png");
  put(`${d}/灯台.png`, "");
  assert.equal(await freeName(nodeFs, d, "灯台.png"), "灯台-2.png");
  put(`${d}/灯台-2.png`, "");
  assert.equal(await freeName(nodeFs, d, "灯台.png"), "灯台-3.png");
});

test("dropped files go to the library by extension", () => {
  assert.equal(libSubdir("/x/ruby.wasm"), "plugins");
  assert.equal(libSubdir("/x/book.emet"), "functions");
  assert.equal(libSubdir("/x/A.OTF"), "fonts");
  assert.equal(libSubdir("/x/LICENSE.txt"), "fonts");
  assert.equal(libSubdir("/x/notes.md"), null);
});

test("@figure goes after the dropped line: an empty line, a line with text, the end", () => {
  const fig = (text: string, line: number) => {
    const { at, insert } = figureInsert(text, line, ["images/灯台.png"]);
    return text.slice(0, at) + insert + text.slice(at);
  };
  assert.equal(fig("一\n\n二\n", 2), '一\n\n@figure images/灯台.png alt="灯台"\n  キャプション\n\n二\n');
  assert.equal(fig("一\n二\n", 1), '一\n\n@figure images/灯台.png alt="灯台"\n  キャプション\n\n二\n');
  assert.equal(fig("一", 1), '一\n\n@figure images/灯台.png alt="灯台"\n  キャプション\n');
});

// I10 of docs/adr/0061: "gm に変換" never writes, removes or renames the .md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertFile, type ConvertIo } from "./mdconvertfile.ts";

const fake = (files: Record<string, string>, answer: boolean) => {
  const writes: string[] = [];
  const io: ConvertIo = {
    exists: async (p) => p in files,
    readText: async (p) => (p in files ? files[p] : Promise.reject(new Error("none"))),
    writeText: async (p, t) => {
      writes.push(p);
      files[p] = t;
    },
    confirm: async () => answer,
    resolve: (t) => (t === "pic.png" ? "/w/p/images/pic.png" : null),
  };
  return { io, writes, files };
};

const MD = "# 霧笛\n\n![図](../images/a.png)\n\n![[pic.png]]\n";

test("I10: outside a project only the .gm is written; the .md stays as it was", async () => {
  const f = fake({ "/w/notes/a.md": MD }, true);
  assert.equal(await convertFile(f.io, { path: "/w/notes/a.md", text: MD, project: null }), "/w/notes/a.gm");
  assert.deepEqual(f.writes, ["/w/notes/a.gm"]);
  assert.equal(f.files["/w/notes/a.md"], MD);
});

test("I10: in a project the .gm and manifest.toml are written, figures from the project's root, embeds found", async () => {
  const f = fake({ "/w/p/chapters/a.md": MD, "/w/p/manifest.toml": 'chapters = ["chapters/01.gm"]\n' }, true);
  assert.equal(await convertFile(f.io, { path: "/w/p/chapters/a.md", text: MD, project: "/w/p" }), "/w/p/chapters/a.gm");
  assert.deepEqual(f.writes, ["/w/p/chapters/a.gm", "/w/p/manifest.toml"]);
  assert.equal(f.files["/w/p/chapters/a.md"], MD);
  assert.match(f.files["/w/p/chapters/a.gm"], /@figure "images\/a\.png" alt="図"/);
  assert.match(f.files["/w/p/chapters/a.gm"], /@figure "images\/pic\.png" alt="pic"/);
  assert.match(f.files["/w/p/manifest.toml"], /chapters\/a\.gm/);
});

test("I10: a .gm already there is overwritten only when the writer says so; the .md is untouched either way", async () => {
  const no = fake({ "/w/p/a.md": MD, "/w/p/a.gm": "old", "/w/p/manifest.toml": "" }, false);
  assert.equal(await convertFile(no.io, { path: "/w/p/a.md", text: MD, project: "/w/p" }), null);
  assert.deepEqual(no.writes, []);
  assert.equal(no.files["/w/p/a.gm"], "old");
  const yes = fake({ "/w/p/a.md": MD, "/w/p/a.gm": "old", "/w/p/manifest.toml": 'chapters = ["a.gm"]\n' }, true);
  assert.equal(await convertFile(yes.io, { path: "/w/p/a.md", text: MD, project: "/w/p" }), "/w/p/a.gm");
  assert.deepEqual(yes.writes, ["/w/p/a.gm"]);
  assert.equal(yes.files["/w/p/a.md"], MD);
  // a .md at the project's root: ../ leaves the project, so the image stays as its alt and a comment
  assert.match(yes.files["/w/p/a.gm"], /^図 %% 画像: \.\.\/images\/a\.png %%$/m);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { addCommand, keyedCommands, keyLabel, menuCommands, pushRecent, rankCommands, splitQuery, validId, type Command } from "./commands.ts";

const st = { workspace: "/w" } as never;
const cmd = (id: string, extra: Partial<Command> = {}): Command => ({ id, label: id, when: () => true, run: () => {}, ...extra });

test("ids are <area>.<action> in lower camel case; plugin ids may carry a hyphen", () => {
  for (const id of ["file.save", "view.left.search", "settings.editor", "plugin.word-count.1", "md.convertToGm"]) assert.equal(validId(id), true, id);
  for (const id of ["save", "File.save", "file.", ".save", "file save"]) assert.equal(validId(id), false, id);
});

test("registering refuses a bad or repeated id", () => {
  const list: Command[] = [];
  addCommand(list, cmd("file.save"));
  assert.throws(() => addCommand(list, cmd("file.save")));
  assert.throws(() => addCommand(list, cmd("Save")));
  assert.equal(list.length, 1);
});

test("the toolbar menu takes the commands marked for it that are available", () => {
  const list = [cmd("a.one", { menu: true }), cmd("a.two"), cmd("a.three", { menu: true, when: () => false })];
  assert.deepEqual(menuCommands(list, st).map((c) => c.id), ["a.one"]);
});

test("keys are shown with macOS symbols in macOS order", () => {
  assert.equal(keyLabel("Mod-Shift-k", true), "⇧⌘K");
  assert.equal(keyLabel("Shift-Alt-f", true), "⌥⇧F");
  assert.equal(keyLabel("Ctrl-Space", true), "⌃Space");
  assert.equal(keyLabel("Mod-,", true), "⌘,");
  assert.equal(keyLabel("Tab", true), "Tab");
  assert.equal(keyLabel("Mod-k Mod-s", true), "⌘K ⌘S");
  // a bare key after the first stroke is the character typed
  assert.equal(keyLabel("Mod-; g c", true), "⌘; g c");
  assert.equal(keyLabel("Mod-Minus", true), "⌘-");
});

test("the commands keys may run: available ones; editor commands only while the editor has focus", () => {
  const list = [
    cmd("git.commit", { keys: ["Mod-Shift-k"] }),
    cmd("editor.undo", { keys: ["Mod-z"], scope: "editor" }),
    cmd("view.off", { keys: ["Mod-j"], when: () => false }),
  ];
  assert.deepEqual(keyedCommands(list, st, false).map((c) => c.id), ["git.commit"]);
  assert.deepEqual(keyedCommands(list, st, true).map((c) => c.id), ["git.commit", "editor.undo"]);
});

test("a leading '>' asks for commands; the space after it is skipped", () => {
  assert.deepEqual(splitQuery(">整形"), { mode: "commands", q: "整形" });
  assert.deepEqual(splitQuery(">  整形"), { mode: "commands", q: "整形" });
  assert.deepEqual(splitQuery("霧笛"), { mode: "files", q: "霧笛" });
});

test("the palette: recent commands first with an empty query, then by name; a query matches the name or the id", () => {
  const list = [cmd("git.commit", { label: "コミット" }), cmd("editor.format", { label: "整形" }), cmd("view.plot", { label: "プロット" }), cmd("x.hidden", { when: () => false })];
  assert.deepEqual(rankCommands(list, st, "", ["view.plot"]).map((c) => c.id), ["view.plot", "git.commit", "editor.format"]);
  assert.deepEqual(rankCommands(list, st, "整形", []).map((c) => c.id), ["editor.format"]);
  assert.deepEqual(rankCommands(list, st, "gitcom", []).map((c) => c.id), ["git.commit"]);
});

test("recent commands keep 20, newest first, without repeats", () => {
  let r: string[] = [];
  for (let i = 0; i < 25; i++) r = pushRecent(r, `a.c${i}`);
  r = pushRecent(r, "a.c10");
  assert.equal(r.length, 20);
  assert.equal(r[0], "a.c10");
  assert.equal(r.filter((x) => x === "a.c10").length, 1);
});

// the ids ADR 0023 lists, except those their own ADRs add (file.quickOpen: 0022; file.closeTab and
// view.split: 0024)
const INITIAL = [
  "file.newSheet", "file.newFolder", "file.newProject", "file.save",
  "view.left.files", "view.left.search", "view.left.git", "view.left.diagnostics", "view.left.library", "view.toggleLeft",
  "view.right.attach", "view.right.outline", "view.right.library", "view.toggleRight", "view.plot", "view.vertical", "view.horizontal",
  "preview.none", "preview.plain", "preview.pages", "preview.window",
  "editor.undo", "editor.redo", "editor.selectAll", "editor.find", "editor.indent", "editor.outdent", "editor.complete", "editor.format",
  "git.commit", "git.push", "git.pull",
  "palette.open", "settings.open", "md.convertToGm", "library.copyFonts", "dev.recordIme",
  "view.left.bookmarks", "bookmark.toggle", "file.quickOpen",
  "file.newTab", "file.closeTab", "view.nextTab", "view.prevTab", "view.split",
];

test("every command ADR 0023 lists is registered somewhere in the app", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = `${dir}/${f}`;
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });
  const src = files(new URL(".", import.meta.url).pathname).map((p) => readFileSync(p, "utf8")).join("\n");
  const ids = new Set([...src.matchAll(/id: "([\w.-]+)"/g), ...src.matchAll(/\["(editor\.\w+)"/g)].map((m) => m[1]));
  // ids built from the panel and preview tables of palette.ts
  for (const [prefix, table] of [["view.left.", /\["(files|git|diagnostics|library)", "/g], ["view.right.", /\["(attach|outline|library)", "/g], ["preview.", /\["(none|plain|pages)", "/g]] as const)
    for (const m of src.matchAll(table)) ids.add(prefix + m[1]);
  assert.deepEqual(INITIAL.filter((id) => !ids.has(id)), []);
});

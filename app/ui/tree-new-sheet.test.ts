import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

type Dialog = {
  innerHTML: string;
  handlers: Map<string, (event: unknown) => void>;
};

test("ADR 0093 I1, I2, I3, I4: new-file resolves a name before creating a sheet or registering a chapter", async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const root = "/w";
  const project = "/w/book";
  const manifest = project + "/manifest.toml";
  const files = new Map([[manifest, 'chapters = ["old.gm"]\n']]);
  const opens: string[] = [];
  const questions: string[] = [];
  const register: [string, string, string][] = [];
  let answer = "";
  let format = "";
  let beforeChoice = () => {};
  const input = { get value() { return answer; }, focus() {}, select() {}, addEventListener() {} };

  const createElement = () => {
    const dialog = {
      innerHTML: "",
      handlers: new Map(),
      querySelector: (selector: string) => selector === "input" ? input : null,
      dataset: {}, children: [], insertBefore() {},
      // the notification stack measures itself after drawing (docs/adr/0111)
      classList: { contains: () => false, toggle() {} }, scrollHeight: 0, clientHeight: 0, scrollTop: 0,
    };
    return {
      set innerHTML(value: string) { dialog.innerHTML = value; },
      content: { firstElementChild: Object.assign(dialog, {
        addEventListener: (name: string, listener: (e: unknown) => void) => dialog.handlers.set(name, listener),
        remove() {},
      }) },
    };
  };
  const append = (dialog: Dialog) => {
    const title = /class="mtitle">([^<]*)</.exec(dialog.innerHTML)?.[1];
    if (!title) return;
    questions.push(title);
    const choice = dialog.handlers.get("mouseup");
    queueMicrotask(() => {
      if (choice) {
        beforeChoice();
        const options = Array.from(dialog.innerHTML.matchAll(/data-i="(\d+)">([^<]+)</g));
        const index = options.find(([, , label]) => label === format)?.[1];
        assert.notEqual(index, undefined, dialog.innerHTML);
        choice({ button: 0, target: { closest: (s: string) => s === "[data-i]" ? { dataset: { i: index } } : null } });
      } else {
        dialog.handlers.get("click")?.({ target: { closest: (s: string) => s === "[data-ok]" } });
      }
    });
  };
  Object.assign(globalThis, { document: { createElement, body: { append }, querySelector: () => null, addEventListener() {}, removeEventListener() {} }, window: { setTimeout: () => 1 } });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: "custom" });
  try {
    const { runTreeAct } = await server.ssrLoadModule("/app/ui/tree.ts");
    const { api } = await server.ssrLoadModule("/app/api.ts");
    api.exists = async (path: string) => files.has(path);
    api.readText = async (path: string) => files.get(path) ?? "";
    api.writeText = async (path: string, text: string, createNew: boolean) => {
      if (createNew && files.has(path)) throw new Error("already exists");
      files.set(path, text);
    };
    api.updateManifestChapter = async (project: string, path: string, mode: string) => {
      register.push([project, path, mode]);
      const current = files.get(manifest)!;
      const text = current.replace("]", `, ${JSON.stringify(path.slice(project.length + 1))}]`);
      files.set(manifest, text);
      return { text, registered: true };
    };
    api.listTree = async () => [];
    const state = { workspace: root, workspaces: [root], focus: 0, panes: [], open: [] as { path: string; project: string }[] };
    const ctx = {
      store: { get: () => state }, config: {}, titles: new Map(), projects: [],
      refresh() {}, open: (paths: string[]) => opens.push(...paths),
    };
    const act = async (name: string, choose = "") => {
      answer = name;
      format = choose;
      questions.length = 0;
      const snapshot = [...files];
      const priorOpens = opens.length;
      beforeChoice = () => assert.deepEqual([...files], snapshot, "the choice was shown before any writes");
      await runTreeAct(ctx, "new-file");
      assert.equal(questions.filter((title) => title === "シートの形式").length, choose ? 1 : 0, name);
      return { snapshot, priorOpens };
    };
    const created = async (input: string, choice: string, expected: string) => {
      const { snapshot, priorOpens } = await act(input, choice);
      assert.deepEqual([...files.keys()].filter((p) => !snapshot.some(([old]) => p === old)), [expected]);
      assert.deepEqual(opens.slice(priorOpens), [expected]);
    };
    const unchanged = async (input: string, choice = "") => {
      const { snapshot, priorOpens } = await act(input, choice);
      assert.deepEqual([...files], snapshot);
      assert.equal(opens.length, priorOpens);
    };

    await created("メモ", "Markdown (.md)", "/w/メモ.md");
    await created("記録.", "Golem (.gm)", "/w/記録.gm");
    await created(".隠し", "Markdown (.md)", "/w/.隠し.md");
    await created("メモ.MD", "", "/w/メモ.MD");
    await created("図.svg", "", "/w/図.svg");
    await created("保留.unknown", "", "/w/保留.unknown");
    for (const input of ["", ".", "..", "...", "nested/.", "nested/.."]) await unchanged(input);
    await unchanged("メモ", "Markdown (.md)");
    await unchanged("取消", "やめる");

    state.open = [{ path: project + "/old.gm", project }];
    await created("chapters/下書き", "Markdown (.md)", project + "/chapters/下書き.md");
    assert.equal(files.get(manifest), 'chapters = ["old.gm"]\n');
    await created("chapters/新章.", "Golem (.gm)", project + "/chapters/新章.gm");
    await created("chapters/exact.GM", "", project + "/chapters/exact.GM");
    assert.equal(files.get(manifest), 'chapters = ["old.gm", "chapters/新章.gm", "chapters/exact.GM"]\n');
    assert.deepEqual(register, [
      [project, project + "/chapters/新章.gm", "add"],
      [project, project + "/chapters/exact.GM", "add"],
    ]);
    await unchanged("chapters/新章", "Golem (.gm)");
    await unchanged("chapters/取消", "やめる");
  } finally {
    Object.assign(globalThis, { document: previousDocument, window: previousWindow });
    await server.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("ADR 0065 invariant 3: a clicked md uses its live text while another tab is active", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, ws: false }, appType: "custom" });
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    const { initialState, reduce } = await server.ssrLoadModule("/app/store.ts");
    const { convertToGm } = await server.ssrLoadModule("/app/mdconvert.ts");
    const doc = (path: string, text: string) => ({ path, text, saved: text, kind: "md", project: null, workspace: "/w", grid: { chars: 40, lines: 20, vertical: false } });
    let state = reduce(initialState(), { type: "open", docs: [doc("/w/first.md", "# Original")] });
    state = reduce(state, { type: "open", docs: [doc("/w/second.md", "# Active")], newTab: true });
    const plans: unknown[][] = [];
    const conversions: unknown[][] = [];
    const opened: string[][] = [];
    let overwrite = false;
    api.planMarkdownConversion = async (source: string, project: string | null) => {
      plans.push([source, project]);
      return { destination: source.replace(/\.md$/, ".gm"), overwrite, revision: "test-revision" };
    };
    api.finishMarkdownConversion = async (source: string, project: string | null, revision: string, overwrite: boolean, text: string | null) => {
      conversions.push([source, project, revision, overwrite, text]);
      return { destination: source.replace(/\.md$/, ".gm"), project, chapterRegistered: false };
    };
    api.listTree = async () => [];
    const errors: string[] = [];
    const ctx = {
      store: { get: () => state }, projects: [] as string[], editors: new Map([["/w/first.md", { text: () => "# Edited" }]]),
      titles: new Map(), refresh: () => {}, open: async (paths: string[]) => { opened.push(paths); }, toast: () => {},
      notify: ({ message }: { message: string }) => { errors.push(message); return { dismiss: () => {} }; },
    };
    await convertToGm(ctx, "/w/first.md");
    assert.deepEqual(plans, [["/w/first.md", null]]);
    assert.deepEqual(conversions, [["/w/first.md", null, "test-revision", false, "# Edited"]]);
    assert.deepEqual(opened, [["/w/first.gm"]]);
    await convertToGm(ctx, "/w/third.md");
    assert.deepEqual(conversions[1], ["/w/third.md", null, "test-revision", false, null]);
    assert.deepEqual(opened[1], ["/w/third.gm"]);
    const previousDocument = globalThis.document;
    const dialog = { addEventListener: (_type: string, callback: (event: unknown) => void) => {
      queueMicrotask(() => callback({ target: { closest: (selector: string) => selector === "[data-x]" } }));
    }, remove: () => {} };
    Object.assign(globalThis, { document: {
      createElement: () => ({ content: { firstElementChild: dialog }, innerHTML: "" }),
      body: { append: () => {} },
    } });
    try {
      overwrite = true;
      await convertToGm(ctx, "/w/first.md");
      assert.equal(opened.length, 2);
      assert.equal(conversions.length, 2);
    } finally {
      Object.assign(globalThis, { document: previousDocument });
    }
    state = reduce(state, { type: "open", docs: [doc("/w/book/chapter.md", "# Project")], newTab: true });
    ctx.projects.push("/w/book");
    api.planMarkdownConversion = async () => { throw new Error("manifest unavailable"); };
    await convertToGm(ctx, "/w/book/chapter.md");
    assert.equal(opened.length, 2);
    assert.match(errors[0], /manifest unavailable/);
  } finally {
    await server.close();
  }
});

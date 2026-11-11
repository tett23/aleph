import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("ADR 0065 invariant 3: a clicked md uses its live text while another tab is active", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { api } = await server.ssrLoadModule("/app/api.ts");
    const { initialState, reduce } = await server.ssrLoadModule("/app/store.ts");
    const { convertToGm } = await server.ssrLoadModule("/app/mdconvert.ts");
    const doc = (path: string, text: string) => ({ path, text, saved: text, kind: "md", project: null, workspace: "/w", grid: { chars: 40, lines: 20, vertical: false } });
    let state = reduce(initialState(), { type: "open", docs: [doc("/w/first.md", "# Original")] });
    state = reduce(state, { type: "open", docs: [doc("/w/second.md", "# Active")], newTab: true });
    const written: [string, string][] = [];
    const read: string[] = [];
    api.exists = async () => false;
    api.readText = async (path: string) => { read.push(path); return "# Disk"; };
    api.writeText = async (path: string, text: string) => { written.push([path, text]); };
    api.listTree = async () => [];
    const errors: string[] = [];
    const ctx = {
      store: { get: () => state }, projects: [] as string[], editors: new Map([["/w/first.md", { text: () => "# Edited" }]]),
      titles: new Map(), refresh: () => {}, open: async () => {}, toast: () => {},
      notify: ({ message }: { message: string }) => { errors.push(message); return { dismiss: () => {} }; },
    };
    await convertToGm(ctx, "/w/first.md");
    assert.deepEqual(written, [["/w/first.gm", "# Edited\n"]]);
    assert.deepEqual(read, []);
    await convertToGm(ctx, "/w/third.md");
    assert.deepEqual(read, ["/w/third.md"]);
    assert.deepEqual(written[1], ["/w/third.gm", "# Disk\n"]);
    const before = written.length;
    const previousDocument = globalThis.document;
    const dialog = { addEventListener: (_type: string, callback: (event: unknown) => void) => {
      queueMicrotask(() => callback({ target: { closest: (selector: string) => selector === "[data-x]" } }));
    }, remove: () => {} };
    Object.assign(globalThis, { document: {
      createElement: () => ({ content: { firstElementChild: dialog }, innerHTML: "" }),
      body: { append: () => {} },
    } });
    try {
      api.exists = async () => true;
      await convertToGm(ctx, "/w/first.md");
      assert.equal(written.length, before);
    } finally {
      Object.assign(globalThis, { document: previousDocument });
    }
    state = reduce(state, { type: "open", docs: [doc("/w/book/chapter.md", "# Project")], newTab: true });
    ctx.projects.push("/w/book");
    api.exists = async () => false;
    api.readText = async () => { throw new Error("manifest unavailable"); };
    await convertToGm(ctx, "/w/book/chapter.md");
    assert.equal(written.length, before);
    assert.match(errors[0], /manifest unavailable/);
  } finally {
    await server.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { diffFrameHtml, validDiffKey, validDiffOpen } from "./frame.ts";
import { diffDestination, openFromDiff } from "../docs.ts";
import { api } from "../api.ts";
import { initialState, reduce, type Action, type Doc, type State } from "../store.ts";
import type { Ctx } from "../ctx.ts";

test("ADR 0115 I3, I4: diff frame accepts only a typed open request for an allowed path", () => {
  const allowed = new Set(["chapter.md"]);
  assert.equal(validDiffOpen({ type: "open-file", path: "chapter.md", newTab: true }, "/w", allowed), "/w/chapter.md");
  for (const request of [{ type: "open-file", path: "../../secret.md", newTab: false }, { type: "open-file", path: "other.md", newTab: false }, { type: "open-file", path: "chapter.md", newTab: "yes" }, { type: "run", path: "chapter.md", newTab: false }])
    assert.equal(validDiffOpen(request, "/w", allowed), null);
});


test("ADR 0115 I3, I4: diff keyboard messages have a typed, bounded shape", () => {
  const key = { type: "app-key", key: "s", code: "KeyS", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false };
  assert.deepEqual(validDiffKey(key), key);
  assert.equal(validDiffKey({ ...key, key: "x".repeat(1000) }), null);
  assert.equal(validDiffKey({ ...key, metaKey: "yes" }), null);
  assert.equal(validDiffKey({ ...key, type: "open-file" }), null);
});

test("ADR 0115 I1: diff content is rendered inside a restrictive document", () => {
  const html = diffFrameHtml('<span data-open="chapter.md">&lt;x&gt;</span>');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<span data-open="chapter.md">&lt;x&gt;<\/span>/);
  assert.doesNotMatch(html, /allow-same-origin/);
});

test("ADR 0115 I3: the diff runtime hash matches the sandbox policy", () => {
  const source = readFileSync(new URL("./frame.ts", import.meta.url), "utf8");
  const runtime = /const runtime = `([\s\S]*?)`;/m.exec(source)?.[1];
  assert.ok(runtime);
  const hash = createHash("sha256").update(runtime).digest("base64");
  assert.match(diffFrameHtml(""), new RegExp(`sha256-${hash.replace(/[+/=]/g, "\\$&")}`));
  const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.match(config.app.security.csp, new RegExp(`sha256-${hash.replace(/[+/=]/g, "\\$&")}`));
  assert.match(config.app.security.devCsp, new RegExp(`sha256-${hash.replace(/[+/=]/g, "\\$&")}`));
  assert.doesNotMatch(runtime, /<\/script/i);
});

test("ADR 0115 I3: frame relays app keys while keeping copy, select all, arrows, and link Enter local", () => {
  const source = readFileSync(new URL("./frame.ts", import.meta.url), "utf8");
  const runtime = /const runtime = `([\s\S]*?)`;/m.exec(source)![1];
  const windowHandlers = new Map<string, (event: any) => void>();
  const documentHandlers = new Map<string, (event: any) => void>();
  const parent = {};
  const messages: unknown[] = [];
  const window = { parent, addEventListener: (name: string, handler: (event: any) => void) => windowHandlers.set(name, handler) };
  const document = { addEventListener: (name: string, handler: (event: any) => void) => documentHandlers.set(name, handler), querySelector: () => null, hasFocus: () => false };
  runInNewContext(runtime, { window, document });
  windowHandlers.get("message")!({ source: parent, data: { type: "init" }, ports: [{ postMessage: (message: unknown) => messages.push(message) }] });
  const send = (key: string, link = false) => {
    let prevented = false;
    documentHandlers.get("keydown")!({ key, code: key === "s" ? "KeyS" : "", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 0, target: { closest: () => link ? { dataset: { open: "a.md" } } : null }, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(send("s"), true);
  assert.equal(send("a"), false);
  assert.equal(send("c"), false);
  assert.equal(send("ArrowLeft"), false);
  assert.equal(send("Enter", true), false);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: "app-key", key: "s", code: "KeyS", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false },
    { type: "open-file", path: "a.md", newTab: false },
  ]);
});

const sheet = (path: string): Doc => ({ path, kind: "md", text: "", saved: "", project: null, workspace: "/w", grid: { chars: 40, lines: 16, vertical: false } });
const openState = (): State => ({ ...initialState(), workspace: "/w", workspaces: ["/w"], pane: 1, followed: 2, seq: 3, panes: [
  { active: 0, tabs: [{ id: 2, open: [sheet("/w/old.md")], focus: 0, plot: null, preview: false, diff: false }] },
  { active: 0, tabs: [{ id: 1, open: [], focus: 0, plot: null, preview: false, diff: true }] },
] });

test("ADR 0115 I4, I5: a diff request keeps its pane across asynchronous reading and rejects a closed source", async () => {
  const original = api.readText;
  let resolveRead: (value: string) => void = () => {};
  api.readText = () => new Promise<string>((resolve) => { resolveRead = resolve; });
  try {
    let state = openState();
    const ctx = { store: { get: () => state, dispatch: (action: Action) => { state = reduce(state, action); } }, projects: [], pendingAt: null } as unknown as Ctx;
    const destination = diffDestination(state, 1, 1, "/w/new.md", false)!;
    assert.deepEqual(destination, { sourcePane: 1, sourceId: 1, targetPane: 0, targetId: 2 });
    const pending = openFromDiff(ctx, "/w/new.md", "/w", destination, false, () => true);
    state = reduce(state, { type: "selectPane", pane: 0 });
    resolveRead("new text");
    await pending;
    assert.equal(state.panes[0].tabs[0].open[0].path, "/w/new.md");
    assert.equal(state.panes[1].tabs[0].diff, true);

    const oldTarget = diffDestination(state, 1, 1, "/w/other.md", false)!;
    const targetPending = openFromDiff(ctx, "/w/other.md", "/w", oldTarget, false, () => true);
    state = reduce(state, { type: "open", docs: [sheet("/w/replacement.md")] });
    const replaced = state;
    resolveRead("other text");
    await targetPending;
    assert.equal(state, replaced);

    const again = diffDestination(state, 1, 1, "/w/other.md", false)!;
    const stale = openFromDiff(ctx, "/w/other.md", "/w", again, false, () => true);
    state = reduce(state, { type: "closeTab", pane: 1, index: 0 });
    const before = state;
    resolveRead("other text");
    await stale;
    assert.equal(state, before);
  } finally { api.readText = original; }
});

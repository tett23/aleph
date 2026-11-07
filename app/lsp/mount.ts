// golem lsp in the app (docs/adr/0009, docs/adr/0019): one server per project,
// kept in step with the store, and the editor's diagnostics, semantic colours,
// hover, completion and formatting, in horizontal and vertical writing alike.
import { api } from "../api.ts";
import type { Ctx } from "../ctx.ts";
import type { Diag, EditorPlugin, TextEditor } from "../ed/editor.ts";
import { rel } from "../path.ts";
import { allDocs, focused, type Doc, type State } from "../store.ts";
import { golem } from "../tools.ts";
import { item, toggle } from "../ui/settings.ts";
import { startClient, type Client, type LspDiagnostic } from "./client.ts";
import { completionStart, decodeSemanticTokens, editsToChanges, offsetOf, tokenRanges, uriOf, type TextEdit, type TokenRange } from "./protocol.ts";

export const LSP_KINDS = ["gm", "emet"];
const CHANGE_DELAY = 250;
const IDLE_STOP = 10 * 60 * 1000;
const RETRY_AFTER = 60 * 1000;

type Synced = { project: string; version: number; text: string; timer: number };

const clients = new Map<string, Client>();
const failedAt = new Map<string, number>();
const idle = new Map<string, number>();
const synced = new Map<string, Synced>();
const diagnostics = new Map<string, LspDiagnostic[]>();
const tokens = new Map<string, { version: number; ranges: TokenRange[] }>();
const views = new Map<string, TextEditor>();

const lspDoc = (d: Doc) => !!d.project && LSP_KINDS.includes(d.kind);
const languageId = (path: string) => (path.endsWith(".emet") ? "emet" : "golem");

// ---- semantic colours and diagnostics in the editor ----

const severity = (n?: number): Diag["severity"] => (n === 1 ? "error" : n === 2 ? "warning" : n === 4 ? "hint" : "info");

const toDiagnostics = (text: string, list: LspDiagnostic[]): Diag[] =>
  list.map((d) => {
    const from = offsetOf(text, d.range.start);
    return { from, to: Math.max(from, offsetOf(text, d.range.end)), severity: severity(d.severity), message: d.message, source: d.source };
  });

/** Draws what the server last sent for a sheet into its editor, if it has one. */
const paint = (path: string) => {
  const v = views.get(path);
  if (!v) return;
  const text = v.core.text();
  const tk = tokens.get(path);
  // tokens of an older text would be misplaced; a newer request follows
  if (tk && tk.version === synced.get(path)?.version && text === synced.get(path)?.text) {
    v.setLayer("st", tk.ranges.filter((r) => r.to <= text.length).map((r) => ({ from: r.from, to: r.to, cls: `st st-${r.cls}` })));
    v.setFallbackColors(false);
  }
  // diagnostics of an older text are moved along with the edits by the editor
  if (text === synced.get(path)?.text) v.setDiagnostics(toDiagnostics(text, diagnostics.get(path) ?? []));
};

// ---- servers ----

const clientFor = (ctx: Ctx, project: string): Client | null => {
  const c = clients.get(project);
  if (c && c.state() !== "failed" && c.state() !== "stopped") return c;
  if (Date.now() - (failedAt.get(project) ?? 0) < RETRY_AFTER) return null;
  const n = startClient(project, {
    onDiagnostics: (uri, list) => {
      const path = [...synced.keys()].find((p) => uriOf(p) === uri);
      if (!path) return;
      diagnostics.set(path, list);
      paint(path);
      ctx.refresh(["status"]);
    },
    onExit: (dead) => {
      if (clients.get(project) === dead) clients.delete(project);
      failedAt.set(project, Date.now());
      ctx.refresh(["status"]);
    },
  });
  clients.set(project, n);
  void n.ready.then((ok) => {
    if (!ok) failedAt.set(project, Date.now());
    else for (const [path, s] of synced) if (s.project === project) openOn(n, path, s);
    ctx.refresh(["status"]);
  });
  return n;
};

const openOn = (c: Client, path: string, s: Synced) => {
  c.notify("textDocument/didOpen", { textDocument: { uri: uriOf(path), languageId: languageId(path), version: s.version, text: s.text } });
  void requestTokens(c, path);
};

const requestTokens = async (c: Client, path: string) => {
  const legend = c.legend();
  const s = synced.get(path);
  if (!legend || !s) return;
  const version = s.version;
  const r = await c.request<{ data: number[] } | null>("textDocument/semanticTokens/full", { textDocument: { uri: uriOf(path) } }).catch(() => null);
  if (!r || synced.get(path)?.version !== version) return;
  tokens.set(path, { version, ranges: tokenRanges(s.text, decodeSemanticTokens(r.data, legend), path.endsWith(".emet") ? "emet" : "gm") });
  paint(path);
};

/** Sends a pending change now (before formatting, completion and hover). */
const flush = (path: string) => {
  const s = synced.get(path);
  const c = s && clients.get(s.project);
  if (!s || !s.timer || !c) return;
  clearTimeout(s.timer);
  s.timer = 0;
  c.notify("textDocument/didChange", { textDocument: { uri: uriOf(path), version: s.version }, contentChanges: [{ text: s.text }] });
};

/** Keeps the servers in step with the open sheets: open, change, save, close. */
const sync = (ctx: Ctx, s: State, prev: State | null) => {
  const now = new Map(allDocs(s).filter(lspDoc).map((d) => [d.path, d]));
  for (const [path, st] of synced) {
    if (now.has(path)) continue;
    clearTimeout(st.timer);
    synced.delete(path);
    diagnostics.delete(path);
    tokens.delete(path);
    clients.get(st.project)?.notify("textDocument/didClose", { textDocument: { uri: uriOf(path) } });
    if (![...synced.values()].some((x) => x.project === st.project))
      idle.set(st.project, window.setTimeout(() => (clients.get(st.project)?.stop(), clients.delete(st.project)), IDLE_STOP));
  }
  for (const [path, d] of now) {
    const project = d.project!;
    clearTimeout(idle.get(project));
    idle.delete(project);
    const st = synced.get(path);
    if (!st) {
      const n: Synced = { project, version: 1, text: d.text, timer: 0 };
      synced.set(path, n);
      const c = clientFor(ctx, project);
      if (c?.state() === "ready") openOn(c, path, n);
      continue;
    }
    if (d.text !== st.text) {
      st.text = d.text;
      st.version++;
      clearTimeout(st.timer);
      st.timer = window.setTimeout(() => {
        st.timer = 0;
        const c = clientFor(ctx, project);
        if (c?.state() !== "ready") return;
        c.notify("textDocument/didChange", { textDocument: { uri: uriOf(path), version: st.version }, contentChanges: [{ text: st.text }] });
        void requestTokens(c, path);
      }, CHANGE_DELAY);
    }
    const before = prev ? allDocs(prev).find((x) => x.path === path) : undefined;
    if (before && before.saved !== d.saved) {
      flush(path);
      clients.get(project)?.notify("textDocument/didSave", { textDocument: { uri: uriOf(path) }, text: d.saved });
    }
  }
};

const readyClient = (path: string) => {
  const s = synced.get(path);
  const c = s && clients.get(s.project);
  return c?.state() === "ready" ? c : null;
};

// ---- formatting ----

/** Formats a sheet in its editor as one change (undone by one ⌘Z); returns whether anything changed. */
export const format = async (ctx: Ctx, doc: Doc): Promise<boolean | null> => {
  const view = views.get(doc.path);
  const c = readyClient(doc.path);
  if (view && c) {
    flush(doc.path);
    const before = view.core.text();
    const edits = await c.request<TextEdit[] | null>("textDocument/formatting", { textDocument: { uri: uriOf(doc.path) }, options: { tabSize: 2, insertSpaces: true } }).catch(() => null);
    if (edits === null) return null;
    if (view.core.text() !== before) return false; // typed while waiting: the edits no longer fit
    const changes = editsToChanges(before, edits);
    if (changes.length) view.apply(changes, "format");
    return changes.length > 0;
  }
  // without the server: golem fmt on the saved file, read back into the editor
  if (!doc.project) return null;
  await ctx.save([doc.path], { explicit: true });
  const out = await golem(ctx, doc.project, ["fmt", rel(doc.project, doc.path)]).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
  if (out.code !== 0) {
    ctx.toast((out.stderr || out.stdout).trim() || "golem fmt に失敗しました");
    return null;
  }
  const text = await api.readText(doc.path);
  const ed = ctx.editors.get(doc.path);
  const current = ed?.text() ?? doc.text;
  if (text === current) return false;
  ed?.setText(text);
  ctx.store.dispatch({ type: "saved", path: doc.path, text });
  return true;
};

const formatNow = async (ctx: Ctx, doc: Doc) => {
  const r = await format(ctx, doc);
  if (r !== null) ctx.toast(r ? "整形しました" : "変更はありません");
};

/** ⌘S: format first (when the setting is on, with the same notices as ⌥⇧F), then save. */
const formatAndSave = async (ctx: Ctx, doc: Doc) => {
  if (ctx.config.formatOnSave) await formatNow(ctx, doc);
  await ctx.save([doc.path], { explicit: true });
};

// ---- hover and completion ----

const hoverText = (contents: unknown): string => {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n\n");
  const c = contents as { value?: string };
  return c.value ?? "";
};

const positionAt = (t: TextEditor, pos: number) => {
  const line = t.core.doc().lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
};

type Item = { label: string; detail?: string; insertText?: string };

const pluginFor = (doc: Doc, ctx: Ctx): EditorPlugin | null => {
  if (!lspDoc(doc)) return null;
  const path = doc.path;
  let editor: TextEditor | null = null;
  const current = () => allDocs(ctx.store.get()).find((d) => d.path === path) ?? doc;
  return {
    attach: (t) => {
      editor = t;
      views.set(path, t);
      queueMicrotask(() => paint(path));
      return () => {
        if (views.get(path) === t) views.delete(path);
      };
    },
    keys: [
      { id: "file.save", key: "Mod-s", run: () => (void formatAndSave(ctx, current()), true) },
      // ⌥⇧F matches by the key's place too: on macOS the option key turns F into "Ï"
      { id: "editor.format", key: "Shift-Alt-f", run: () => (void formatNow(ctx, current()), true) },
    ],
    hover: async (pos) => {
      const c = readyClient(path);
      if (!c || !editor) return null;
      flush(path);
      const r = await c.request<{ contents: unknown } | null>("textDocument/hover", { textDocument: { uri: uriOf(path) }, position: positionAt(editor, pos) }).catch(() => null);
      return hoverText(r?.contents).trim() || null;
    },
    complete: async (pos, explicit) => {
      const c = readyClient(path);
      if (!c || !editor) return null;
      const line = editor.core.doc().lineAt(pos);
      const start = completionStart(line.text.slice(0, pos - line.from), explicit);
      if (start === null) return null;
      const from = line.from + start;
      flush(path);
      const r = await c
        .request<{ items: Item[] } | Item[] | null>("textDocument/completion", { textDocument: { uri: uriOf(path) }, position: positionAt(editor, pos) })
        .catch(() => null);
      const items = Array.isArray(r) ? r : (r?.items ?? []);
      return items.length ? { from, items: items.map((i) => ({ label: i.label, detail: i.detail, apply: i.insertText ?? i.label })) } : null;
    },
  };
};

// ---- the status bar and the settings ----

const counts = (path: string) => {
  const list = diagnostics.get(path) ?? [];
  return { errors: list.filter((d) => d.severity === 1).length, warnings: list.filter((d) => d.severity === 2).length };
};

export const mountLsp = (ctx: Ctx) => {
  ctx.editorPlugins.push(pluginFor);
  ctx.store.subscribe((s, prev) => sync(ctx, s, prev));
  sync(ctx, ctx.store.get(), null);

  ctx.status.push((s) => {
    const d = focused(s);
    if (!d || !lspDoc(d)) return "";
    const c = clients.get(d.project!);
    const st = c?.state() ?? "failed";
    const label = { starting: "LSP 起動中", ready: "LSP", failed: "LSP 停止", stopped: "LSP 停止" }[st];
    const { errors, warnings } = counts(d.path);
    const problems = st === "ready" ? `<span class="problems" data-status="lsp-problems" title="エディタの診断の一覧">エラー ${errors}　警告 ${warnings}</span>` : "";
    return `${problems}<span class="${st === "ready" ? "ok" : st === "starting" ? "" : "ng"}">● ${label}</span>`;
  });
  ctx.statusActions["lsp-problems"] = (c) => {
    const d = focused(c.store.get());
    const v = d && views.get(d.path);
    if (v) v.openDiagnostics();
  };

  ctx.settings.push({
    id: "lsp",
    label: "LSP と整形",
    group: "Golem",
    render: (c) =>
      item("⌘S で整形する", "保存する前に、golem lsp の形式（.gm、.emet）と JSON の仲間（.json、.jsonc、.json5、.jsonl）を整形する。自動保存では整形しない", toggle("formatOnSave", c.config.formatOnSave)),
    onClick: async (el, c) => {
      if (el.closest<HTMLElement>("[data-toggle]")?.dataset.toggle !== "formatOnSave") return false;
      c.config.formatOnSave = !c.config.formatOnSave;
      await c.saveConfig();
      return true;
    },
  });

  window.addEventListener("beforeunload", () => clients.forEach((c) => c.stop()));
};


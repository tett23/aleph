// A small LSP client over the Rust bridge to `golem lsp`.
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { bin } from "./config";

export type LspDiagnostic = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  code?: string | number;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export type Client = {
  ready: Promise<void>;
  request: <T>(method: string, params: unknown) => Promise<T>;
  notify: (method: string, params: unknown) => void;
  onDiagnostics: (uri: string, f: (d: LspDiagnostic[]) => void) => () => void;
  status: () => "starting" | "ready" | "failed";
};

const clients = new Map<string, Client>();

const idOf = (root: string) => root.replace(/[^A-Za-z0-9]/g, "_").slice(-60);

export const uriOf = (path: string) => "file://" + path.split("/").map(encodeURIComponent).join("/");

export const lspFor = (root: string): Client => {
  const existing = clients.get(root);
  if (existing) return existing;
  const id = idOf(root);
  let seq = 0;
  let state: "starting" | "ready" | "failed" = "starting";
  const pending = new Map<number, Pending>();
  const diagnostics = new Map<string, Set<(d: LspDiagnostic[]) => void>>();
  const lastDiagnostics = new Map<string, LspDiagnostic[]>();
  const send = (msg: object) => api.lspSend(id, JSON.stringify({ jsonrpc: "2.0", ...msg })).catch(() => {});
  const request = <T>(method: string, params: unknown) =>
    new Promise<T>((resolve, reject) => {
      const n = ++seq;
      pending.set(n, { resolve: resolve as (v: unknown) => void, reject });
      send({ id: n, method, params });
      setTimeout(() => pending.has(n) && (pending.delete(n), reject(new Error("timeout"))), 8000);
    });
  const notify = (method: string, params: unknown) => void send({ method, params });

  const ready = (async () => {
    await listen<string>(`lsp-${id}`, (e) => {
      const msg = JSON.parse(e.payload);
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.reject(msg.error);
        else p?.resolve(msg.result);
      } else if (msg.method === "textDocument/publishDiagnostics") {
        lastDiagnostics.set(msg.params.uri, msg.params.diagnostics);
        diagnostics.get(msg.params.uri)?.forEach((f) => f(msg.params.diagnostics));
      } else if (msg.id !== undefined && msg.method) {
        // server requests (e.g. workspace/configuration): answer with null
        send({ id: msg.id, result: null });
      }
    });
    await api.lspStart(id, bin("golem"), root);
    await request("initialize", {
      processId: null,
      rootUri: uriOf(root),
      workspaceFolders: [{ uri: uriOf(root), name: root }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: {},
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: { completionItem: { snippetSupport: false } },
        },
      },
    });
    notify("initialized", {});
    state = "ready";
  })().catch((e) => {
    state = "failed";
    console.warn("lsp", e);
  });

  const client: Client = {
    ready,
    request,
    notify,
    status: () => state,
    onDiagnostics: (uri, f) => {
      if (!diagnostics.has(uri)) diagnostics.set(uri, new Set());
      diagnostics.get(uri)!.add(f);
      const last = lastDiagnostics.get(uri);
      if (last) f(last);
      return () => diagnostics.get(uri)?.delete(f);
    },
  };
  clients.set(root, client);
  return client;
};

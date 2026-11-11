// A client of one `golem lsp`, over the Rust bridge (docs/adr/0009).
import { listen } from "@tauri-apps/api/event";
import { api } from "../api.ts";
import { uriOf, type Legend } from "./protocol.ts";

export type LspDiagnostic = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
};

export type ClientState = "starting" | "ready" | "failed" | "stopped";

export type Client = {
  root: string;
  ready: Promise<boolean>;
  state: () => ClientState;
  legend: () => Legend | null;
  supportsFileRename: () => boolean;
  request: <T>(method: string, params: unknown) => Promise<T>;
  notify: (method: string, params: unknown) => void;
  stop: () => void;
};

export type Handlers = {
  onDiagnostics: (uri: string, d: LspDiagnostic[]) => void;
  onExit: (c: Client) => void;
};

const TOKEN_TYPES = ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"];
const TOKEN_MODIFIERS = ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"];

let serial = 0;

export const startClient = (root: string, h: Handlers, aleph?: { plotCsv: string; workspaceUri?: string; wikiSheets?: { uri: string; title: string | null }[] }): Client => {
  const id = `p${++serial}`;
  let seq = 0;
  let state: ClientState = "starting";
  let legend: Legend | null = null;
  let supportsFileRename = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const unlisten: (() => void)[] = [];
  let sent = Promise.resolve();
  const send = (msg: object) => {
    const task = sent.then(() => api.lspSend(id, JSON.stringify({ jsonrpc: "2.0", ...msg })));
    sent = task.catch(() => {});
    return task;
  };
  const request = <T>(method: string, params: unknown) =>
    new Promise<T>((resolve, reject) => {
      if (state === "failed" || state === "stopped") return reject(new Error("LSP is not running"));
      const n = ++seq;
      pending.set(n, { resolve: resolve as (v: unknown) => void, reject });
      void send({ id: n, method, params }).catch((error) => { pending.delete(n); reject(error); });
      setTimeout(() => pending.has(n) && (pending.delete(n), reject(new Error(`${method}: timeout`))), 10000);
    });
  const notify = (method: string, params: unknown) => {
    if (state === "ready") void send({ method, params }).catch(() => {});
  };
  const end = (s: ClientState) => {
    state = s;
    pending.forEach((p) => p.reject(new Error("LSP ended")));
    pending.clear();
    unlisten.forEach((f) => f());
  };

  const client: Client = {
    root,
    ready: Promise.resolve(false),
    state: () => state,
    legend: () => legend,
    supportsFileRename: () => supportsFileRename,
    request,
    notify,
    stop: () => {
      if (state === "stopped") return;
      end("stopped");
      void api.lspStop(id).catch(() => {});
    },
  };

  client.ready = (async () => {
    unlisten.push(
      await listen<string>(`lsp-${id}`, (e) => {
        const msg = JSON.parse(e.payload);
        if (msg.id !== undefined && !msg.method) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p?.reject(msg.error);
          else p?.resolve(msg.result);
        } else if (msg.method === "textDocument/publishDiagnostics") h.onDiagnostics(msg.params.uri, msg.params.diagnostics ?? []);
        else if (msg.id !== undefined && msg.method) void send({ id: msg.id, result: null }).catch(() => {}); // server requests get an empty answer
      }),
      await listen(`lsp-${id}-exit`, () => {
        if (state === "stopped") return;
        end("failed");
        h.onExit(client);
      }),
    );
    await api.lspStart(id, root);
    const init = await request<{ capabilities: { semanticTokensProvider?: { legend: Legend }; workspace?: { fileOperations?: { willRename?: unknown; didRename?: unknown } } } }>("initialize", {
      processId: null,
      rootUri: uriOf(root),
      workspaceFolders: [{ uri: uriOf(root), name: root.split("/").pop() }],
      initializationOptions: aleph ? { aleph } : undefined,
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: { fileOperations: { willRename: true, didRename: true }, workspaceEdit: { documentChanges: true } },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: {},
          hover: { contentFormat: ["plaintext", "markdown"] },
          completion: { completionItem: { snippetSupport: false } },
          formatting: {},
          semanticTokens: { requests: { full: true }, tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS, formats: ["relative"] },
        },
      },
    });
    legend = init.capabilities.semanticTokensProvider?.legend ?? null;
    supportsFileRename = !!init.capabilities.workspace?.fileOperations?.willRename && !!init.capabilities.workspace?.fileOperations?.didRename;
    state = "ready";
    void send({ method: "initialized", params: {} }).catch(() => {});
    return true;
  })().catch((e) => {
    console.warn("lsp", root, e);
    end("failed");
    void api.lspStop(id).catch(() => {});
    return false;
  });
  return client;
};

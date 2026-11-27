import { within } from "../path.ts";

/** The only request the isolated diff document may send to its owner. */
type OpenFile = { type: "open-file"; path: string; newTab: boolean };
export type DiffKey = { type: "app-key"; key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean; isComposing: boolean };

export const validDiffKey = (message: unknown): DiffKey | null => {
  if (!message || typeof message !== "object") return null;
  const key = message as Partial<DiffKey>;
  if (key.type !== "app-key" || typeof key.key !== "string" || !key.key || key.key.length > 64 || typeof key.code !== "string" || key.code.length > 64) return null;
  if ([key.metaKey, key.ctrlKey, key.altKey, key.shiftKey, key.repeat, key.isComposing].some((value) => typeof value !== "boolean")) return null;
  return { type: "app-key", key: key.key, code: key.code, metaKey: key.metaKey!, ctrlKey: key.ctrlKey!, altKey: key.altKey!, shiftKey: key.shiftKey!, repeat: key.repeat!, isComposing: key.isComposing! };
};

export const validDiffOpen = (message: unknown, workspace: string, allowed: ReadonlySet<string>): string | null => {
  if (!message || typeof message !== "object") return null;
  const request = message as Partial<OpenFile>;
  if (request.type !== "open-file" || typeof request.path !== "string" || typeof request.newTab !== "boolean" || !allowed.has(request.path)) return null;
  return within(workspace, workspace, request.path);
};

// This static script runs with an opaque origin. Keep its CSP hash in sync below and in tauri.conf.json.
const runtime = `let port = null;
let pressed = null;
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.type !== "init" || port || event.ports.length !== 1) return;
  port = event.ports[0];
  document.querySelector("[data-snapshot-target]")?.scrollIntoView({ block: "center" });
  if (document.hasFocus?.()) port.postMessage({ type: "activate-pane" });
});
window.addEventListener("focus", () => port?.postMessage({ type: "activate-pane" }));
document.addEventListener("pointerdown", (event) => {
  port?.postMessage({ type: "activate-pane" });
  pressed = event.button === 0 ? event.target.closest("[data-open]") : null;
});
document.addEventListener("pointercancel", () => { pressed = null; });
window.addEventListener("blur", () => { pressed = null; });
document.addEventListener("click", (event) => {
  const link = event.target.closest?.("[data-open]");
  if (event.button !== 0 || !port || !link || pressed !== link) return;
  pressed = null;
  port.postMessage({ type: "open-file", path: link.dataset.open, newTab: event.altKey });
});
document.addEventListener("keydown", (event) => {
  if (!port || event.isComposing || event.keyCode === 229) return;
  const link = event.target.closest?.("[data-open]");
  if (event.key === "Enter" && link) {
    port.postMessage({ type: "open-file", path: link.dataset.open, newTab: event.altKey });
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && ["a", "c"].includes(event.key.toLowerCase())) return;
  if (event.key.startsWith("Arrow") && (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) return;
  port.postMessage({ type: "app-key", key: event.key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.isComposing });
  if (event.metaKey || event.ctrlKey || event.altKey) event.preventDefault();
});`;

const POLICY = "default-src 'none'; script-src 'sha256-NhcOVyJGo7rkfEOzF9XvNIEKCBbXjAwBlJltqQQxrZE='; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const STYLE = `html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:12px system-ui,sans-serif}body{padding:8px 12px 24px;box-sizing:border-box}.dline{padding:12px 0;font-size:12.5px}.dfile{border:1px solid var(--border);border-radius:6px;margin:0 0 10px;overflow:hidden}.dfhead{display:flex;align-items:center;gap:6px;padding:5px 10px;font-size:12px;background:var(--bg-2);border-bottom:1px solid var(--border)}.dname{font-family:var(--mono,ui-monospace,monospace);color:var(--text)}.dname.link{cursor:pointer;text-decoration:underline dotted var(--faint);text-underline-offset:3px}.dname.link:hover{color:var(--accent)}.dfhead small{color:var(--faint)}.dkind{margin-left:auto;color:var(--text-2)}.dstat{font-family:var(--mono,ui-monospace,monospace);font-size:11.5px}pre{font:11.5px/1.6 var(--mono,ui-monospace,monospace);white-space:pre-wrap;margin:0;padding:6px 10px;color:var(--text-2)}.d-add{color:var(--add)}.d-del{color:var(--del)}.dnote,.dmore{padding:6px 10px;font-size:12px}.snapshot-diff pre{overflow-wrap:anywhere}`;
const COLORS = ["--bg", "--bg-2", "--text", "--text-2", "--faint", "--accent", "--border", "--add", "--del", "--mono"];

/** A complete document, not an HTML fragment in the parent's DOM. */
export const diffFrameHtml = (content: string, theme = "") =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><style>:root{${theme}}${STYLE}</style><body>${content}</body><script>${runtime}</script>`;

const previous = new WeakMap<HTMLElement, () => void>();
export const revokeDiffFrame = (body: HTMLElement) => previous.get(body)?.();

/** Mount a fresh sandbox and private message channel for one diff generation. */
export const mountDiffFrame = (body: HTMLElement, content: string, onRequest: (message: unknown) => void): (() => void) => {
  previous.get(body)?.();
  const frame = document.createElement("iframe");
  if (!frame.sandbox?.supports("allow-scripts")) throw new Error("差分タブの隔離に対応していません");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", "差分の内容");
  frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:transparent";
  const values = getComputedStyle(body);
  const theme = COLORS.map((name) => {
    const value = values.getPropertyValue(name).trim();
    return /^[#\w(),.%\s-]+$/.test(value) ? `${name}:${value};` : "";
  }).join("");
  const channel = new MessageChannel();
  let open = true;
  let transferred = false;
  const current = () => open && frame.isConnected && !body.closest<HTMLElement>(".tabview")?.hidden;
  channel.port1.onmessage = ({ data }) => {
    if (!current()) return;
    if ((data?.type === "activate-pane" || data?.type === "app-key") && document.activeElement !== frame) return;
    onRequest(data);
  };
  channel.port1.start();
  frame.onload = () => {
    if (!current() || transferred) return;
    transferred = true;
    frame.contentWindow?.postMessage({ type: "init" }, "*", [channel.port2]);
  };
  frame.srcdoc = diffFrameHtml(content, theme);
  body.replaceChildren(frame);
  const close = () => {
    if (!open) return;
    open = false;
    channel.port1.close();
    channel.port2.close();
    frame.remove();
    if (previous.get(body) === close) previous.delete(body);
  };
  previous.set(body, close);
  return close;
};

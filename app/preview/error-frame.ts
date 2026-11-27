import { esc } from "../esc.ts";

/** A separate, scriptless document keeps error-text selection inside the preview tab. */
export const errorFrameHtml = (text: string, color = "#d25544") => `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;min-height:100%;background:transparent}pre{margin:0;padding:16px;color:${/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : "#d25544"};font:12px/1.6 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;user-select: text;-webkit-user-select: text}</style>
<pre>${esc(text)}</pre>`;

export const mountIsolatedError = (pane: HTMLElement, text: string): (() => void) => {
  const frame = document.createElement("iframe");
  if (!frame.sandbox?.supports("allow-scripts")) throw new Error("プレビューの隔離に対応していません");
  frame.setAttribute("sandbox", "");
  frame.setAttribute("title", "プレビューのエラー");
  frame.style.cssText = "display:block;width:100%;height:100%;min-height:320px;border:0;background:transparent";
  frame.srcdoc = errorFrameHtml(text, getComputedStyle(pane).getPropertyValue("--del").trim());
  pane.classList.remove("from-right");
  pane.replaceChildren(frame);
  return () => {
    frame.remove();
  };
};

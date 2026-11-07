// The vertical editor: a textarea (vertical-rl) over a mirror with the same line
// breaks, which shows each line's number above it and the change mark above that
// (docs/adr/0007). No colouring and no LSP inside it.
import type { Ctx } from "../ctx.ts";
import { lineMarks } from "../diff.ts";
import { h } from "../icons.ts";
import type { Doc } from "../store.ts";
import type { Editor } from "./cm.ts";
import { charsOf } from "./host.ts";
import { lineOffset, mirrorHtml } from "./mirror.ts";

export const createVertical = (el: HTMLElement, doc: Doc, ctx: Ctx): Editor => {
  const wrap = h(`<div class="vwrap"><div class="vstack"><div class="vmirror" aria-hidden="true"></div><textarea class="vedit" spellcheck="false"></textarea></div></div>`);
  const ta = wrap.querySelector("textarea")!;
  const mirror = wrap.querySelector<HTMLElement>(".vmirror")!;
  const stack = wrap.querySelector<HTMLElement>(".vstack")!;
  ta.value = doc.text;
  let base: string | null | undefined;
  const setChars = (c: number) => wrap.style.setProperty("--vchars", String(c));
  setChars(charsOf(doc, ctx.config.charsOverride));

  const layout = async (reset = false) => {
    if (reset || base === undefined) base = await ctx.baseText(doc);
    mirror.innerHTML = mirrorHtml(ta.value, lineMarks(base, ta.value));
    // grow sideways with the text instead of scrolling inside the textarea
    ta.style.width = "0px";
    const w = Math.max(ta.scrollWidth, wrap.clientWidth - 40);
    ta.style.width = `${w}px`;
    stack.style.width = `${w}px`;
  };
  let timer = 0;
  ta.addEventListener("input", () => {
    ctx.store.dispatch({ type: "edit", path: doc.path, text: ta.value });
    clearTimeout(timer);
    timer = window.setTimeout(() => void layout(), 120);
  });
  ta.addEventListener("keydown", (e) => {
    // ⌘S saves without formatting in vertical (docs/adr/0007)
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      void ctx.save([doc.path], { explicit: true });
    }
  });
  el.append(wrap);
  void layout();
  ta.setSelectionRange(0, 0); // open at the beginning, the right edge
  ta.focus();
  return {
    view: null,
    text: () => ta.value,
    setWidth: (c) => (setChars(c), void layout()),
    setInvisibles: () => {},
    setGrid: () => {},
    refreshMarks: (reset) => void layout(reset),
    goto: (line) => {
      const pos = lineOffset(ta.value, line);
      ta.focus();
      ta.setSelectionRange(pos, pos);
      mirror.children[line - 1]?.scrollIntoView({ inline: "center", block: "nearest" });
    },
    setText: (text) => {
      ta.value = text;
      void layout();
    },
    destroy: () => (clearTimeout(timer), wrap.remove()),
  };
};

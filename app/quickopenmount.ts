// ⌘P (docs/adr/0022): plugs the sheet finder into the palette's box.
import type { Ctx } from "./ctx.ts";
import { basename } from "./path.ts";
import { openPalette } from "./palette.ts";
import { rankSheets, sheetsOf } from "./quickopen.ts";
import { recentSheets } from "./recentpanel.ts";
import { treeEntries } from "./ui/tree.ts";

export const mountQuickOpen = (ctx: Ctx) => {
  ctx.findSheets = (q) => {
    const ws = ctx.store.get().workspace;
    if (!ws) return [];
    return rankSheets(sheetsOf(treeEntries(), ws, ctx.titles), q, recentSheets(ws)).map((s) => {
      const label = s.title ?? basename(s.path);
      return {
        label,
        detail: s.rel,
        icon: "file-text",
        // the marks are drawn on the label; a match on the path marks the path's file name only when it is the label
        marks: s.field === "title" || (!s.title && s.marks.every((m) => m >= s.rel.length - label.length)) ? s.marks.map((m) => (s.field === "rel" ? m - (s.rel.length - label.length) : m)) : [],
        // ⌘↩ opens a new tab once tabs exist (docs/adr/0024); until then both replace the sheet
        run: () => void ctx.open([s.path]),
      };
    });
  };
  ctx.commands.push({
    id: "file.quickOpen",
    label: "シートを開く",
    icon: "search",
    keys: ["Mod-p"],
    menu: true,
    when: (s) => !!s.workspace,
    run: (c) => openPalette(c),
  });
};

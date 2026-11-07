// ⌘P (docs/adr/0022): plugs the sheet finder into the palette's box.
import { addCommands } from "./commands.ts";
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
      return {
        label: s.title ?? basename(s.path),
        detail: s.rel,
        icon: "file-text",
        marks: s.field === "title" ? s.marks : [],
        detailMarks: s.field === "rel" ? s.marks : [],
        // ⌘↩ opens in a new tab (docs/adr/0024)
        run: (alt) => void ctx.open([s.path], undefined, { newTab: alt }),
      };
    });
  };
  addCommands(ctx.commands, {
    id: "file.quickOpen",
    label: "シートを開く",
    icon: "search",
    keys: ["Mod-p"],
    menu: true,
    when: (s) => !!s.workspace,
    run: (c) => openPalette(c),
  });
};

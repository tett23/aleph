// The ⌘P box and the commands (docs/adr/0022, docs/adr/0023): one input with a
// list; a leading ">" lists commands, anything else the sheets (when a sheet
// finder is plugged in). Also the built-in commands and the window's keys.
import { addCommand, pushRecent, rankCommands, splitQuery, type Command } from "./commands.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { fuzzy } from "./fuzzy.ts";
import { icon } from "./icons.ts";
import { hintOf } from "./keybind.ts";
import { openWindow } from "./preview/mount.ts";
import { focused, type LeftPanel, type RightPanel, type SidePane } from "./store.ts";
import { previewsFor, verticalOn, canVertical } from "./toolbar.ts";
import { openSettings } from "./ui/settings.ts";
import { runTreeAct } from "./ui/tree.ts";
import { uiState } from "./uistate.ts";

/** One row of the box. */
export type PaletteItem = { label: string; detail?: string; detailMarks?: number[]; hint?: string; icon?: string; marks?: number[]; run: (alt: boolean) => void };

const RECENT_KEY = "recentCommands";

/** Runs a command and remembers it for the palette. */
export const runCommand = (ctx: Ctx, c: Command) => {
  uiState().set(RECENT_KEY, pushRecent(uiState().get<string[]>(RECENT_KEY, []), c.id));
  return c.run(ctx);
};

const marked = (text: string, marks: number[] = []) => {
  const set = new Set(marks);
  let out = "";
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    out += set.has(i) ? `<b>${esc(ch)}</b>` : esc(ch);
    i += ch.length;
  }
  return out;
};

const commandItems = (ctx: Ctx, q: string): PaletteItem[] =>
  rankCommands(ctx.commands, ctx.store.get(), q, uiState().get<string[]>(RECENT_KEY, [])).map((c) => ({
    label: c.label,
    detail: c.id,
    icon: c.icon,
    hint: hintOf(ctx, c),
    marks: q ? fuzzy(q, c.label)?.positions : undefined,
    run: () => void runCommand(ctx, c),
  }));

/** Opens the box with some text in its input (">" for commands). */
export const openPalette = (ctx: Ctx, initial = "") => {
  document.querySelector(".palette")?.remove();
  const back = document.activeElement as HTMLElement | null;
  const box = document.createElement("div");
  box.className = "palette";
  box.innerHTML = `<input class="field" spellcheck="false" autocomplete="off"><ul></ul>`;
  const input = box.querySelector("input")!;
  const ul = box.querySelector("ul")!;
  input.value = initial;
  let items: PaletteItem[] = [];
  let sel = 0;
  const close = (restore: boolean) => {
    box.remove();
    document.removeEventListener("mousedown", outside, true);
    if (restore) back?.focus?.();
  };
  const draw = () => {
    const { mode, q } = splitQuery(input.value);
    items = mode === "commands" ? commandItems(ctx, q) : (ctx.findSheets?.(q) ?? []);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    ul.innerHTML = items.length
      ? items
          .map(
            (it, k) =>
              `<li data-k="${k}" ${k === sel ? "aria-selected" : ""}>${it.icon ? icon(it.icon, 14) : ""}<span class="pl">${marked(it.label, it.marks)}</span>${
                it.detail ? `<small>${marked(it.detail, it.detailMarks)}</small>` : ""
              }${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ""}</li>`,
          )
          .join("")
      : `<li class="empty">${mode === "commands" ? "一致するコマンドはありません" : ctx.findSheets ? (q ? "一致するシートはありません" : "最近開いたシートはありません。名前を打つと探します") : "先頭に > を打つと、コマンドを探します"}</li>`;
    ul.querySelector("[aria-selected]")?.scrollIntoView({ block: "nearest" });
  };
  const pick = (k: number, alt: boolean) => {
    const it = items[k];
    if (!it) return;
    close(true);
    it.run(alt);
  };
  input.addEventListener("input", () => ((sel = 0), draw()));
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) sel = (sel + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      draw();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(sel, e.metaKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    }
    e.stopPropagation();
  });
  // taken at mousedown with the default prevented, so the input keeps the focus until the pick
  ul.addEventListener("mousedown", (e) => {
    const k = (e.target as HTMLElement).closest<HTMLElement>("li[data-k]")?.dataset.k;
    if (k === undefined) return;
    e.preventDefault();
    pick(Number(k), e.metaKey);
  });
  // under the overlay title bar the press that ran a menu item can arrive after its mouseup (see onPress
  // in ui/dom.ts), so a press just after opening is that one, not one outside the box
  const opened = performance.now();
  const outside = (e: MouseEvent) => {
    if (performance.now() - opened < 400) return;
    if (!box.contains(e.target as Node)) close(false);
  };
  document.addEventListener("mousedown", outside, true);
  document.body.append(box);
  draw();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
};

// ---- the built-in commands ----

const focusedEdit = (ctx: Ctx) => {
  const d = focused(ctx.store.get());
  return (d && ctx.editors.get(d.path)?.edit) || null;
};

/** An editor command: run in the focused sheet's editor, which takes the focus back first. */
const editorCommand = (id: string, label: string, icon: string, keys?: string[], menu = false): Command => ({
  id,
  label,
  icon,
  keys,
  menu,
  scope: "editor",
  when: () => true,
  run: (ctx) => {
    const t = focusedEdit(ctx);
    if (!t) return;
    t.view.focus();
    t.command(id);
  },
});

const LEFT: [LeftPanel, string, string][] = [
  ["files", "ファイル", "files"],
  ["git", "Git", "git-branch"],
  ["diagnostics", "診断", "triangle-alert"],
  ["library", "共有ライブラリ", "library-big"],
];
const RIGHT: [RightPanel, string, string][] = [
  ["attach", "添付", "paperclip"],
  ["outline", "アウトライン", "list"],
  ["library", "このプロジェクトの共有ライブラリ", "library-big"],
];
const PREVIEW: [SidePane, string][] = [
  ["none", "原稿のみ"],
  ["plain", "本文"],
  ["pages", "ページ"],
];

export const mountCommands = (ctx: Ctx) => {
  const add = (c: Command) => addCommand(ctx.commands, c);
  const hasEdit = () => !!focusedEdit(ctx);
  const withEdit = (id: string, c: Command): Command => ({ ...c, when: () => hasEdit() && !!focusedEdit(ctx)?.hasCommand(id) });

  add({ id: "palette.open", label: "コマンドパレット", icon: "search", keys: ["Mod-Shift-p"], when: () => true, run: (c) => openPalette(c, ">") });
  add({ id: "settings.open", label: "設定", icon: "settings", keys: ["Mod-,"], when: () => true, run: (c) => void openSettings(c) });
  for (const s of ctx.settings) add({ id: `settings.${s.id}`, label: `設定：${s.label}`, icon: "settings", when: () => true, run: (c) => void openSettings(c, s.id) });

  add({ id: "file.newSheet", label: "新しいシート", icon: "square-pen", when: (s) => !!s.workspace, run: (c) => runTreeAct(c, "new-file") });
  add({ id: "file.newFolder", label: "新しいフォルダ", icon: "folder-plus", when: (s) => !!s.workspace, run: (c) => runTreeAct(c, "new-folder") });
  add({ id: "file.newProject", label: "新しいプロジェクト（golem new）", icon: "book-plus", when: (s) => !!s.workspace, run: (c) => runTreeAct(c, "new-project") });
  add({
    id: "file.save",
    label: "保存",
    icon: "file",
    keys: ["Mod-s"],
    scope: "editor",
    when: (s) => !!focused(s),
    run: (c) => {
      const t = focusedEdit(c);
      const d = focused(c.store.get());
      if (t?.command("file.save")) return;
      if (d) void c.save([d.path], { explicit: true });
    },
  });

  for (const [panel, label, ic] of LEFT)
    add({
      id: `view.left.${panel}`,
      label: `サイドバー：${label}`,
      icon: ic,
      when: () => true,
      run: (c) => {
        const s = c.store.get();
        if (!(s.showLeft && s.left === panel)) c.store.dispatch({ type: "left", panel });
      },
    });
  add({ id: "view.toggleLeft", label: "サイドバーを出し入れ", icon: "panel-left", when: () => true, run: (c) => c.store.dispatch({ type: "left", panel: c.store.get().left }) });
  for (const [panel, label, ic] of RIGHT) add({ id: `view.right.${panel}`, label: `右のパネル：${label}`, icon: ic, when: () => true, run: (c) => c.store.dispatch({ type: "right", panel }) });
  add({ id: "view.toggleRight", label: "右のパネルを出し入れ", icon: "panel-right", when: () => true, run: (c) => c.store.dispatch({ type: "toggleRight" }) });
  add({
    id: "view.plot",
    label: "プロット",
    icon: "table-2",
    when: (s) => !!(focused(s)?.project ?? s.plot),
    run: (c) => {
      const s = c.store.get();
      const p = focused(s)?.project ?? s.plot;
      if (p) c.store.dispatch({ type: "plot", project: p });
    },
  });
  const prose = (s: ReturnType<typeof ctx.store.get>) => s.open.length > 0 && s.open.every((d) => canVertical(d.kind));
  add({ id: "view.vertical", label: "縦書き", icon: "arrow-up-down", when: (s) => prose(s) && !verticalOn(s), run: (c) => c.store.dispatch({ type: "vertical", on: true }) });
  add({ id: "view.horizontal", label: "横書き", icon: "arrow-right-left", when: (s) => prose(s) && verticalOn(s), run: (c) => c.store.dispatch({ type: "vertical", on: false }) });

  for (const [side, label] of PREVIEW)
    add({
      id: `preview.${side}`,
      label: `プレビュー：${label}`,
      icon: "eye",
      when: (s) => {
        const d = focused(s);
        return !!d && previewsFor(d.kind).includes(side);
      },
      run: (c) => c.store.dispatch({ type: "side", side }),
    });
  add({
    id: "preview.window",
    label: "プレビューを別のウィンドウに出す",
    icon: "external-link",
    when: (s) => {
      const d = focused(s);
      return !!d?.project && d.kind === "gm";
    },
    run: (c) => {
      const s = c.store.get();
      const d = focused(s)!;
      void openWindow(c, s.side === "pages" ? "pages" : "plain", d.project!);
    },
  });

  const editorCommands: [string, string, string, string[]?, boolean?][] = [
    ["editor.undo", "取り消す", "refresh-cw", ["Mod-z"]],
    ["editor.redo", "やり直す", "refresh-cw", ["Mod-Shift-z", "Mod-y"]],
    ["editor.selectAll", "すべて選ぶ", "list", ["Mod-a"]],
    ["editor.find", "シートの中を検索と置換", "search", ["Mod-f"]],
    ["editor.indent", "字下げ", "chevron-right", ["Tab"]],
    ["editor.outdent", "字下げを戻す", "chevron-down", ["Shift-Tab"]],
    ["editor.complete", "補完", "sparkles", ["Ctrl-Space"]],
    ["editor.format", "整形", "wand-sparkles", ["Shift-Alt-f"], true],
  ];
  for (const [id, label, ic, keys, menu] of editorCommands) add(withEdit(id, editorCommand(id, label, ic, keys, menu)));
  add({
    id: "editor.diagnostics",
    label: "診断の一覧",
    icon: "list",
    menu: true,
    when: () => hasEdit(),
    run: (c) => focusedEdit(c)?.openDiagnostics(),
  });
};

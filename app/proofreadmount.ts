// The writing checks in the editors (docs/adr/0030): run on a sheet when it is
// opened and 700 ms after typing stops, shown as diagnostics of their own
// source; English spelling asks macOS once per word. The rules are in proofread.ts.
import { api } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import type { TextEditor } from "./ed/editor.ts";
import { checkText, englishWords, RULES, segments, spellDiags, toAsk } from "./proofread.ts";
import { forgetGrid } from "./docs.ts";
import { allDocs, focused, type Doc } from "./store.ts";
import { readGrid } from "./workspace.ts";
import { item, toggle } from "./ui/settings.ts";
import { esc } from "./esc.ts";

const KINDS = ["gm", "md", "txt"];
const LIMIT = 300_000;
const SOURCE = "proofread";

/** What macOS said of each word: true when spelled wrong. */
const known = new Map<string, boolean>();
const editors = new Set<{ t: TextEditor; kind: string; project: string | null; run: () => void }>();
// each project's writing direction, read again from style.toml when it is saved (docs/adr/0057)
const vertical = new Map<string, boolean>();
const verticalOf = (doc: Doc) => (doc.project ? (vertical.get(doc.project) ?? doc.grid.vertical) : false);
const tooLong = new Set<TextEditor>();

const check = async (ctx: Ctx, t: TextEditor, kind: string, isVertical: boolean) => {
  const cfg = ctx.config.proofread;
  const text = t.core.text();
  const was = tooLong.has(t);
  if (text.length > LIMIT) {
    tooLong.add(t);
    t.setDiagnostics([], SOURCE);
    if (!was) ctx.refresh(["status"]);
    return;
  }
  tooLong.delete(t);
  if (was) ctx.refresh(["status"]);
  const diags = checkText(kind, text, cfg, { vertical: isVertical });
  t.setDiagnostics(diags, SOURCE);
  if (!cfg.enabled || !cfg.rules.spelling) return;
  const words = englishWords(segments(kind, text), text);
  const ask = toAsk(words.map((w) => w.word), known);
  if (ask.length) {
    const wrong = new Set(await api.spellCheck(ask).catch(() => []));
    for (const w of ask) known.set(w, wrong.has(w));
    // the text may have changed while asking: the next run uses the answers
    if (t.core.text() !== text) return;
  }
  const misspelled = new Set(words.filter((w) => known.get(w.word)).map((w) => w.word));
  t.setDiagnostics([...diags, ...spellDiags(words, misspelled, cfg.ignoreWords)], SOURCE);
};

const rerunAll = () => editors.forEach((e) => e.run());

export const mountProofread = (ctx: Ctx) => {
  ctx.editorPlugins.push((doc, c) => {
    if (!KINDS.includes(doc.kind)) return null;
    return {
      attach: (t) => {
        let timer = 0;
        const run = () => void check(c, t, doc.kind, verticalOf(doc));
        const entry = { t, kind: doc.kind, project: doc.project, run };
        editors.add(entry);
        const off = t.core.listen(() => {
          clearTimeout(timer);
          timer = window.setTimeout(run, 700);
        });
        queueMicrotask(run);
        return () => {
          clearTimeout(timer);
          off();
          editors.delete(entry);
          tooLong.delete(t);
        };
      },
    };
  });

  // style.toml saved: its project's sheets are checked again with its writing direction (docs/adr/0057)
  ctx.store.subscribe((s, prev) => {
    for (const d of allDocs(s)) {
      if (!d.project || !d.path.endsWith("/style.toml")) continue;
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (!before || before.saved === d.saved) continue;
      const v = readGrid(d.saved).vertical;
      forgetGrid(d.project);
      if (vertical.get(d.project) === v) continue;
      vertical.set(d.project, v);
      editors.forEach((e) => e.project === d.project && e.run());
    }
  });

  ctx.status.push((s) => {
    const d = focused(s);
    const t = d && ctx.editors.get(d.path)?.edit;
    return t && tooLong.has(t) && ctx.config.proofread.enabled ? `<span class="muted">長いため文章の検査をしていません</span>` : "";
  });

  ctx.settings.push({
    id: "proofread",
    label: "文章の検査",
    group: "オプション",
    render: (c) => {
      const p = c.config.proofread;
      return (
        item("文章を検査する", ".gm、.md、.txt の本文を検査し、診断として出す（命令、式、コード、URL は除く）", toggle("proofread", p.enabled)) +
        RULES.map(([id, label, note]) => item(label, esc(note), toggle(`proofread.${id}`, p.rules[id]))).join("") +
        item(
          "英語の綴りで無視する語",
          "1 行に 1 語。大文字と小文字は区別しない",
          `<textarea class="field" data-proofread-ignore rows="4" style="width:240px">${esc(p.ignoreWords.join("\n"))}</textarea>`,
        )
      );
    },
    onClick: async (el, c) => {
      const k = el.closest<HTMLElement>("[data-toggle]")?.dataset.toggle;
      if (!k || !k.startsWith("proofread")) return false;
      const p = c.config.proofread;
      if (k === "proofread") p.enabled = !p.enabled;
      else {
        const id = k.slice("proofread.".length) as keyof typeof p.rules;
        p.rules[id] = !p.rules[id];
      }
      await c.saveConfig();
      rerunAll();
      return true;
    },
    onChange: async (el, c) => {
      if (el.dataset.proofreadIgnore === undefined) return false;
      c.config.proofread.ignoreWords = el.value.split("\n").map((w) => w.trim()).filter(Boolean);
      await c.saveConfig();
      rerunAll();
      return true;
    },
  });
};

// golem and shem, found by the setting, the bundled copy, ~/.local/bin, Homebrew, then PATH (docs/adr/0008).
// Rust reads the setting itself (docs/adr/0042); the paths change only through it (docs/adr/0050).
// Each row can reload its binary or go back to the default search without restarting the app (docs/adr/0112).
import { api, type Out, type Tool } from "./api.ts";
import { rereadComposition } from "./compositionmount.ts";
import { adopt } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { afterPathChange, mayChangePath, reload, resetEnabled, type ReloadDeps } from "./golem-reload.ts";
import { forgetUnsupported, updatingReferences } from "./outside-move.ts";
import { movingTree } from "./tree-move-flow.ts";
import { item } from "./ui/settings.ts";

export const golem = (_ctx: Ctx, cwd: string, args: string[]): Promise<Out> => api.tool("golem", cwd, args);
export const shem = (_ctx: Ctx, cwd: string, args: string[]): Promise<Out> => api.tool("shem", cwd, args);
const info = async (name: Tool) => {
  try {
    const i = await api.toolInfo(name);
    const differs = i.bundled && !i.version.includes(i.bundled.replace(/^v/, ""));
    return `${esc(i.version)}（${esc(i.path)}）${differs ? `<br>同梱の版は ${esc(i.bundled)}` : ""}`;
  } catch (e) {
    return `<span class="ng">${esc(String(e))}</span>`;
  }
};

const PROGRAM = { golemPath: "golem", shemPath: "shem" } as const;
type Key = keyof typeof PROGRAM;

/** A row's buttons: 選択, 再読み込み, and デフォルトに戻す while a path is saved (docs/adr/0112). */
const buttons = (k: Key, saved: string) =>
  `<span class="btn" data-pick="${k}">選択</span><span class="btn" data-reload="${k}">再読み込み</span><span class="btn${resetEnabled(saved) ? "" : " disabled"}" data-reset="${k}"${resetEnabled(saved) ? "" : ` aria-disabled="true"`}>デフォルトに戻す</span>`;

/** The app's side of a reload; the section is drawn again by returning true from its handler. */
const deps = (ctx: Ctx): ReloadDeps => ({
  moving: () => movingTree() || updatingReferences(),
  info: (tool) => api.toolInfo(tool),
  resetLsp: () => ctx.stopAllLsp?.(),
  resync: async () => ctx.syncLsp?.(),
  reread: () => rereadComposition(ctx),
  forget: forgetUnsupported,
  redraw: () => {},
  notify: (message, level) => void ctx.notify({ message, level, sticky: level === "error" }),
});

export const mountTools = (ctx: Ctx) => {
  ctx.settings.push({
    id: "tools",
    label: "Golem と shem",
    group: "Golem",
    render: async (c) =>
      item("Golem のバイナリ", `${await info("golem")}<br>空なら、同梱のもの、~/.local/bin、Homebrew、PATH の順に探す`, `<div class="binctl"><input class="field" data-path="golemPath" value="${esc(c.config.golemPath)}" placeholder="同梱">${buttons("golemPath", c.config.golemPath)}</div>`) +
      item("shem のバイナリ", `${await info("shem")}<br>ページのプレビューで PDF を PNG にする`, `<div class="binctl"><input class="field" data-path="shemPath" value="${esc(c.config.shemPath)}" placeholder="同梱">${buttons("shemPath", c.config.shemPath)}</div>`),
    onClick: async (el, c) => {
      const d = deps(c);
      const reloaded = el.closest<HTMLElement>("[data-reload]")?.dataset.reload as Key | undefined;
      if (reloaded) {
        await reload(PROGRAM[reloaded], d);
        return true;
      }
      const reset = el.closest<HTMLElement>("[data-reset]")?.dataset.reset as Key | undefined;
      if (reset) {
        if (!resetEnabled(c.config[reset]) || !mayChangePath(PROGRAM[reset], d)) return false;
        const written = await api.setBinary(PROGRAM[reset], "");
        if (written) adopt(c.config, written);
        await c.saveConfig();
        await afterPathChange(PROGRAM[reset], !!written, d);
        return true;
      }
      const k = el.closest<HTMLElement>("[data-pick]")?.dataset.pick as Key | undefined;
      if (!k || !mayChangePath(PROGRAM[k], d)) return false;
      const written = await api.chooseBinary(PROGRAM[k]);
      if (!written) return false;
      adopt(c.config, written);
      await c.saveConfig();
      await afterPathChange(PROGRAM[k], true, d);
      return true;
    },
    onChange: async (el, c) => {
      const k = el.dataset.path as Key | undefined;
      if (!k) return false;
      const d = deps(c);
      // during a move Golem's path stays; the field goes back
      if (!mayChangePath(PROGRAM[k], d)) return true;
      // a typed path is used after a native confirmation; stopped, the field goes back
      const written = await api.setBinary(PROGRAM[k], el.value);
      if (written) adopt(c.config, written);
      await c.saveConfig();
      await afterPathChange(PROGRAM[k], !!written, d);
      return true;
    },
  });
};

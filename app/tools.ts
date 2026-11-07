// golem and shem, found by the setting, the bundled copy, ~/.local/bin, Homebrew, then PATH (docs/adr/0008).
import { api, type Out, type Tool } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { esc } from "./esc.ts";
import { item } from "./ui/settings.ts";

const binOf = (ctx: Ctx, name: Tool) => (name === "golem" ? ctx.config.golemPath : ctx.config.shemPath) || undefined;

export const golem = (ctx: Ctx, cwd: string, args: string[]): Promise<Out> => api.tool("golem", binOf(ctx, "golem"), cwd, args);
export const shem = (ctx: Ctx, cwd: string, args: string[]): Promise<Out> => api.tool("shem", binOf(ctx, "shem"), cwd, args);
export const git = (ctx: Ctx, cwd: string, args: string[]): Promise<Out> => api.git(ctx.config.gitPath || undefined, cwd, args);

const info = async (ctx: Ctx, name: Tool) => {
  try {
    const i = await api.toolInfo(name, binOf(ctx, name));
    const differs = i.bundled && !i.version.includes(i.bundled.replace(/^v/, ""));
    return `${esc(i.version)}（${esc(i.path)}）${differs ? `<br>同梱の版は ${esc(i.bundled)}` : ""}`;
  } catch (e) {
    return `<span class="ng">${esc(String(e))}</span>`;
  }
};

export const mountTools = (ctx: Ctx) => {
  ctx.settings.push({
    id: "tools",
    label: "Golem と shem",
    group: "Golem",
    render: async (c) =>
      item("Golem のバイナリ", `${await info(c, "golem")}<br>空なら、同梱のもの、~/.local/bin、Homebrew、PATH の順に探す`, `<input class="field" data-path="golemPath" value="${esc(c.config.golemPath)}" placeholder="同梱"><span class="btn" data-pick="golemPath">選ぶ</span>`) +
      item("shem のバイナリ", `${await info(c, "shem")}<br>ページのプレビューで PDF を PNG にする`, `<input class="field" data-path="shemPath" value="${esc(c.config.shemPath)}" placeholder="同梱"><span class="btn" data-pick="shemPath">選ぶ</span>`) +
      item("git のバイナリ", "空なら、/usr/bin、Homebrew、PATH の順に探す", `<input class="field" data-path="gitPath" value="${esc(c.config.gitPath)}" placeholder="自動"><span class="btn" data-pick="gitPath">選ぶ</span>`),
    onClick: async (el, c) => {
      const k = el.closest<HTMLElement>("[data-pick]")?.dataset.pick as "golemPath" | "shemPath" | "gitPath" | undefined;
      if (!k) return false;
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = (await open({ multiple: false, directory: false })) as string | null;
      if (!p) return false;
      c.config[k] = p;
      await c.saveConfig();
      return true;
    },
    onChange: async (el, c) => {
      const k = el.dataset.path as "golemPath" | "shemPath" | "gitPath" | undefined;
      if (!k) return false;
      c.config[k] = el.value.trim();
      await c.saveConfig();
      return true;
    },
  });
};

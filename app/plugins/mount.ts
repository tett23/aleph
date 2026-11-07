// Aleph's plugins in the app (docs/adr/0017): loaded from the plugins folder at
// start, their commands in the toolbar's menu, their text in the status bar,
// called after saves; turned on and off in the settings.
import { api } from "../api.ts";
import type { Command, Ctx } from "../ctx.ts";
import { esc } from "../esc.ts";
import { basename } from "../path.ts";
import { allDocs, focused, type State } from "../store.ts";
import { item, toggle } from "../ui/settings.ts";
import { API_VERSION, createHost, type Current, type LoadResult } from "./host.ts";

const importer = async (source: string) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
};

const current = (s: State): Current => {
  const d = focused(s);
  return d ? { path: d.path, kind: d.kind, text: d.text, project: d.project } : null;
};

export const mountPlugins = async (ctx: Ctx) => {
  const host = createHost(ctx.toast);
  let dir = "";
  let results: LoadResult[] = [];
  let mine: Command[] = [];

  const load = async () => {
    dir = await api.pluginsDir().catch(() => "");
    const files = dir ? (await api.listDir(dir)).filter((p) => p.endsWith(".js")).sort() : [];
    const sources = await Promise.all(files.map(async (p) => ({ name: basename(p), source: await api.readText(p).catch(() => "") })));
    results = await host.load(sources, ctx.config.disabledPlugins, importer);
    // the menu's items follow what is loaded now
    for (const c of mine) ctx.commands.splice(ctx.commands.indexOf(c), 1);
    // ids plugin.<name>.<n> (docs/adr/0023); the name is the file's without .js, other characters as "-"
    const counts = new Map<string, number>();
    mine = host.commands().map((c) => {
      const name = c.plugin.replace(/\.js$/, "").replace(/[^\w-]/g, "-") || "x";
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      return { id: `plugin.${name}.${n}`, menu: true, label: `${c.label}（${name}）`, icon: "puzzle", when: () => true, run: (cc) => c.run(current(cc.store.get())) };
    });
    ctx.commands.push(...mine);
    ctx.refresh(["status"]);
  };

  ctx.status.push((s) => host.status(current(s)).map((t) => `<span class="plg">${esc(t)}</span>`).join(""));
  ctx.store.subscribe((s, prev) => {
    for (const d of allDocs(s)) {
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (before && before.saved !== d.saved) host.saved({ path: d.path, kind: d.kind, text: d.saved, project: d.project });
    }
  });

  ctx.settings.push({
    id: "plugins",
    label: "Aleph のプラグイン",
    group: "オプション",
    render: () =>
      item("プラグインのフォルダ", `${esc(dir)}<br>ここに置いた .js（ES モジュール、activate(aleph) を書き出す）を起動時に読む。API の版は ${API_VERSION}`, `<span class="btn" data-plg="reload">読みなおす</span>`) +
      `<div class="warn-note">プラグインは Aleph と同じ権限で動き、ファイルを読み書きできます。自分で書いたか、読んで信頼したものだけを置いてください。</div>` +
      (results.length
        ? results
            .map((r) =>
              item(
                esc(r.name),
                r.state === "failed" ? `<span class="ng">読めません：${esc(r.error ?? "")}</span>` : r.state === "disabled" ? "無効" : "読み込み済み",
                toggle(`plugin:${esc(r.name)}`, !ctx.config.disabledPlugins.includes(r.name)),
              ),
            )
            .join("")
        : item("プラグインはありません", "フォルダに .js を置いて「読みなおす」を押す", "")),
    onClick: async (el, c) => {
      const t = el.closest<HTMLElement>("[data-plg],[data-toggle]");
      if (!t) return false;
      if (t.dataset.toggle?.startsWith("plugin:")) {
        const name = t.dataset.toggle.slice("plugin:".length);
        c.config.disabledPlugins = c.config.disabledPlugins.includes(name) ? c.config.disabledPlugins.filter((n) => n !== name) : [...c.config.disabledPlugins, name];
        await c.saveConfig();
      } else if (t.dataset.plg !== "reload") return false;
      await load();
      return true;
    },
  });

  await load();
};

// Aleph's plugins in the app (docs/adr/0017): loaded from the plugins folder at
// start, their commands in the toolbar's menu, their text in the status bar,
// called after saves; turned on and off in the settings.
import { listen } from "@tauri-apps/api/event";
import { addCommands } from "../commands.ts";
import { api } from "../api.ts";
import type { Command, Ctx } from "../ctx.ts";
import { esc } from "../esc.ts";
import { basename } from "../path.ts";
import { allDocs, focused, type State, shownDoc } from "../store.ts";
import { item, toggle } from "../ui/settings.ts";
import { createApprovalPrompts, showApprovalDialog } from "./approval-dialog.ts";
import { API_VERSION, createHost, type Current, type LoadResult } from "./host.ts";
import { spawnPlugin } from "./sandbox.ts";

const current = (s: State, d = focused(s)): Current => (d ? { path: d.path, kind: d.kind, text: d.text, project: d.project } : null);

export const mountPlugins = async (ctx: Ctx) => {
  const fail = (error: unknown) => void ctx.notify({ message: String(error), level: "error", sticky: true });
  const requesting = new Map<string, Promise<string | null>>();
  const host = createHost(ctx.toast, fail, spawnPlugin, {
    authorize: async (channel, path) => {
      const key = JSON.stringify([channel, path]);
      let request = requesting.get(key);
      if (!request) {
        request = api.pluginSheetAccess(channel, path).finally(() => requesting.delete(key));
        requesting.set(key, request);
      }
      const grant = await request;
      return grant !== null && await api.pluginSheetUse(channel, path, grant);
    },
    close: api.pluginSessionClose,
  }, () => ctx.refresh(["status"]));
  const syncPrompt = createApprovalPrompts(api.pluginApprovalPrompt, api.pluginApprovalReply,
    (prompt, answer) => showApprovalDialog(prompt, answer, fail));
  let dir = "";
  let results: LoadResult[] = [];
  let mine: Command[] = [];
  let loadGeneration = 0;
  let approvalList: HTMLElement | null = null;
  let listGeneration = 0;

  const refreshApprovals = async () => {
    const list = approvalList;
    if (!list?.isConnected) return;
    const reading = ++listGeneration;
    const decisions = await api.pluginApprovalList();
    if (reading !== listGeneration || !list.isConnected) return;
    list.innerHTML = decisions.length
      ? decisions.map((decision) => item(
        decision.name,
        `${decision.allowed ? "許可" : "拒否"} · ${esc(decision.action)}<br>${esc(decision.path)}`,
        `<button type="button" class="btn" data-plg-forget="${esc(decision.id)}" data-plg-name="${esc(decision.name)}">取り消す</button>`,
      )).join("")
      : item("権限の承認", "この起動中に許可または拒否した権限はありません。", "");
  };

  const monitoring = listen("plugin-approval-changed", () => {
    void syncPrompt().catch(fail);
    void refreshApprovals().catch(fail);
  }).then(syncPrompt);

  const load = async () => {
    const generation = ++loadGeneration;
    await monitoring;
    const folder = await api.pluginsDir().catch(() => "");
    const files = folder ? (await api.listDir(folder)).filter((p) => p.endsWith(".js")).sort() : [];
    if (generation !== loadGeneration) return;
    const sources = files.map(basename).map((name) => ({ name, open: () => api.pluginSessionOpen(name) }));
    const loaded = await host.load(sources, ctx.config.disabledPlugins);
    if (generation !== loadGeneration) return;
    dir = folder;
    results = loaded;
    // the menu's items follow what is loaded now
    for (const c of mine) ctx.commands.splice(ctx.commands.indexOf(c), 1);
    // ids plugin.<name>.<n> (docs/adr/0023); the name is the file's without .js, other characters as "-"
    const counts = new Map<string, number>();
    mine = host.commands().map((c) => {
      const name = c.plugin.replace(/\.js$/, "").replace(/[^\w-]/g, "-") || "x";
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      return {
        id: `plugin.${name}.${n}`, menu: true, label: `${c.label}（${name}）`, icon: "puzzle", when: () => true,
        run: (cc) => {
          const target = current(cc.store.get());
          return c.run(target, () => focused(cc.store.get())?.path === target?.path);
        },
      };
    });
    addCommands(ctx.commands, ...mine);
    ctx.refresh(["status"]);
  };

  ctx.status.push((s) => host.status(current(s, shownDoc(s))).map((t) => `<span class="plg">${esc(t)}</span>`).join(""));
  ctx.store.subscribe((s, prev) => {
    const shown = shownDoc(s);
    for (const d of allDocs(s)) {
      const before = allDocs(prev).find((x) => x.path === d.path);
      if (before && before.saved !== d.saved && shown?.path === d.path) {
        host.saved({ path: d.path, kind: d.kind, text: d.saved, project: d.project }, () => {
          const latest = shownDoc(ctx.store.get());
          return latest?.path === d.path && latest.saved === d.saved;
        });
      }
    }
  });

  ctx.settings.push({
    id: "plugins",
    label: "Aleph のプラグイン",
    group: "オプション",
    // added and removed through native dialogs Rust opens (docs/adr/0042)
    render: () =>
      item(
        "プラグインのフォルダ",
        `${esc(dir)}<br>.js（ES モジュール、activate(aleph) を書き出す）を「追加…」で選んで入れる。フォルダに置いたものも読みなおすと読む。API の版は ${API_VERSION}`,
        `<span class="btn" data-plg="install">追加…</span><span class="btn" data-plg="open">フォルダを開く</span><span class="btn" data-plg="reload">読みなおす</span>`,
      ) +
      `<div class="warn-note">Aleph のプラグインは実験的な機能で、将来のリリースで廃止する場合があります。</div>` +
      `<div class="warn-note">プラグインは隔離した画面で動き、登録したコマンド、ステータス、保存通知だけを使います。シートの情報を渡す前に権限を確認します。</div>` +
      (results.length
        ? results
            .map((r) =>
              item(
                esc(r.name),
                r.state === "failed" ? `<span class="ng">読めません：${esc(r.error ?? "")}</span>` : r.state === "disabled" ? "無効" : "読み込み済み",
                toggle(`plugin:${esc(r.name)}`, !ctx.config.disabledPlugins.includes(r.name)) + `<span class="btn" data-plg-rm="${esc(r.name)}">外す</span>`,
              ),
            )
            .join("")
        : item("プラグインはありません", "「追加…」で .js を選ぶ", "")) +
      `<div data-plg-approvals></div>`,
    mount: (el) => {
      approvalList = el.querySelector("[data-plg-approvals]");
      void refreshApprovals().catch(fail);
    },
    onClick: async (el, c) => {
      const t = el.closest<HTMLElement>("[data-plg],[data-plg-rm],[data-plg-forget],[data-toggle]");
      if (!t) return false;
      if (t.dataset.plgForget !== undefined) {
        try {
          await api.pluginApprovalForget(t.dataset.plgForget);
          host.clearStatus(t.dataset.plgName);
          await refreshApprovals();
        } catch (error) {
          fail(error);
        }
        return false;
      } else if (t.dataset.toggle?.startsWith("plugin:")) {
        const name = t.dataset.toggle.slice("plugin:".length);
        c.config.disabledPlugins = c.config.disabledPlugins.includes(name) ? c.config.disabledPlugins.filter((n) => n !== name) : [...c.config.disabledPlugins, name];
        await c.saveConfig();
      } else if (t.dataset.plgRm !== undefined) {
        const removed = await api.removePlugin(t.dataset.plgRm).catch((e) => void c.notify({ message: String(e), level: "error", sticky: true }));
        if (!removed) return false;
        c.toast(`${t.dataset.plgRm} を外しました`);
      } else if (t.dataset.plg === "install") {
        const name = await api.installPlugin().catch((e) => void c.notify({ message: String(e), level: "error", sticky: true }));
        if (!name) return false;
        c.toast(`${name} を入れました`);
      } else if (t.dataset.plg === "open") {
        await api.openPluginsFolder().catch((e) => c.notify({ message: String(e), level: "error", sticky: true }));
        return false;
      } else if (t.dataset.plg !== "reload") return false;
      await load().catch(fail);
      return true;
    },
  });

  await load().catch(fail);
};

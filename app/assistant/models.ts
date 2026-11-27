// The 「アシスタント」 section of the settings: the models of the list, downloaded
// or deleted, and the one the local connector uses (docs/adr/0081, モデルの管理),
// then the rows of Claude Code and Codex, whose approvals can be revoked
// (docs/adr/0089). Rust keeps the list, the files, the choice and the approvals
// (docs/adr/0042); this side only shows them and asks.
import { api, type ConnectorId, type ConnectorInfo } from "../api.ts";
import type { Ctx } from "../ctx.ts";
import { assistantContextLimitOf, assistantContextLimits } from "../config.ts";
import { esc } from "../esc.ts";
import { item } from "../ui/item.ts";

/** A model of the list as Rust reports it. */
export type ModelInfo = {
  id: string;
  name: string;
  size: number;
  license: string;
  /** The default model, bundled with the app. */
  default: boolean;
  /** Bundled or downloaded. */
  installed: boolean;
  /** The model the local connector uses now (I10). */
  inUse: boolean;
  downloading: boolean;
};

export const sizeLabel = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

const state = (m: ModelInfo) =>
  m.default ? (m.installed ? "既定のモデル。同梱" : "既定のモデル。同梱されていない") : m.downloading ? "ダウンロード中" : m.installed ? "ダウンロード済み" : "入っていない";

// the default is bundled and cannot be deleted (I10); one download at a time
const control = (m: ModelInfo, busy: boolean) =>
  m.default || m.downloading
    ? ""
    : m.installed
      ? `<span class="btn" data-delete="${esc(m.id)}">消す</span>`
      : busy
        ? ""
        : `<span class="btn" data-download="${esc(m.id)}">ダウンロード</span>`;

/** A connector row's state and whether it offers 「承認を取り消す」 (docs/adr/0089, I5). */
export const connectorRow = (c: ConnectorInfo): { state: string; revocable: boolean } => ({
  state: c.found ? (c.approved ? "承認しています" : "承認していません") : c.approved ? "見つかりません (承認しています)" : "見つかりません",
  // also when not found, so that a CLI removed and installed again is not used without the dialog
  revocable: c.approved,
});

/** The row of Claude Code or Codex: its name, its state and the button. */
export const connectorRowHtml = (c: ConnectorInfo) => {
  const r = connectorRow(c);
  return item(c.name, esc(r.state), r.revocable ? `<span class="btn" data-revoke="${esc(c.id)}">承認を取り消す</span>` : "");
};

/** The section's body: the model to use, chosen from the installed ones, each model of the list, then the rows of Claude Code and Codex. */
export const modelsHtml = (models: readonly ModelInfo[], error = "", connectors: readonly ConnectorInfo[] = [], context: number | null = null, activeContext: number | null = null) => {
  const busy = models.some((m) => m.downloading);
  const options = models
    .filter((m) => m.installed)
    .map((m) => `<option value="${esc(m.id)}"${m.inUse ? " selected" : ""}>${esc(m.name)}</option>`)
    .join("");
  return (
    (error ? `<p class="ng">${esc(error)}</p>` : "") +
    item("使うモデル", "ローカルのコネクタが使うモデル。選んだモデルが無いときは、既定のモデルを使う", `<select class="field" data-model>${options}</select>`) +
    item("ローカルのコンテキスト長の上限", `入力と答えが収まる長さを、モデルと設定の上限の範囲で選ぶ${activeContext === null ? "" : `。起動中は ${activeContext.toLocaleString("ja-JP")} トークン`}`, `<select class="field" data-assistant-context><option value="">自動</option>${assistantContextLimits.map((limit) => `<option value="${limit}"${context === limit ? " selected" : ""}>${limit.toLocaleString("ja-JP")}</option>`).join("")}</select>`) +
    models.map((m) => item(m.name, `${esc(sizeLabel(m.size))}・${esc(m.license)}・${esc(state(m))}`, control(m, busy))).join("") +
    connectors
      .filter((c) => c.id !== "local")
      .map(connectorRowHtml)
      .join("")
  );
};

/** What to do after a revoke: set by the assistant's tab, which reads its connectors again. */
export const connectorsRevoked = { notify: () => {} };

// the last failure, shown at the top of the section until the next action
let lastError = "";
// the connectors as last read; reading them may run a login shell per connector,
// so they are read when the section is opened, not after its own actions
let shown: ConnectorInfo[] = [];
let reuse = false;

const readConnectors = async () => {
  if (!reuse) shown = await api.assistantConnectors().catch(() => []);
  reuse = false;
  return shown;
};

/** Revokes the approval; on success only the row is drawn again, with `approved` false (docs/adr/0089). */
const revoke = async (button: HTMLElement, id: ConnectorId) => {
  lastError = "";
  try {
    await api.assistantRevoke(id);
  } catch (e) {
    lastError = String(e);
    reuse = true;
    return true;
  }
  shown = shown.map((c) => (c.id === id ? { ...c, approved: false } : c));
  const c = shown.find((x) => x.id === id);
  const row = button.closest<HTMLElement>(".item");
  // the previous failure at the top of the section goes, as after the other actions
  row?.parentElement?.querySelector(":scope > p.ng")?.remove();
  if (c && row) row.outerHTML = connectorRowHtml(c);
  connectorsRevoked.notify();
  return false;
};

export const mountAssistantSettings = (ctx: Ctx) => {
  ctx.settings.push({
    id: "assistant",
    label: "アシスタント",
    group: "オプション",
    render: async () => {
      try {
        const [models, connectorList, activeContext] = await Promise.all([api.assistantModels(), readConnectors(), api.assistantLocalContext().catch(() => null)]);
        return modelsHtml(models, lastError, connectorList, ctx.config.assistantContextLimit, activeContext);
      } catch (e) {
        return `<p class="ng">${esc(String(e))}</p>`;
      }
    },
    onClick: async (el) => {
      const download = el.closest<HTMLElement>("[data-download]")?.dataset.download;
      const del = el.closest<HTMLElement>("[data-delete]")?.dataset.delete;
      const revoking = el.closest<HTMLElement>("[data-revoke]");
      if (revoking) return revoke(revoking, revoking.dataset.revoke as ConnectorId);
      if (!download && !del) return false;
      lastError = "";
      reuse = true;
      try {
        if (download) {
          el.textContent = "ダウンロード中";
          await api.assistantDownloadModel(download);
        } else if (del) await api.assistantDeleteModel(del);
      } catch (e) {
        lastError = String(e);
      }
      return true;
    },
    onChange: async (el) => {
      if (el.matches("[data-assistant-context]")) {
        ctx.config.assistantContextLimit = assistantContextLimitOf(Number(el.value));
        await ctx.saveConfig();
        return false;
      }
      if (!el.matches("[data-model]")) return false;
      lastError = "";
      reuse = true;
      try {
        await api.assistantChooseModel(el.value);
      } catch (e) {
        lastError = String(e);
      }
      return true;
    },
  });
};

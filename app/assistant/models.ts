// The 「アシスタント」 section of the settings: the models of the list, downloaded
// or deleted, and the one the local connector uses (docs/adr/0081, モデルの管理).
// Rust keeps the list, the files and the choice (docs/adr/0042); this side only
// shows them and asks.
import { api } from "../api.ts";
import type { Ctx } from "../ctx.ts";
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

/** The section's body: the model to use, chosen from the installed ones, then each model of the list. */
export const modelsHtml = (models: readonly ModelInfo[], error = "") => {
  const busy = models.some((m) => m.downloading);
  const options = models
    .filter((m) => m.installed)
    .map((m) => `<option value="${esc(m.id)}"${m.inUse ? " selected" : ""}>${esc(m.name)}</option>`)
    .join("");
  return (
    (error ? `<p class="ng">${esc(error)}</p>` : "") +
    item("使うモデル", "ローカルのコネクタが使うモデル。選んだモデルが無いときは、既定のモデルを使う", `<select class="field" data-model>${options}</select>`) +
    models.map((m) => item(m.name, `${esc(sizeLabel(m.size))}・${esc(m.license)}・${esc(state(m))}`, control(m, busy))).join("")
  );
};

// the last failure, shown at the top of the section until the next action
let lastError = "";

export const mountAssistantSettings = (ctx: Ctx) => {
  ctx.settings.push({
    id: "assistant",
    label: "アシスタント",
    group: "オプション",
    render: async () => {
      try {
        return modelsHtml(await api.assistantModels(), lastError);
      } catch (e) {
        return `<p class="ng">${esc(String(e))}</p>`;
      }
    },
    onClick: async (el) => {
      const download = el.closest<HTMLElement>("[data-download]")?.dataset.download;
      const del = el.closest<HTMLElement>("[data-delete]")?.dataset.delete;
      if (!download && !del) return false;
      lastError = "";
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
      if (!el.matches("[data-model]")) return false;
      lastError = "";
      try {
        await api.assistantChooseModel(el.value);
      } catch (e) {
        lastError = String(e);
      }
      return true;
    },
  });
};

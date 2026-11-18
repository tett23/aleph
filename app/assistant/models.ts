// The 「アシスタント」 section of the settings: the models of the list, downloaded
// or deleted, and the one the local connector uses (docs/adr/0081, モデルの管理).
// Rust keeps the list, the files and the choice (docs/adr/0042); this side only
// shows them and asks.

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

export const sizeLabel = (_bytes: number) => "";

export const modelsHtml = (_models: readonly ModelInfo[], _error = "") => "";

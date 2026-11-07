// The screen's state kept between launches, in config.json's `ui` (docs/adr/0004:
// the app's settings live only there). The main window writes it; the preview and
// plot windows send their changes to the main window.

export type UiState = {
  get: <T>(key: string, d: T) => T;
  set: (key: string, v: unknown) => void;
  merge: (values: Record<string, unknown>) => void;
};

export const createUiState = (initial: Record<string, unknown>, save: (ui: Record<string, unknown>) => void): UiState => {
  let ui = { ...initial };
  return {
    get: <T>(key: string, d: T): T => (typeof ui[key] === typeof d && ui[key] !== null ? (ui[key] as T) : d),
    set: (key, v) => {
      ui = { ...ui, [key]: v };
      save(ui);
    },
    merge: (values) => {
      ui = { ...ui, ...values };
      save(ui);
    },
  };
};

/** In a preview or plot window: the kept state as read at start; changes go to the main window. */
export const windowUiState = (initial: Record<string, unknown>, send: (part: Record<string, unknown>) => void): UiState => {
  const base = createUiState(initial, () => {});
  return {
    get: base.get,
    set: (key, v) => (base.set(key, v), send({ [key]: v })),
    merge: (values) => (base.merge(values), send(values)),
  };
};

/** The state of this window; set once at start. */
let current: UiState = createUiState({}, () => {});
export const setUiState = (u: UiState) => void (current = u);
export const uiState = () => current;

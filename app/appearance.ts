// The app's light or dark appearance, one for every window (docs/adr/0099).
// The pure part: choosing and saving, following the OS, and what other
// windows send. Only "auto" follows the OS.
import { isDark, type Config, type Theme } from "./config.ts";

/** The event that tells every window the theme just saved. */
export const THEME_EVENT = "aleph:theme";

const CHOICES: readonly (readonly [Theme, string])[] = [["auto", "OS に合わせる"], ["light", "ライト"], ["dark", "ダーク"]];

/** A stored or received theme; anything else is "auto". */
export const themeOf = (raw: unknown): Theme => (raw === "light" || raw === "dark" || raw === "auto" ? raw : "auto");

/** The three choices of 「一般 → 外観」, the current one selected. */
export const themeChoicesHtml = (current: Theme) =>
  CHOICES.map(([t, label]) => `<span class="btn${t === current ? " pri" : ""}" data-theme="${t}" aria-pressed="${t === current}">${label}</span>`).join("");

export type Appearance = {
  theme: () => Theme;
  dark: () => boolean;
  /** The OS's appearance changed. */
  system: (dark: boolean) => void;
  /** Another window saved a theme (the payload of THEME_EVENT). */
  receive: (payload: unknown) => void;
};

/** A window's appearance: `apply` is called now and whenever whether it is dark changes. */
export const createAppearance = (theme: Theme, systemDark: boolean, apply: (dark: boolean) => void): Appearance => {
  let current = themeOf(theme);
  let system = systemDark;
  let shown = isDark(current, system);
  apply(shown);
  const show = () => {
    const dark = isDark(current, system);
    if (dark !== shown) apply((shown = dark));
  };
  return {
    theme: () => current,
    dark: () => shown,
    system: (dark) => {
      system = dark;
      show();
    },
    receive: (payload) => {
      current = themeOf(payload && typeof payload === "object" ? (payload as { theme?: unknown }).theme : undefined);
      show();
    },
  };
};

/**
 * Saves `next` as the config's theme. Only after the save succeeds are the
 * windows told; when it fails the config keeps the theme saved before.
 */
export const chooseTheme = async <C extends Pick<Config, "theme">>(
  config: C,
  next: Theme,
  save: (config: C) => Promise<void>,
  announce: (theme: Theme) => void | Promise<void>,
): Promise<{ ok: true } | { ok: false; error: unknown }> => {
  const before = config.theme;
  config.theme = next;
  try {
    await save(config);
  } catch (error) {
    config.theme = before;
    return { ok: false, error };
  }
  await announce(next);
  return { ok: true };
};

/** What a drawing coloured by the theme is drawn from, so that a change of theme draws it again. */
export const drawingRevision = (text: string, dark: boolean) => JSON.stringify([text, dark]);

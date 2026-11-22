// The theme and the sizes the settings give, as CSS variables on the body.
import { listen } from "@tauri-apps/api/event";
import { createAppearance, THEME_EVENT } from "./appearance.ts";
import type { Config } from "./config.ts";

/** The sizes of the text; the light or dark colours are the appearance's (mountAppearance). */
export const applyTheme = (c: Config) => {
  const st = document.body.style;
  st.setProperty("--lh", String(c.lineHeight));
  st.setProperty("--fs-body", `${c.fontSize}px`);
  st.setProperty("--fs-code", `${c.codeFontSize}px`);
};

/**
 * The window's light or dark colours (docs/adr/0099): the saved theme, the
 * OS's appearance while it is "auto", and the theme another window saved.
 * `changed` runs after the colours change, to draw again what they colour.
 */
export const mountAppearance = (config: Config, changed: () => void = () => {}) => {
  const media = matchMedia("(prefers-color-scheme: dark)");
  let started = false;
  const look = createAppearance(config.theme, media.matches, (dark) => {
    document.body.classList.toggle("theme-dark", dark);
    if (started) changed();
  });
  started = true;
  media.addEventListener("change", () => look.system(media.matches));
  void listen(THEME_EVENT, (e) => {
    look.receive(e.payload);
    config.theme = look.theme();
  });
  return look;
};

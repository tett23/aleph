// The theme and the sizes the settings give, as CSS variables on the body.
import { isDark, type Config } from "./config.ts";

export const applyTheme = (c: Config) => {
  const dark = isDark(c.theme, matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("theme-dark", dark);
  const st = document.body.style;
  st.setProperty("--lh", String(c.lineHeight));
  st.setProperty("--fs-body", `${c.fontSize}px`);
  st.setProperty("--fs-code", `${c.codeFontSize}px`);
};

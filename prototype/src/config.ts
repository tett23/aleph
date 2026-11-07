import { api } from "./api";

export type Config = {
  workspaces: string[];
  golemPath: string;
  shemPath: string;
  libraryDir: string; // shared fonts/, plugins/ (.wasm) and functions/ (.emet)
  charsOverride: number | null;
  manuscript: { cols: number; rows: number };
  theme: "auto" | "light" | "dark";
  rebuildOnSave: boolean;
  showInvisibles: boolean;
  formatOnSave: boolean; // ⌘S formats with the LSP before saving
  lineHeight: number;
  fontSize: number; // body, px
  codeFontSize: number; // px
  autosaveSeconds: number;
  autoCommit: boolean;
  lastAutoCommit: Record<string, string>; // workspace -> YYYY-MM-DD
  dpi: number;
  plugins: string[];
};

const defaults: Config = {
  workspaces: [],
  golemPath: "",
  shemPath: "",
  libraryDir: "",
  charsOverride: null,
  manuscript: { cols: 20, rows: 20 },
  theme: "auto",
  rebuildOnSave: true,
  showInvisibles: false,
  formatOnSave: true,
  lineHeight: 1.75,
  fontSize: 16,
  codeFontSize: 13,
  autosaveSeconds: 10,
  autoCommit: true,
  lastAutoCommit: {},
  dpi: 0, // 0: automatic, from the pane, the screen and the zoom
  plugins: [],
};

export const config: Config = { ...defaults };

export const loadConfig = async () => {
  const raw = JSON.parse(await api.configLoad()) as Partial<Config>;
  Object.assign(config, defaults, raw);
  if (raw.dpi === 110) config.dpi = 0; // the first prototype's fixed default
  applyTheme();
};

export const saveConfig = async () => {
  await api.configSave(JSON.stringify(config, null, 2));
  applyTheme();
};

export const bin = (name: "golem" | "shem") => (name === "golem" ? config.golemPath : config.shemPath) || undefined;

const clamp = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export const applyTheme = () => {
  config.fontSize = clamp(config.fontSize, 10, 32, 16);
  config.codeFontSize = clamp(config.codeFontSize, 9, 28, 13);
  config.lineHeight = clamp(config.lineHeight, 1, 3, 1.75);
  const dark =
    config.theme === "dark" || (config.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("theme-dark", dark);
  document.body.style.setProperty("--lh", String(config.lineHeight || 1.75));
  document.body.style.setProperty("--fs-body", `${config.fontSize || 16}px`);
  document.body.style.setProperty("--fs-code", `${config.codeFontSize || 13}px`);
};

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

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
  lineHeight: number;
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
  lineHeight: 1.75,
  autosaveSeconds: 10,
  autoCommit: true,
  lastAutoCommit: {},
  dpi: 110,
  plugins: [],
};

export const config: Config = { ...defaults };

export const loadConfig = async () => {
  const raw = JSON.parse(await api.configLoad()) as Partial<Config>;
  Object.assign(config, defaults, raw);
  applyTheme();
};

export const saveConfig = async () => {
  await api.configSave(JSON.stringify(config, null, 2));
  applyTheme();
};

export const bin = (name: "golem" | "shem") => (name === "golem" ? config.golemPath : config.shemPath) || undefined;

export const applyTheme = () => {
  const dark =
    config.theme === "dark" || (config.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.classList.toggle("theme-dark", dark);
  document.body.style.setProperty("--lh", String(config.lineHeight || 1.75));
};

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

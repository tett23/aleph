// The app's settings, kept in config.json in the app's config directory (docs/adr/0004).
// The pure part (defaults and clamping) is tested with node --test.

export type Theme = "auto" | "light" | "dark";

export type Config = {
  workspaces: string[];
  golemPath: string;
  shemPath: string;
  gitPath: string;
  libraryDir: string;
  charsOverride: number | null;
  manuscript: { cols: number; rows: number };
  theme: Theme;
  fontSize: number;
  codeFontSize: number;
  lineHeight: number;
  showInvisibles: boolean;
  formatOnSave: boolean;
  autosaveSeconds: number;
  rebuildOnSave: boolean;
  dpi: number; // 0: automatic
  autoCommit: boolean;
  lastAutoCommit: Record<string, string>;
  disabledPlugins: string[];
  /** The screen's state kept between launches (panels, preview, zooms), written by the main window. */
  ui: Record<string, unknown>;
};

export const defaults = (): Config => ({
  workspaces: [],
  golemPath: "",
  shemPath: "",
  gitPath: "",
  libraryDir: "",
  charsOverride: null,
  manuscript: { cols: 20, rows: 20 },
  theme: "auto",
  fontSize: 16,
  codeFontSize: 13,
  lineHeight: 1.75,
  showInvisibles: false,
  formatOnSave: true,
  autosaveSeconds: 10,
  rebuildOnSave: true,
  dpi: 0,
  autoCommit: true,
  lastAutoCommit: {},
  disabledPlugins: [],
  ui: {},
});

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** A config read from JSON, with unknown keys dropped, wrong types replaced and numbers clamped. */
export const normalize = (raw: unknown): Config => {
  const d = defaults();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ms = (r.manuscript && typeof r.manuscript === "object" ? r.manuscript : {}) as Record<string, unknown>;
  return {
    workspaces: Array.isArray(r.workspaces) ? [...new Set(r.workspaces.filter((w): w is string => typeof w === "string" && w !== ""))] : d.workspaces,
    golemPath: str(r.golemPath, d.golemPath),
    shemPath: str(r.shemPath, d.shemPath),
    gitPath: str(r.gitPath, d.gitPath),
    libraryDir: str(r.libraryDir, d.libraryDir),
    charsOverride: r.charsOverride === null || r.charsOverride === undefined ? null : clamp(r.charsOverride, 5, 200, 40),
    manuscript: { cols: clamp(ms.cols, 5, 100, 20), rows: clamp(ms.rows, 5, 100, 20) },
    theme: r.theme === "light" || r.theme === "dark" || r.theme === "auto" ? r.theme : d.theme,
    fontSize: clamp(r.fontSize, 10, 32, d.fontSize),
    codeFontSize: clamp(r.codeFontSize, 9, 28, d.codeFontSize),
    lineHeight: clamp(r.lineHeight, 1, 3, d.lineHeight),
    showInvisibles: bool(r.showInvisibles, d.showInvisibles),
    formatOnSave: bool(r.formatOnSave, d.formatOnSave),
    autosaveSeconds: clamp(r.autosaveSeconds, 2, 600, d.autosaveSeconds),
    rebuildOnSave: bool(r.rebuildOnSave, d.rebuildOnSave),
    dpi: r.dpi === 0 ? 0 : clamp(r.dpi, 36, 1200, d.dpi),
    autoCommit: bool(r.autoCommit, d.autoCommit),
    lastAutoCommit:
      r.lastAutoCommit && typeof r.lastAutoCommit === "object"
        ? Object.fromEntries(Object.entries(r.lastAutoCommit).filter((e): e is [string, string] => typeof e[1] === "string"))
        : d.lastAutoCommit,
    disabledPlugins: Array.isArray(r.disabledPlugins) ? r.disabledPlugins.filter((p): p is string => typeof p === "string") : d.disabledPlugins,
    ui: r.ui && typeof r.ui === "object" && !Array.isArray(r.ui) ? (r.ui as Record<string, unknown>) : d.ui,
  };
};

/** Whether the dark colours apply. */
export const isDark = (theme: Theme, systemDark: boolean) => theme === "dark" || (theme === "auto" && systemDark);

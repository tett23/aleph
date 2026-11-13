// The app's settings, kept in config.json in the app's config directory (docs/adr/0004).
// The pure part (defaults and clamping) is tested with node --test.
import { clampTimeout, DEFAULT_LEADER, DEFAULT_TIMEOUT, leaderOf, isBinding, type Binding } from "./keymap.ts";
import { defaultProofread, readProofread, type ProofreadConfig } from "./proofread.ts";
import type { ProjectOrder } from "./project-order.ts";

export type Theme = "auto" | "light" | "dark";

export type Config = {
  workspaces: string[];
  projectOrder: ProjectOrder;
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
  showHiddenFiles: boolean;
  showGitignoredFiles: boolean;
  formatOnSave: boolean;
  autosaveSeconds: number;
  rebuildOnSave: boolean;
  dpi: number; // 0: automatic
  autoCommit: boolean;
  lastAutoCommit: Record<string, string>;
  disabledPlugins: string[];
  /** The user's key bindings by command id, only those that differ from the defaults (docs/adr/0034). */
  keyBindings: Record<string, Binding[]>;
  leaderKey: string;
  /** How long to wait for the next stroke of a sequence, in milliseconds. */
  keySequenceTimeout: number;
  /** The writing checks (docs/adr/0030). */
  proofread: ProofreadConfig;
  /** How the Markdown preview draws a paragraph's newlines (docs/adr/0035). */
  markdownBreaks: "newline" | "blank-line";
  /** The screen's state kept between launches (panels, preview, zooms), written by the main window. */
  ui: Record<string, unknown>;
};

export const defaults = (): Config => ({
  workspaces: [],
  projectOrder: {},
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
  showHiddenFiles: false,
  showGitignoredFiles: true,
  formatOnSave: true,
  autosaveSeconds: 10,
  rebuildOnSave: true,
  dpi: 0,
  autoCommit: true,
  lastAutoCommit: {},
  disabledPlugins: [],
  keyBindings: {},
  leaderKey: DEFAULT_LEADER,
  keySequenceTimeout: DEFAULT_TIMEOUT,
  proofread: defaultProofread(),
  markdownBreaks: "newline",
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
    projectOrder: r.projectOrder && typeof r.projectOrder === "object" && !Array.isArray(r.projectOrder)
      ? Object.fromEntries(Object.entries(r.projectOrder).flatMap(([workspace, parents]) =>
          parents && typeof parents === "object" && !Array.isArray(parents)
            ? [[workspace, Object.fromEntries(Object.entries(parents).flatMap(([parent, paths]) =>
                Array.isArray(paths) ? [[parent, [...new Set(paths.filter((path): path is string => typeof path === "string"))]]] : []))]]
            : []))
      : d.projectOrder,
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
    showHiddenFiles: bool(r.showHiddenFiles, d.showHiddenFiles),
    showGitignoredFiles: bool(r.showGitignoredFiles, d.showGitignoredFiles),
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
    // unknown ids and bindings that cannot be used are dropped once the commands are registered (keybind.ts)
    keyBindings:
      r.keyBindings && typeof r.keyBindings === "object" && !Array.isArray(r.keyBindings)
        ? Object.fromEntries(
            Object.entries(r.keyBindings).flatMap(([id, v]) => (Array.isArray(v) ? [[id, v.filter(isBinding)]] : [])),
          )
        : d.keyBindings,
    leaderKey: leaderOf(r.leaderKey),
    keySequenceTimeout: clampTimeout(r.keySequenceTimeout),
    proofread: readProofread(r.proofread),
    markdownBreaks: r.markdownBreaks === "blank-line" ? "blank-line" : "newline",
    ui: r.ui && typeof r.ui === "object" && !Array.isArray(r.ui) ? (r.ui as Record<string, unknown>) : d.ui,
  };
};

/** Whether the dark colours apply. */
export const isDark = (theme: Theme, systemDark: boolean) => theme === "dark" || (theme === "auto" && systemDark);

/** The settings only Rust changes (docs/adr/0050): adding a workspace, the library, the programs. */
const OWNED = ["workspaces", "libraryDir", "gitPath", "golemPath", "shemPath"] as const;

/** Takes the paths Rust kept from the settings it wrote, leaving the rest as it is. */
export const adopt = (config: Config, written: string) => {
  const r = normalize(JSON.parse(written));
  for (const k of OWNED) (config as Record<string, unknown>)[k] = r[k];
};

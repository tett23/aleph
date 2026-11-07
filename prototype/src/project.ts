// Workspaces (one Git repository each) and the Golem projects in them.
import { api, basename, dirname, ext, type Entry } from "./api";
import { config } from "./config";
import { parseDelimited, writeDelimited } from "./csv";
import { readGrid, type Grid } from "./gm";

export const TEXT_KINDS = ["gm", "emet", "md", "toml", "csv", "tsv", "svg", "mmd", "mermaid", "txt"];
export const SHEET_KINDS = [...TEXT_KINDS, "pdf"];

export const kindOf = (path: string) => {
  const e = ext(path);
  return e === "mermaid" ? "mmd" : e;
};

/** The Golem project that contains a path: the nearest directory with manifest.toml. */
export const projectOf = async (path: string, stopAt: string): Promise<string | null> => {
  let d = dirname(path);
  while (d.length >= stopAt.length) {
    if (await api.exists(`${d}/manifest.toml`)) return d;
    if (d === stopAt) break;
    d = dirname(d);
  }
  return null;
};

export const workspaceOf = (path: string) =>
  config.workspaces.find((w) => path === w || path.startsWith(w + "/")) ?? null;

export const flatten = (entries: Entry[]): Entry[] => entries.flatMap((e) => (e.dir ? flatten(e.children) : [e]));

/** Chapters listed in manifest.toml, as paths relative to the project. */
export const manifestChapters = (manifest: string): string[] => {
  const m = /^chapters\s*=\s*\[([\s\S]*?)\]/m.exec(manifest);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+\.gm)"/g)].map((x) => x[1]);
};

export const addChapter = (manifest: string, rel: string): string =>
  manifest.replace(/^chapters\s*=\s*\[([\s\S]*?)\]/m, (_, inner: string) => {
    const items = inner.trim().replace(/,\s*$/, "");
    return `chapters = [${items ? items + ", " : ""}"${rel}"]`;
  });

/** The text files of a group, chapters of a project first. */
export const sheetsOf = async (dir: string, tree: Entry[]): Promise<string[]> => {
  const files = flatten(tree)
    .map((e) => e.path)
    .filter((p) => SHEET_KINDS.includes(kindOf(p)))
    .filter((p) => !/\/(fonts|build)\//.test(p.slice(dir.length)));
  const isProject = await api.exists(`${dir}/manifest.toml`);
  if (!isProject) return files.sort();
  const chapters = manifestChapters(await api.readText(`${dir}/manifest.toml`)).map((r) => `${dir}/${r}`);
  const special = new Set([`${dir}/manifest.toml`, `${dir}/style.toml`, `${dir}/preflight.toml`, `${dir}/plot.csv`]);
  const rest = files.filter((p) => !chapters.includes(p) && !special.has(p)).sort();
  return [...chapters.filter((c) => files.includes(c)), ...rest];
};

export const gridOf = async (project: string | null): Promise<Grid> => {
  const g = project && (await api.exists(`${project}/style.toml`)) ? readGrid(await api.readText(`${project}/style.toml`)) : { chars: 40, lines: 16, vertical: false };
  return g;
};

// ---- per-file metadata (Ulysses-like goals and notes) in <project>/.aleph/notes.json ----
export type SheetMeta = { goal?: number; notes: string[]; done: string[] };
export type MetaFile = Record<string, SheetMeta>;

const metaPath = (root: string) => `${root}/.aleph/notes.json`;

export const loadMeta = async (root: string): Promise<MetaFile> =>
  (await api.exists(metaPath(root))) ? JSON.parse(await api.readText(metaPath(root))) : {};

export const saveMeta = (root: string, m: MetaFile) => api.writeText(metaPath(root), JSON.stringify(m, null, 2) + "\n");

// ---- plot.csv ----
export const PLOT_COLUMNS = [
  ["scene", "シーン"],
  ["file", "ファイル"],
  ["subplots", "サブプロット"],
  ["pov", "視点人物"],
  ["characters", "登場人物"],
  ["place", "場所"],
  ["must", "書かなくてはいけないこと"],
  ["flavor", "フレーバー"],
  ["target", "予定字数"],
  ["memo", "メモ"],
  ["fragments", "本文の断片"],
  ["start", "開始（物語の中の時）"],
  ["end", "終了"],
] as const;

export type PlotKey = (typeof PLOT_COLUMNS)[number][0];
export type PlotRow = Record<PlotKey, string>;

export const plotPath = (project: string) => `${project}/plot.csv`;

export const loadPlot = async (project: string): Promise<PlotRow[]> => {
  if (!(await api.exists(plotPath(project)))) return [];
  const [head, ...rows] = parseDelimited(await api.readText(plotPath(project)), ",");
  if (!head) return [];
  return rows
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(PLOT_COLUMNS.map(([k]) => [k, r[head.indexOf(k)] ?? ""])) as PlotRow);
};

export const savePlot = (project: string, rows: PlotRow[]) =>
  api.writeText(plotPath(project), writeDelimited([PLOT_COLUMNS.map(([k]) => k), ...rows.map((r) => PLOT_COLUMNS.map(([k]) => r[k]))], ","));

const split = (re: RegExp) => (s: string) =>
  s
    .split(re)
    .map((x) => x.trim())
    .filter(Boolean);

/** A list cell of sentences: lines or ";" separated. */
export const listCell = split(/\n|;|；/);

/** A list cell of names: also "、" and "," separated. */
export const namesCell = split(/\n|;|；|、|,/);

export const rowsForFile = (rows: PlotRow[], project: string, path: string) =>
  rows.filter((r) => r.file && `${project}/${r.file}` === path);

// ---- the shared library: fonts/, plugins/*.wasm and functions/*.emet ----
// Projects get copies, so that each project's repository pins what it uses.

const libDir = (sub: string) => (config.libraryDir ? `${config.libraryDir}/${sub}` : "");

/** Copies fonts that style.toml refers to and the project lacks, from the library. */
export const copyFonts = async (project: string): Promise<string[]> => {
  if (!config.libraryDir || !(await api.exists(`${project}/style.toml`))) return [];
  const style = await api.readText(`${project}/style.toml`);
  const wanted = [...style.matchAll(/"((?:[^"\/]+\/)*[^"\/]+\.(?:otf|ttf|ttc|woff2?))"/gi)].map((m) => m[1]);
  const shared = await api.listDir(libDir("fonts"));
  const copied: string[] = [];
  for (const rel of wanted) {
    const to = `${project}/${rel}`;
    if (await api.exists(to)) continue;
    const from = shared.find((p) => basename(p) === basename(rel));
    if (!from) continue;
    await api.copyFile(from, to);
    copied.push(rel);
  }
  for (const p of shared.filter((p) => /^LICENSE/i.test(basename(p)))) {
    const to = `${project}/fonts/${basename(p)}`;
    if (!(await api.exists(to))) await api.copyFile(p, to);
  }
  return copied;
};

export type LibItem = { kind: "plugin" | "function"; name: string; from: string; to: string; state: "absent" | "same" | "changed" };

const sameBytes = async (a: string, b: string) => {
  const [x, y] = await Promise.all([api.readBytes(a), api.readBytes(b)]);
  if (x.byteLength !== y.byteLength) return false;
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  return u.every((c, i) => c === v[i]);
};

/** The library's plugins and functions, and whether the project has them. */
export const libraryItems = async (project: string): Promise<LibItem[]> => {
  if (!config.libraryDir) return [];
  const items: LibItem[] = [];
  for (const [kind, sub, ext] of [["plugin", "plugins", ".wasm"], ["function", "functions", ".emet"]] as const) {
    for (const from of (await api.listDir(libDir(sub))).filter((p) => p.endsWith(ext)).sort()) {
      const to = `${project}/${sub}/${basename(from)}`;
      const state = !(await api.exists(to)) ? "absent" : (await sameBytes(from, to)) ? "same" : "changed";
      items.push({ kind, name: basename(from).slice(0, -ext.length), from, to, state });
    }
  }
  return items;
};

/** Copies a library item into the project; a plugin is also declared in manifest.toml. */
export const installItem = async (project: string, item: LibItem) => {
  await api.copyFile(item.from, item.to);
  if (item.kind !== "plugin") return;
  const mp = `${project}/manifest.toml`;
  const manifest = await api.readText(mp);
  if (new RegExp(`^\\[plugins\\.${item.name}\\]`, "m").test(manifest)) return;
  await api.writeText(mp, `${manifest.replace(/\n*$/, "\n")}\n[plugins.${item.name}]\npath = "plugins/${item.name}.wasm"\n`);
};

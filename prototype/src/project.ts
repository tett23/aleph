// Workspaces (one Git repository each) and the Golem projects in them.
import { api, basename, dirname, ext, type Entry } from "./api";
import { config } from "./config";
import { parseDelimited, writeDelimited } from "./csv";
import { readGrid, type Grid } from "./gm";

export const TEXT_KINDS = ["gm", "emet", "md", "toml", "csv", "tsv", "svg", "mmd", "mermaid", "txt"];
export const IMAGE_KINDS = ["png", "jpg", "jpeg", "gif", "webp"];
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
export type SheetMeta = { goal?: number; note: string; done: string[] };
export type MetaFile = Record<string, SheetMeta>;

const metaPath = (root: string) => `${root}/.aleph/notes.json`;

export const loadMeta = async (root: string): Promise<MetaFile> => {
  const raw: Record<string, SheetMeta & { notes?: string[] }> = (await api.exists(metaPath(root)))
    ? JSON.parse(await api.readText(metaPath(root)))
    : {};
  // the first prototype kept several notes per sheet; join them into one
  for (const m of Object.values(raw)) {
    if (m.notes) m.note = [m.note, ...m.notes].filter((x) => x && x.trim()).join("\n\n");
    delete m.notes;
    m.note ??= "";
    m.done ??= [];
  }
  return raw;
};

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
export type PlotRow = Record<PlotKey, string> & Record<string, string>;
const STANDARD = new Set<string>(PLOT_COLUMNS.map(([k]) => k));

export const plotPath = (project: string) => `${project}/plot.csv`;

/** The rows and the columns the user added (any header beyond the standard ones). */
export const loadPlotTable = async (project: string): Promise<{ rows: PlotRow[]; extras: string[] }> => {
  if (!(await api.exists(plotPath(project)))) return { rows: [], extras: [] };
  const [head, ...rows] = parseDelimited(await api.readText(plotPath(project)), ",");
  if (!head) return { rows: [], extras: [] };
  const extras = head.map((h) => h.trim()).filter((h) => h && !STANDARD.has(h));
  const keys = [...PLOT_COLUMNS.map(([k]) => k as string), ...extras];
  return {
    rows: rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(keys.map((k) => [k, r[head.indexOf(k)] ?? ""])) as PlotRow),
    extras,
  };
};

export const loadPlot = async (project: string): Promise<PlotRow[]> => (await loadPlotTable(project)).rows;

export const savePlot = (project: string, rows: PlotRow[], extras: string[] = []) => {
  const keys = [...PLOT_COLUMNS.map(([k]) => k as string), ...extras];
  return api.writeText(plotPath(project), writeDelimited([keys, ...rows.map((r) => keys.map((k) => r[k] ?? ""))], ","));
};

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

export type LibKind = "font" | "plugin" | "function";
export type LibItem = { kind: LibKind; name: string; from: string; to: string; state: "absent" | "same" | "changed" };

export const LIB_DIRS: [LibKind, string, RegExp][] = [
  ["font", "fonts", /\.(otf|ttf|ttc|woff2?)$/i],
  ["plugin", "plugins", /\.wasm$/i],
  ["function", "functions", /\.emet$/i],
];

/** The files of the shared library by kind. */
export const libraryFiles = async () => {
  if (!config.libraryDir) return [];
  const out: { kind: LibKind; sub: string; from: string; name: string }[] = [];
  for (const [kind, sub, re] of LIB_DIRS)
    for (const from of (await api.listDir(libDir(sub))).filter((p) => re.test(p)).sort())
      out.push({ kind, sub, from, name: basename(from) });
  return out;
};

/** The state of one library file in one project. */
export const itemIn = async (project: string, f: { kind: LibKind; sub: string; from: string; name: string }): Promise<LibItem> => {
  const to = `${project}/${f.sub}/${f.name}`;
  const state = !(await api.exists(to)) ? "absent" : (await sameBytes(f.from, to)) ? "same" : "changed";
  return { kind: f.kind, name: f.kind === "font" ? f.name : f.name.replace(/\.[^.]+$/, ""), from: f.from, to, state };
};

/** Every Golem project in every workspace. */
export const allProjects = async (): Promise<string[]> => {
  const found: string[] = [];
  const walk = (es: Entry[]) =>
    es.forEach((e) => {
      if (!e.dir) return;
      if (e.children.some((c) => c.name === "manifest.toml")) found.push(e.path);
      else walk(e.children);
    });
  for (const w of config.workspaces) walk(await api.listTree(w).catch(() => []));
  return found;
};

const sameBytes = async (a: string, b: string) => {
  const [x, y] = await Promise.all([api.readBytes(a), api.readBytes(b)]);
  if (x.byteLength !== y.byteLength) return false;
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  return u.every((c, i) => c === v[i]);
};

/** The library's plugins and functions, and whether the project has them. */
export const libraryItems = async (project: string): Promise<LibItem[]> =>
  Promise.all((await libraryFiles()).filter((f) => f.kind !== "font").map((f) => itemIn(project, f)));

/** Copies a library item into the project; a plugin is also declared in manifest.toml. */
export const installItem = async (project: string, item: LibItem) => {
  await api.copyFile(item.from, item.to);
  if (item.kind !== "plugin") return;
  const mp = `${project}/manifest.toml`;
  const manifest = await api.readText(mp);
  if (new RegExp(`^\\[plugins\\.${item.name}\\]`, "m").test(manifest)) return;
  await api.writeText(mp, `${manifest.replace(/\n*$/, "\n")}\n[plugins.${item.name}]\npath = "plugins/${item.name}.wasm"\n`);
};

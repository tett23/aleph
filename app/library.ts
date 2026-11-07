// The shared library (docs/adr/0014): fonts/, plugins/*.wasm and functions/*.emet
// in one folder, copied into projects; and images put into a project as assets.
// File operations come in as `Fs`, so the logic runs in tests over node:fs.
import { basename, rel, stem } from "./path.ts";
import { projectOf } from "./workspace.ts";

export type Fs = {
  exists: (p: string) => Promise<boolean>;
  readBytes: (p: string) => Promise<ArrayBuffer>;
  readText: (p: string) => Promise<string>;
  writeText: (p: string, t: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  listDir: (p: string) => Promise<string[]>;
};

export type LibKind = "font" | "plugin" | "function";
export type LibFile = { kind: LibKind; sub: string; from: string; name: string };
export type LibState = "same" | "changed" | "absent";

const FONT = /\.(otf|ttf|ttc|woff2?)$/i;
const DIRS: [LibKind, string, RegExp][] = [
  ["font", "fonts", FONT],
  ["plugin", "plugins", /\.wasm$/i],
  ["function", "functions", /\.emet$/i],
];

export const libraryFiles = async (fs: Fs, lib: string): Promise<LibFile[]> => {
  const out: LibFile[] = [];
  for (const [kind, sub, re] of DIRS)
    for (const from of (await fs.listDir(`${lib}/${sub}`)).filter((p) => re.test(p)).sort()) out.push({ kind, sub, from, name: basename(from) });
  return out;
};

const sameBytes = async (fs: Fs, a: string, b: string) => {
  const [x, y] = await Promise.all([fs.readBytes(a), fs.readBytes(b)]);
  if (x.byteLength !== y.byteLength) return false;
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  return u.every((c, i) => c === v[i]);
};

/** Whether a project has the library's file: the same bytes, different bytes, or not at all. */
export const stateOf = async (fs: Fs, from: string, to: string): Promise<LibState> =>
  !(await fs.exists(to)) ? "absent" : (await sameBytes(fs, from, to)) ? "same" : "changed";

export const targetIn = (project: string, f: LibFile) => `${project}/${f.sub}/${f.name}`;

/** manifest.toml with `[plugins.<name>]` and its path, unless already declared. */
export const addPluginDecl = (manifest: string, name: string): string =>
  new RegExp(`^\\s*\\[plugins\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "m").test(manifest)
    ? manifest
    : `${manifest.replace(/\n*$/, "\n")}\n[plugins.${name}]\npath = "plugins/${name}.wasm"\n`;

/** Copies a library file into a project; a plugin is declared in its manifest too. */
export const installItem = async (fs: Fs, project: string, f: LibFile) => {
  await fs.copyFile(f.from, targetIn(project, f));
  if (f.kind !== "plugin") return;
  const mp = `${project}/manifest.toml`;
  const m = await fs.readText(mp).catch(() => "");
  const next = addPluginDecl(m, stem(f.name));
  if (next !== m) await fs.writeText(mp, next);
};

/** The font files style.toml names, as paths from the project's root. */
export const fontsWanted = (style: string): string[] =>
  [...new Set([...style.matchAll(/"((?:[^"/\n]+\/)*[^"/\n]+\.(?:otf|ttf|ttc|woff2?))"/gi)].map((m) => m[1]))];

/** Copies the fonts style.toml names and the project lacks, and the library's licenses; returns what it copied. */
export const copyFonts = async (fs: Fs, lib: string, project: string): Promise<string[]> => {
  const style = await fs.readText(`${project}/style.toml`).catch(() => "");
  const shared = await fs.listDir(`${lib}/fonts`);
  const copied: string[] = [];
  for (const rel of fontsWanted(style)) {
    if (await fs.exists(`${project}/${rel}`)) continue;
    const from = shared.find((p) => basename(p) === basename(rel));
    if (!from) continue;
    await fs.copyFile(from, `${project}/${rel}`);
    copied.push(rel);
  }
  if (copied.length)
    for (const p of shared.filter((p) => /^LICENSE/i.test(basename(p)))) {
      const to = `${project}/fonts/${basename(p)}`;
      if (!(await fs.exists(to))) await fs.copyFile(p, to);
    }
  return copied;
};

/** Where a dropped file goes in the library; null when it is not one the library keeps. */
export const libSubdir = (p: string): string | null =>
  /\.wasm$/i.test(p) ? "plugins" : /\.emet$/i.test(p) ? "functions" : FONT.test(p) || /^LICENSE/i.test(basename(p)) ? "fonts" : null;

/** A name in `dir` that does not overwrite: name, name-2, name-3, … */
export const freeName = async (fs: Fs, dir: string, name: string): Promise<string> => {
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${base}-${n}${ext}`;
    if (!(await fs.exists(`${dir}/${candidate}`))) return candidate;
  }
};

export const FIGURE_KINDS = /\.(png|jpe?g|svg|pdf)$/i;

/**
 * An image dragged from the tree onto a chapter of `project` (docs/adr/0018): referenced
 * by its path from the project's root when it is in that project, copied to images/ when
 * it is elsewhere; null for a kind @figure does not take.
 */
export const figurePlan = (image: string, project: string, projects: string[]): { copy: false; path: string } | { copy: true } | null => {
  if (!FIGURE_KINDS.test(image)) return null;
  return projectOf(image, projects) === project ? { copy: false, path: rel(project, image) } : { copy: true };
};

/** Where and what to insert after 1-based `line` of `text`: a @figure with an indented caption line per image. */
export const figureInsert = (text: string, line: number, images: string[]): { at: number; insert: string } => {
  let start = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) break;
    start = nl + 1;
  }
  const nl = text.indexOf("\n", start);
  const end = nl < 0 ? text.length : nl;
  const content = text.slice(start, end);
  const at = nl < 0 ? end : nl + 1;
  const pre = (nl < 0 ? "\n" : "") + (content.trim() ? "\n" : "");
  const body = images.map((p) => `@figure ${p} alt="${stem(p).replace(/"/g, "")}"\n  キャプション`).join("\n\n") + "\n";
  // a blank line separates the figure from what follows, unless one is already there
  const next = text.slice(at, text.indexOf("\n", at) < 0 ? text.length : text.indexOf("\n", at));
  const post = at < text.length && next.trim() !== "" ? "\n" : "";
  return { at, insert: pre + body + post };
};

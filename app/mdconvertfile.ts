// The file side of "gm に変換" (docs/adr/0016, docs/adr/0061), apart from the screen so the tests can run it.
import { addChapter, manifestChapters, paragraphSeparator } from "./manifest.ts";
import { mdToGm } from "./mdgm.ts";
import { basename, dirname, rel, stem } from "./path.ts";

/** What the conversion reads and writes, so the tests can watch it (I10 of docs/adr/0061). */
export type ConvertIo = {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string>;
  writeText: (path: string, text: string) => Promise<void>;
  confirm: (message: string) => Promise<boolean>;
  /** An embed's target from the .md, as a workspace path, or null. */
  resolve: (target: string) => string | null;
};

/**
 * Writes the .gm beside the .md (asking before overwriting one) and, in a project, adds it to manifest.toml's
 * chapters. The .md itself is never written, removed or renamed: the writer keeps the original (I10).
 * Returns the .gm's path, or null when the writer stopped.
 */
export const convertFile = async (io: ConvertIo, md: { path: string; text: string; project: string | null }): Promise<string | null> => {
  const to = `${dirname(md.path)}/${stem(md.path)}.gm`;
  if ((await io.exists(to)) && !(await io.confirm(`${basename(to)} はもうあります。上書きします`))) return null;
  const project = md.project;
  const manifestPath = project ? `${project}/manifest.toml` : null;
  const manifest = manifestPath ? await io.readText(manifestPath).catch(() => "") : "";
  // the style of paragraphs the new file will be read in: its project's, blank-line outside projects
  const sep = project ? paragraphSeparator(manifest, rel(project, to), "") : "blank-line";
  // images are found from the project's root (Golem's paths); outside a project they stay as written
  const dir = !project ? null : dirname(md.path) === project ? "" : rel(project, dirname(md.path));
  const resolveEmbed = (t: string) => {
    const p = io.resolve(t);
    return p && project && p.startsWith(`${project}/`) ? rel(project, p) : null;
  };
  await io.writeText(to, mdToGm(md.text, sep, { dir, resolveEmbed }));
  if (project && manifestPath && !manifestChapters(manifest).includes(rel(project, to))) await io.writeText(manifestPath, addChapter(manifest, rel(project, to)));
  return to;
};

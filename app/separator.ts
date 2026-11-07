// Each project's manifest.toml, read once until it is saved, for the paragraph
// separator of its files (Golem's paragraph-separator).
import { api } from "./api.ts";
import { paragraphSeparator, type Separator } from "./manifest.ts";
import { rel } from "./path.ts";

const manifests = new Map<string, string>();

export const loadManifest = async (project: string) => {
  if (!manifests.has(project)) manifests.set(project, await api.readText(`${project}/manifest.toml`).catch(() => ""));
  return manifests.get(project)!;
};

export const forgetManifest = (project: string) => manifests.delete(project);

/** The separator of a file; blank-line outside projects or before the manifest is read. */
export const separatorOf = (project: string | null, path: string, text: string): Separator =>
  project ? paragraphSeparator(manifests.get(project) ?? "", rel(project, path), text) : "blank-line";

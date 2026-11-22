// Move the metadata keys alongside a move of sheets (ADR 0100).
import { rel } from "./path.ts";
import { movedPath, withinMove } from "./tree-move.ts";
import { projectOf } from "./workspace.ts";

export type MoveMetadata = { path: string; before: string | null; after: string };

export const moveMetadataRoots = (workspace: string, from: string, to: string, projects: string[]) =>
  [...new Set([workspace, projectOf(from, projects), projectOf(to, projects)].filter((root): root is string => !!root))];

const decode = (raw: string | null, path: string): Map<string, unknown> => {
  if (raw === null) return new Map();
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return new Map(Object.entries(value));
  } catch {
    // A store that cannot be read must not be replaced by an empty one.
  }
  throw new Error(`メタデータを読めません：${path}`);
};

export const planMoveMetadata = (workspace: string, from: string, to: string, projects: string[], documents: ReadonlyMap<string, string | null>): MoveMetadata[] => {
  const pathOf = (root: string) => root + "/.aleph/notes.json";
  const stores = new Map([...documents].map(([root, raw]) => [root, decode(raw, pathOf(root))] as const));
  const newProjects = projects.map((p) => movedPath(p, from, to));
  const changed = new Set<string>();
  for (const [root, store] of stores) {
    // A whole project's metadata file travels with the project and keeps its keys.
    if (projects.includes(root) && withinMove(root, from)) continue;
    for (const [key, meta] of [...store]) {
      const old = root + "/" + key;
      if (!withinMove(old, from) || (projectOf(old, projects) ?? workspace) !== root) continue;
      const next = movedPath(old, from, to);
      const newRoot = projectOf(next, newProjects) ?? workspace;
      const target = stores.get(newRoot);
      if (!target) throw new Error(`メタデータを確認できません：${pathOf(newRoot)}`);
      const newKey = rel(newRoot, next);
      if (target.has(newKey)) throw new Error(`移動先にメタデータがあります：${next}`);
      target.set(newKey, meta);
      store.delete(key);
      changed.add(root);
      changed.add(newRoot);
    }
  }
  return [...documents.keys()].filter((root) => changed.has(root)).map((root) => ({
    path: pathOf(root), before: documents.get(root)!, after: JSON.stringify(Object.fromEntries(stores.get(root)!), null, 2) + "\n",
  }));
};

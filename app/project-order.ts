// Project display order in a workspace (docs/adr/0074).
import type { Entry } from "./api.ts";
import { dirname, rel } from "./path.ts";

/** Workspace -> parent directory -> project paths, all relative to the workspace. */
export type ProjectOrder = Record<string, Record<string, string[]>>;

const parentKey = (root: string, parent: string) => parent === root ? "" : rel(root, parent);

const savedPaths = (root: string, parent: string, order: ProjectOrder): string[] => {
  if (!Object.hasOwn(order, root)) return [];
  const parents = order[root];
  const key = parentKey(root, parent);
  return parents && Object.hasOwn(parents, key) && Array.isArray(parents[key]) ? parents[key] : [];
};

const orderedSiblings = (root: string, entries: Entry[], known: ReadonlySet<string>, order: ProjectOrder, parent: string): Entry[] => {
  const stored = savedPaths(root, parent, order);
  if (!stored.length) return entries;
  const projects = entries.filter((entry) => known.has(entry.path));
  if (projects.length < 2) return entries;
  const byPath = new Map(projects.map((entry) => [rel(root, entry.path), entry]));
  const used = new Set<string>();
  const ordered = [...stored, ...byPath.keys()].flatMap((path) => {
    const project = byPath.get(path);
    if (!project || used.has(path)) return [];
    used.add(path);
    return [project];
  });
  if (ordered.every((entry, index) => entry === projects[index])) return entries;
  let next = 0;
  return entries.map((entry) => known.has(entry.path) ? ordered[next++] : entry);
};

/** Reorder only project positions, preserving each entry's children and other sibling positions. */
export const orderProjectEntries = (root: string, entries: Entry[], known: ReadonlySet<string>, order: ProjectOrder, parent = root): Entry[] => {
  if (!Object.hasOwn(order, root)) return entries;
  const siblings = orderedSiblings(root, entries, known, order, parent);
  let changed = siblings !== entries;
  const next = siblings.map((entry) => {
    if (!entry.dir) return entry;
    const children = orderProjectEntries(root, entry.children, known, order, entry.path);
    if (children === entry.children) return entry;
    changed = true;
    return { ...entry, children };
  });
  return changed ? next : entries;
};

const siblingsAt = (entries: Entry[], parent: string, root: string): Entry[] => {
  if (parent === root) return entries;
  for (const entry of entries) {
    if (entry.path === parent) return entry.children;
    if (entry.dir && parent.startsWith(`${entry.path}/`)) return siblingsAt(entry.children, parent, root);
  }
  return [];
};

/** Adjacent visible project siblings for a project row's menu. */
export const projectNeighbors = (root: string, entries: Entry[], known: ReadonlySet<string>, order: ProjectOrder, path: string) => {
  const empty = { up: null, down: null };
  if (path === root || !known.has(path) || !path.startsWith(`${root}/`)) return empty;
  const parent = dirname(path);
  const siblings = orderedSiblings(root, siblingsAt(entries, parent, root), known, order, parent)
    .filter((entry) => known.has(entry.path)).map((entry) => entry.path);
  const index = siblings.indexOf(path);
  return index < 0 ? empty : { up: siblings[index - 1] ?? null, down: siblings[index + 1] ?? null };
};

/** Save an adjacent swap without dropping hidden projects from an existing order. */
export const moveProject = (root: string, entries: Entry[], known: ReadonlySet<string>, order: ProjectOrder, path: string, direction: "up" | "down"): ProjectOrder => {
  const neighbor = projectNeighbors(root, entries, known, order, path)[direction];
  if (!neighbor) return order;
  const parent = dirname(path);
  const siblingPaths = orderedSiblings(root, siblingsAt(entries, parent, root), known, order, parent)
    .filter((entry) => known.has(entry.path)).map((entry) => rel(root, entry.path));
  const stored = savedPaths(root, parent, order);
  const next = [...stored, ...siblingPaths.filter((p) => !stored.includes(p))];
  const a = next.indexOf(rel(root, path));
  const b = next.indexOf(rel(root, neighbor));
  [next[a], next[b]] = [next[b], next[a]];
  const parents = Object.hasOwn(order, root) ? order[root] : {};
  return { ...order, [root]: { ...parents, [parentKey(root, parent)]: next } };
};

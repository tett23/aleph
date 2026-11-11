// Paths for the two tree-row creation actions (docs/adr/0065).
export const SHEET_KINDS = ["gm", "md", "emet", "txt", "toml", "csv", "tsv", "svg", "mmd", "json", "jsonc", "json5", "jsonl"] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

export const createdPath = (parent: string, input: string, kind: SheetKind | null): string | null => {
  const name = input.trim();
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) return null;
  const fileName = kind && !name.toLowerCase().endsWith(`.${kind}`) ? `${name}.${kind}` : name;
  return `${parent}/${fileName}`;
};

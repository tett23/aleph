// Saved page inputs for one project (ADR 0072). Keep the original text for
// files first touched while a build is running, including previously closed sheets.
export type PageSaveKind = "automatic" | "explicit" | "intermediate";

export const pageSaveTiming = (kind: PageSaveKind, before: string, after: string, eligible: boolean) => {
  if (!eligible || before === after || kind === "intermediate") return null;
  return kind === "explicit" ? "now" : "wait";
};

export const createPageInputs = () => {
  const files = new Map<string, { rendered: string; saved: string }>();
  return {
    save(path: string, before: string, after: string) {
      const rendered = files.get(path)?.rendered ?? before;
      files.set(path, { rendered, saved: after });
    },
    changed: () => Array.from(files.values()).some((f) => f.rendered !== f.saved),
    snapshot: () => new Map(Array.from(files, ([path, f]) => [path, f.saved])),
    publish(snapshot: Map<string, string>) {
      for (const [path, file] of files) {
        file.rendered = snapshot.get(path) ?? file.rendered;
        if (file.rendered === file.saved) files.delete(path);
      }
    },
  };
};

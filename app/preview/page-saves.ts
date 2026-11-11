import type { Action } from "../store.ts";
import type { createWaiter } from "./wait.ts";

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

export const createPageSaves = (waiter: ReturnType<typeof createWaiter>) => {
  const projects = new Map<string, ReturnType<typeof createPageInputs>>();
  const inputsFor = (project: string) => {
    const previous = projects.get(project);
    if (previous) return previous;
    const inputs = createPageInputs();
    projects.set(project, inputs);
    return inputs;
  };
  return {
    inputsFor,
    saved(project: string, action: Extract<Action, { type: "saved" }>, before: string, eligible: boolean, build: () => void) {
      if (before !== action.text && (eligible || projects.has(project))) inputsFor(project).save(action.path, before, action.text);
      const timing = pageSaveTiming(action.pageSave ?? "automatic", action.beforeFormat ?? before, action.text, eligible);
      if (timing === "wait") waiter.request(project, build);
      if (timing === "now") {
        waiter.cancel(project);
        build();
      }
    },
  };
};

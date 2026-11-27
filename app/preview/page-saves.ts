import type { Action } from "../store.ts";
import type { createWaiter } from "./wait.ts";
import type { InputChange, InputContent } from "./project-inputs.ts";

// Saved page inputs for one project (ADR 0072). Keep the original text for
// files first touched while a build is running, including previously closed sheets.
export type PageSaveKind = "automatic" | "explicit" | "intermediate";

export const pageSaveTiming = (kind: PageSaveKind, before: string, after: string, eligible: boolean) => {
  if (!eligible || before === after || kind === "intermediate") return null;
  return kind === "explicit" ? "now" : "wait";
};

export const createPageInputs = () => {
  const files = new Map<string, { rendered: InputContent; saved: InputContent }>();
  return {
    save(path: string, before: InputContent, after: InputContent) {
      const previous = files.get(path);
      const rendered = previous ? previous.rendered : before;
      files.set(path, { rendered, saved: after });
    },
    changed: () => Array.from(files.values()).some((f) => f.rendered !== f.saved),
    snapshot: () => new Map(Array.from(files, ([path, f]) => [path, f.saved])),
    publish(snapshot: Map<string, InputContent>) {
      for (const [path, file] of files) {
        const rendered = snapshot.get(path);
        if (rendered !== undefined) file.rendered = rendered;
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
  const change = (project: string, changes: readonly InputChange[], timing: "wait" | "now" | null, build: () => void) => {
    if (changes.length && (timing || projects.has(project))) {
      const inputs = inputsFor(project);
      for (const { path, before, after } of changes) inputs.save(path, before, after);
    }
    if (timing === "wait") waiter.request(project, build);
    if (timing === "now") {
      waiter.cancel(project);
      build();
    }
  };
  return {
    inputsFor, change,
    saved(project: string, action: Extract<Action, { type: "saved" }>, before: string, eligible: boolean, build: () => void) {
      const timing = pageSaveTiming(action.pageSave ?? "automatic", action.beforeFormat ?? before, action.text, eligible);
      const changes = before === action.text ? [] : [{ path: action.path, before, after: action.text }];
      if (changes.length && eligible && !timing) inputsFor(project);
      change(project, changes, timing, build);
    },
  };
};

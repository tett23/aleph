// Whether the plot can be opened (docs/adr/0098): the project it would open, whether that
// project's plot.csv is there and readable, checked again on a switch, on file changes and
// right before running; a result for an older check is dropped. The ribbon, the palette
// and the keys all read this one check.
import { focused, shownDoc, type State } from "../store.ts";

export type PlotIo = { exists: (path: string) => Promise<boolean>; readText: (path: string) => Promise<string> };

export type PlotProbe = "present" | "missing" | "unreadable";

export type PlotAvailability = { kind: "noTarget" } | { kind: "checking" | PlotProbe; project: string };

/** The project view.plot opens: the focused sheet's, the shown plot's, or the followed sheet's (docs/adr/0087). */
export const plotTarget = (s: State): string | null => focused(s)?.project ?? s.plot ?? shownDoc(s)?.project ?? null;

/** Whether `project/plot.csv` is there and can be read; a file with the header only is there. */
export const probePlot = async (project: string, io: PlotIo): Promise<PlotProbe> => {
  const path = `${project}/plot.csv`;
  try {
    if (!(await io.exists(path))) return "missing";
  } catch {
    return "unreadable";
  }
  try {
    await io.readText(path);
    return "present";
  } catch {
    // gone between the two questions, or there and not readable
    return (await io.exists(path).catch(() => true)) ? "unreadable" : "missing";
  }
};

/** Why the plot cannot be opened, for the ribbon's tooltip and the notice; null when it can. */
export const plotReason = (a: PlotAvailability): string | null => {
  switch (a.kind) {
    case "noTarget":
      return "Golem のプロジェクトのシートを開くと使えます";
    case "checking":
      return "plot.csv を確かめています";
    case "missing":
      return "このプロジェクトには plot.csv がありません";
    case "unreadable":
      return "plot.csv を読み取れません";
    case "present":
      return null;
  }
};

export type PlotGate = {
  /** The plot's state for `s`: a target not checked yet counts as being checked. */
  availability: (s: State) => PlotAvailability;
  enabled: (s: State) => boolean;
  /** Checks the current target again; an older check's result is not applied. */
  check: () => Promise<PlotAvailability>;
  /** Checks right before running: the project to open, or null. */
  confirm: () => Promise<string | null>;
};

export const createPlotGate = (io: PlotIo, get: () => State, onChange: () => void): PlotGate => {
  let last: PlotAvailability = { kind: "noTarget" };
  let seq = 0;
  const availability = (s: State): PlotAvailability => {
    const project = plotTarget(s);
    if (project === null) return { kind: "noTarget" };
    return last.kind !== "noTarget" && last.project === project ? last : { kind: "checking", project };
  };
  const set = (a: PlotAvailability) => {
    last = a;
    onChange();
  };
  const check = async (): Promise<PlotAvailability> => {
    const mine = ++seq;
    const project = plotTarget(get());
    if (project === null) {
      set({ kind: "noTarget" });
      return last;
    }
    set({ kind: "checking", project });
    const kind = await probePlot(project, io);
    // a later check started, or the target moved on: this result is old
    if (mine !== seq || plotTarget(get()) !== project) return availability(get());
    set({ kind, project });
    return last;
  };
  return {
    availability,
    enabled: (s) => availability(s).kind === "present",
    check,
    confirm: async () => {
      const a = await check();
      return a.kind === "present" ? a.project : null;
    },
  };
};

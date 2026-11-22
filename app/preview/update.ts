// A preview's target and the lifetime of a replacement (docs/adr/0097).
export type PreviewTarget = {
  workspace: string;
  project: string;
  paths: readonly string[];
  mode: "plain" | "pages" | "figure" | "none";
  vertical: boolean;
};

export const previewKey = (target: PreviewTarget): string =>
  JSON.stringify([target.workspace, target.project, target.paths, target.mode, target.vertical]);

type Position = { x: number; y: number };

export const positionOf = (left: number, top: number, fromRight: boolean): Position =>
  ({ x: Math.max(0, fromRight ? -left : left), y: Math.max(0, top) });

export const limitPosition = (at: Position, max: Position): Position =>
  ({ x: Math.min(at.x, max.x), y: Math.min(at.y, max.y) });

type Prepared = {
  mount: () => void | Promise<unknown>;
  dispose: () => void;
};

type PreviewPort = {
  read: (target: PreviewTarget) => Position;
  write: (at: Position, target: PreviewTarget) => Position;
  max: () => Position;
  failed: (error: unknown, empty: boolean) => void;
};

export const createPreviewUpdates = (port: PreviewPort) => {
  let latest = 0;
  let current = "";
  let epoch = 0;
  let display: { key: string | null; content: Prepared } | null = null;
  let closed = false;
  let restoring: { target: PreviewTarget; actual: Position; moved: boolean } | null = null;

  const scrolled = () => {
    if (!restoring) return;
    const { target, actual } = restoring;
    const now = port.read(target);
    // An automatic clamp as layout shrinks and our own scroll event both
    // report the expected position. Neither represents a reader's movement.
    const expected = limitPosition(actual, port.max());
    if (Math.abs(now.x - expected.x) > 0.5 || Math.abs(now.y - expected.y) > 0.5) restoring.moved = true;
  };
  const select = (target: PreviewTarget, generation: number) => {
    if (closed || generation < latest) return false;
    const key = previewKey(target);
    if (generation === latest && key !== current) return false;
    if (generation > latest) {
      restoring = null;
      if (display && current !== key) display.key = null;
    }
    latest = generation;
    current = key;
    return true;
  };
  const request = async (target: PreviewTarget, generation: number, load: () => Promise<Prepared>) => {
    if (!select(target, generation)) return;
    const key = previewKey(target);
    const started = epoch;
    const valid = () => !closed && started === epoch && latest === generation && current === key;
    let next: Prepared;
    try {
      next = await load();
    } catch (error) {
      if (valid()) port.failed(error, !display);
      return;
    }
    if (!valid()) return next.dispose();
    const at = display?.key === key ? port.read(target) : { x: 0, y: 0 };
    const previous = display?.content;
    const ready = next.mount();
    display = { key, content: next };
    previous?.dispose();
    const monitor = { target, actual: port.write(at, target), moved: false };
    restoring = monitor;
    await ready;
    if (valid() && restoring === monitor) {
      scrolled();
      restoring = null;
      if (!monitor.moved) port.write(at, target);
    }
  };
  return {
    request, select, scrolled,
    moved: () => { if (restoring) restoring.moved = true; },
    pause: () => { epoch++; restoring = null; },
    reset: () => {
      epoch++;
      current = "";
      restoring = null;
      display?.content.dispose();
      display = null;
    },
    close: () => {
      closed = true;
      restoring = null;
      display?.content.dispose();
      display = null;
    },
  };
};

/** Accept a new display target from its sender, and its result at most once. */
export const createPreviewFeed = (matches: (target: PreviewTarget) => boolean) => {
  let latest = 0;
  let key = "";
  let finished = false;
  return (target: PreviewTarget, generation: number, ready: boolean) => {
    if (!matches(target) || generation < latest) return false;
    const next = previewKey(target);
    if (generation === latest && (next !== key || finished || !ready)) return false;
    latest = generation;
    key = next;
    finished = ready;
    return true;
  };
};

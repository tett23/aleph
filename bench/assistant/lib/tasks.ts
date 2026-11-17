// The task set of the benchmark (bench/assistant/tasks/<kind>.json). A text is
// stored as its lines, and read back with a newline after each line.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["style", "manifest", "gm", "markdown", "command"] as const;
export type Kind = (typeof KINDS)[number];

export type Task = {
  id: string;
  kind: Kind;
  file: string; // the path of the target in the project
  request: string;
  target: string;
  expected: string[]; // the texts that pass, for a rewrite
  command: string | null; // the command id that passes, for a question
  essential: boolean;
};

type Stored = { id: string; file: string; request: string; target: string[]; expected?: string[][]; command?: string; essential: boolean };

const text = (lines: readonly string[]) => lines.map((l) => `${l}\n`).join("");

export const fromStored = (kind: Kind, s: Stored): Task => ({
  id: s.id,
  kind,
  file: s.file,
  request: s.request,
  target: text(s.target),
  expected: (s.expected ?? []).map(text),
  command: s.command ?? null,
  essential: s.essential,
});

export const loadTasks = (dir: string): Task[] =>
  KINDS.flatMap((kind) => (JSON.parse(readFileSync(join(dir, `${kind}.json`), "utf8")) as Stored[]).map((s) => fromStored(kind, s)));

// The tasks whose target is a file of a Golem project, checked by golem check
export const isGolem = (t: Task) => t.kind === "style" || t.kind === "manifest" || t.kind === "gm";

// Decides whether this run of the assistant benchmark measures (docs/adr/0085).
//
//   node bench/assistant/schedule.ts --event <event> --head <sha> < runs.json
//
// runs.json is the recent completed runs of the workflow on main, newest
// first, as [{ id, sha, jobs: [{ name, conclusion }] }]. Prints two lines for
// $GITHUB_OUTPUT: measure=true|false, and measured-runs= the ids of the runs
// that finished measuring, newest first, for the history of the regressions.
import { readFileSync } from "node:fs";
import { measuredRuns, shouldMeasure, type Run } from "./lib/schedule.ts";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) throw new Error(`${flag} is required`);
  return args[i + 1];
};

const runs = JSON.parse(readFileSync(0, "utf8")) as Run[];
const measured = measuredRuns(runs);
const measure = shouldMeasure(value("--event"), value("--head"), measured[0]?.sha ?? null);
process.stderr.write(`${runs.length} runs, ${measured.length} finished measuring, newest ${measured[0]?.sha ?? "none"}\n`);
process.stdout.write(`measure=${measure}\nmeasured-runs=${measured.map((r) => r.id).join(" ")}\n`);

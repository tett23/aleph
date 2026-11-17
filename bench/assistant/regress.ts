// Joins the reports of one CI run of the benchmark and finds the regressions
// against the previous runs (docs/adr/0081, 計測を CI で続ける).
//
//   node bench/assistant/regress.ts --out <file> --history <dir> <report.json>...
//
// <dir> holds the joined results of the previous runs as <dir>/<n>/assistant-bench.json,
// n = 1 for the most recent. The joined result of this run, with its
// regressions, goes to --out; the regressions also go to stdout, one per line.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORY, regressions, type Regression, type Summary } from "./lib/summary.ts";

type Report = { date: string; commit: string; machine: unknown; summaries: Summary[]; runs: unknown[] };
type Joined = { schema: 1; date: string; commit: string; reports: Report[]; summaries: Summary[]; regressions: Regression[] };

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) throw new Error(`${flag} is required`);
  return args[i + 1];
};
const out = value("--out");
const historyDir = value("--history");
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--history");

const reports = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as Report);
const summaries = reports.flatMap((r) => r.summaries);

const history: Joined[] = existsSync(historyDir)
  ? readdirSync(historyDir)
      .filter((d) => /^\d+$/.test(d) && existsSync(join(historyDir, d, "assistant-bench.json")))
      .sort((a, b) => Number(a) - Number(b))
      .slice(0, HISTORY)
      .map((d) => JSON.parse(readFileSync(join(historyDir, d, "assistant-bench.json"), "utf8")) as Joined)
  : [];

const found = regressions(
  summaries,
  history.map((h) => h.summaries),
  history[0]?.regressions ?? [],
);
const joined: Joined = { schema: 1, date: new Date().toISOString(), commit: reports[0]?.commit ?? "", reports, summaries, regressions: found };
writeFileSync(out, `${JSON.stringify(joined, null, 2)}\n`);
process.stderr.write(`${summaries.length} configurations, ${history.length} previous runs, ${found.length} regressions\n`);
for (const r of found) process.stdout.write(`${r.key}\t${r.metric}\t${r.value}\t${r.baseline}\t${r.consecutive ? "consecutive" : "first"}\n`);

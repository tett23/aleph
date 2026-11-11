import type { Out } from "./api.ts";
import { esc } from "./esc.ts";

type BuildLog = {
  args: string[];
  result: { state: "running" } | { state: "finished"; out: Out } | { state: "failed"; reason: string };
};

export const createBuildLogs = () => {
  const latest = new Map<string, BuildLog>();
  return {
    get: (project: string) => latest.get(project),
    run: async (project: string, args: string[], execute: () => Promise<Out>): Promise<Out> => {
      latest.set(project, { args, result: { state: "running" } });
      try {
        const out = await execute();
        latest.set(project, { args, result: { state: "finished", out } });
        return out;
      } catch (error) {
        const reason = String(error);
        latest.set(project, { args, result: { state: "failed", reason } });
        return { code: -1, stdout: "", stderr: reason };
      }
    },
  };
};

export const revealBuildAction = (project: string, reveal: (path: string) => void) => ({
  label: "Finder で表示",
  run: () => reveal(`${project}/build`),
});

export const renderBuildLog = ({ args, result }: BuildLog) => {
  const command = `<dt>実行コマンド</dt><dd>golem ${esc(args.join(" "))}</dd>`;
  const status = result.state === "running" ? "実行中" : result.state === "failed" ? `起動失敗　${esc(result.reason)}` : `終了コード ${result.out.code}`;
  const output = result.state === "finished" ? `<dt>標準出力</dt><dd>${esc(result.out.stdout)}</dd><dt>標準エラー出力</dt><dd>${esc(result.out.stderr)}</dd>` : "";
  return `<dl class="buildlog">${command}<dt>状態</dt><dd>${status}</dd>${output}</dl>`;
};

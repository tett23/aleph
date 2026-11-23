// The inventory, the open documents and the checks of a Golem move plan, shared by the tree's moves
// (docs/adr/0100) and the moves made outside Aleph (docs/adr/0108).
import { api, type TreeMoveInventory } from "./api.ts";
import type { Ctx } from "./ctx.ts";
import { planMoveEdits, type MoveInventory, type MoveResponse } from "./lsp/file-move.ts";
import { uriOf } from "./lsp/protocol.ts";
import { sheetsOf } from "./quickopen.ts";
import { allDocs } from "./store.ts";
import { flatten, IMAGE_KINDS, kindOf, TEXT_KINDS, titleOf } from "./workspace.ts";

const signature = ({ projects, wikiSheets }: MoveInventory) => JSON.stringify([
  projects.map(({ uri, plotCsv }) => JSON.stringify([uri, plotCsv])).sort(),
  wikiSheets.map(({ uri, title }) => JSON.stringify([uri, title])).sort(),
]);
export const sameInventory = (a: MoveInventory, b: MoveInventory) => signature(a) === signature(b);

export const collectInventory = async (workspace: string, tree: TreeMoveInventory): Promise<MoveInventory> => {
  const titles = new Map<string, string>();
  await Promise.all(flatten(tree.entries).filter((e) => ["gm", "md"].includes(kindOf(e.path))).map(async (e) => {
    const title = titleOf(kindOf(e.path), await api.readText(e.path));
    if (title) titles.set(e.path, title);
  }));
  return {
    projects: await Promise.all(tree.projects.map(async (path) => {
      const plot = path + "/plot.csv";
      return { uri: uriOf(path), plotCsv: await api.treeMoveRead(workspace, plot) === null ? null : uriOf(plot) };
    })),
    wikiSheets: sheetsOf(tree.entries, workspace, titles)
      .filter((sheet) => [...TEXT_KINDS, ...IMAGE_KINDS].includes(kindOf(sheet.path)))
      .map((sheet) => ({ uri: uriOf(sheet.path), title: sheet.title ?? null })),
  };
};

export const liveDocuments = (ctx: Ctx, workspace: string) => new Map(allDocs(ctx.store.get())
  .filter((doc) => doc.path.startsWith(workspace + "/") && TEXT_KINDS.includes(doc.kind))
  .map((doc, i) => {
    const edit = ctx.editors.get(doc.path)?.edit;
    return [doc.path, { doc, edit, identity: edit?.core.doc(), text: edit?.core.text() ?? doc.text, version: i + 1 }] as const;
  }));

export const allowedEdits = (workspace: string, response: MoveResponse) => {
  const edits = planMoveEdits(workspace, response);
  if (edits.some((e) => e.path.endsWith("/.aleph/notes.json")))
    throw new Error("Golem の参照編集にメタデータが含まれています");
  return edits;
};

export const describe = (error: unknown): string => {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(describe)].join("\n");
  if (error instanceof Error || typeof error !== "object" || error === null) return String(error);
  const rpc = error as { message?: string; data?: { issues?: { uri: string; range?: { start: { line: number; character: number } }; targetUri: string | null; reason: string }[] } };
  return [rpc.message ?? "Golem LSP の移動計画を取得できませんでした", ...(rpc.data?.issues ?? []).map((i) => {
    const where = i.range ? `:${i.range.start.line + 1}:${i.range.start.character + 1}` : "";
    return `${i.uri}${where}${i.targetUri ? ` → ${i.targetUri}` : ""}：${i.reason}`;
  })].join("\n");
};


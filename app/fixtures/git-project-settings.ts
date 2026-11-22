import { normalize } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { mountDragOut } from "../dragout.ts";
import { showIdentityRequired } from "../git-settings.ts";
import type { GitIdentity } from "../git-ipc.ts";
import { createStore, initialState } from "../store.ts";
import { mountTree } from "../ui/tree.ts";
import "../style.css";

const ws = "/workspace";
const projects = ["星", "月"].map((name) => ({
  name, path: ws + "/" + name, dir: true,
  children: [{ name: "manifest.toml", path: ws + "/" + name + "/manifest.toml", dir: false }],
}));
const reads: string[] = [];
const writes: string[] = [];
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { cwd: string; operation: { kind: string } }) => {
  if (command === "list_tree") return projects;
  if (command === "read_text") return "";
  if (command === "git_operation" && args.operation.kind === "identity") {
    reads.push(args.cwd);
    return {
      repository: { root: args.cwd, gitDir: args.cwd + "/.git", linked: false, branch: "main", hasHead: false, conflicted: false },
      target: args.cwd + "/.git/config", exists: true,
      local: { name: null, email: null }, inherited: { name: null, email: null },
      effective: { name: null, email: null }, missing: ["name", "email"],
    } satisfies GitIdentity;
  }
  writes.push(command);
  throw new Error("Unexpected fixture command " + command);
} } });
const selected = ws + "/星/a.gm";
const store = createStore({ ...initialState(), workspaces: [ws], workspace: ws });
store.dispatch({ type: "open", docs: [{ path: selected, kind: "gm", workspace: ws, project: projects[0].path, text: "", saved: "", grid: { chars: 40, lines: 20, vertical: false } }] });
const ctx = {
  store, config: normalize({}), sidebar: {}, titles: new Map(), decor: [], onRename: [], settings: [], projects: [],
} as unknown as Ctx;
mountTree(ctx);
mountDragOut(ctx);
await ctx.sidebar.files!.render(document.getElementById("tree")!, ctx);
Object.assign(window, { gitProjectFixture: {
  reads, writes,
  showIdentityRequired: () => showIdentityRequired(ctx, projects[1].path, projects[1].path, ["email"]),
  tree: () => ({ focus: store.get().open[store.get().focus]?.path, selection: store.get().selected, expanded: store.get().expanded }),
} });

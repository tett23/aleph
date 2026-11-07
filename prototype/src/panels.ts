// Side panels: search, git, settings, and the right panel (attachments, outline, library).
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, basename, rel, type Hit } from "./api";
import { bin, config, saveConfig } from "./config";
import { gmBlocks } from "./gm";
import { esc, h, icon } from "./icons";
import {
  allProjects,
  installItem,
  itemIn,
  libraryFiles,
  libraryItems,
  listCell,
  loadMeta,
  namesCell,
  rowsForFile,
  saveMeta,
  type MetaFile,
  type PlotRow,
} from "./project";
import { subplotColor } from "./plot";

export type Ctx = {
  openFile: (path: string, line?: number, col?: number) => Promise<void>;
  current: () => { path: string; project: string | null; workspace: string | null; text: string; kind: string } | null;
  workspace: () => string | null;
  refreshTree: () => Promise<void>;
  refreshRight: () => void;
  refreshMarks: () => void;
  toast: (msg: string) => void;
  afterConfig: () => Promise<void>;
};

// ---------------- search ----------------
let searchState = { q: "", regex: false, cs: false, scope: "project" as "project" | "workspace" | "all", hits: [] as Hit[], error: "" };

export const mountSearch = (el: HTMLElement, ctx: Ctx) => {
  // the input is made once; only the toggles and the results are redrawn
  el.innerHTML = `<div class="search">
    <div class="sinput">${icon("search", 14)}<input placeholder="検索"><span class="t" data-t="cs" title="大文字と小文字を区別">Aa</span><span class="t" data-t="regex" title="正規表現">.*</span></div>
    <div class="scope">${(["project", "workspace", "all"] as const).map((s) => `<span data-s="${s}">${{ project: "このプロジェクト", workspace: "ワークスペース", all: "すべて" }[s]}</span>`).join("")}</div>
    <div class="results"></div></div>`;
  const input = el.querySelector("input")!;
  const results = el.querySelector<HTMLElement>(".results")!;
  input.value = searchState.q;
  const draw = () => {
    el.querySelector('[data-t="cs"]')!.classList.toggle("on", searchState.cs);
    el.querySelector('[data-t="regex"]')!.classList.toggle("on", searchState.regex);
    el.querySelectorAll<HTMLElement>("[data-s]").forEach((x) => x.classList.toggle("on", x.dataset.s === searchState.scope));
    const groups = new Map<string, Hit[]>();
    searchState.hits.forEach((x) => groups.set(x.path, [...(groups.get(x.path) ?? []), x]));
    const base = ctx.workspace() ?? "";
    results.innerHTML = searchState.error
      ? `<div class="error">${esc(searchState.error)}</div>`
      : searchState.q && !searchState.hits.length
        ? `<div class="hint">見つかりません</div>`
        : [...groups]
            .map(
              ([p, hs]) =>
                `<div class="f">${icon("file-text", 13)}${esc(rel(base, p))}<small>${hs.length}</small></div>` +
                hs
                  .slice(0, 50)
                  .map((x) => {
                    const chars = [...x.text];
                    const [s0, e0] = x.ranges[0];
                    const from = Math.max(0, s0 - 14);
                    const seg = (a: number, b: number) => esc(chars.slice(a, b).join(""));
                    return `<div class="h" data-p="${esc(p)}" data-l="${x.line}" data-c="${s0}"><b>${x.line}</b>${from > 0 ? "…" : ""}${seg(from, s0)}<mark>${seg(s0, e0)}</mark>${seg(e0, e0 + 60)}</div>`;
                  })
                  .join(""),
            )
            .join("");
  };
  const run = async () => {
    const cur = ctx.current();
    const ws = ctx.workspace();
    const roots =
      searchState.scope === "all"
        ? config.workspaces
        : searchState.scope === "workspace"
          ? ws ? [ws] : config.workspaces
          : cur?.project ? [cur.project] : ws ? [ws] : config.workspaces;
    searchState.error = "";
    try {
      searchState.hits = searchState.q ? await api.search(roots, searchState.q, searchState.regex, searchState.cs) : [];
    } catch (e) {
      searchState.error = String(e);
    }
    draw();
  };
  let timer = 0;
  input.addEventListener("input", () => {
    searchState.q = input.value;
    clearTimeout(timer);
    timer = window.setTimeout(run, 250);
  });
  el.onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-t],[data-s],[data-p]");
    if (!t) return;
    if (t.dataset.t === "cs") searchState.cs = !searchState.cs;
    else if (t.dataset.t === "regex") searchState.regex = !searchState.regex;
    else if (t.dataset.s) searchState.scope = t.dataset.s as typeof searchState.scope;
    else if (t.dataset.p) return void ctx.openFile(t.dataset.p, Number(t.dataset.l), Number(t.dataset.c));
    run();
  };
  draw();
  input.focus();
};

// ---------------- git ----------------
export const mountGit = async (el: HTMLElement, ctx: Ctx) => {
  const cur = ctx.current();
  const root = cur?.workspace ?? ctx.workspace();
  if (!root) {
    el.innerHTML = `<div class="hint">ワークスペースがありません。</div>`;
    return;
  }
  const git = (...args: string[]) => api.git(root, args);
  let selected: string | null = null;
  let msg = "";
  const render = async () => {
    const [st, br, log] = await Promise.all([git("status", "--porcelain=v1", "-uall"), git("branch", "--show-current"), git("log", "--oneline", "-15")]);
    if (st.code !== 0) {
      el.innerHTML = `<div class="sec"><div class="hint">${esc(basename(root))} は Git のリポジトリではありません。</div><span class="btn" data-a="init">git init</span></div>`;
      return;
    }
    const files = st.stdout.split("\n").filter(Boolean).map((l) => ({ st: l.slice(0, 2).trim(), path: l.slice(3) }));
    const diff = selected ? await git("diff", "HEAD", "--", selected) : null;
    el.innerHTML = `<div class="git">
      <div class="sec"><h5>${esc(basename(root))} <small>${icon("git-branch", 12)} ${esc(br.stdout.trim())}</small></h5>
        ${files.length ? files.map((f) => `<div class="file ${selected === f.path ? "on" : ""}" data-f="${esc(f.path)}">${icon("file-text", 13)}<span>${esc(f.path)}</span><span class="st">${esc(f.st)}</span></div>`).join("") : `<div class="muted">変更はありません</div>`}
        <textarea class="soft commitmsg" placeholder="コミットメッセージ">${esc(msg)}</textarea>
        <div class="row"><span class="btn pri" data-a="commit">コミット</span><span class="btn" data-a="push">push</span><span class="btn" data-a="pull">pull</span><span class="btn" data-a="refresh">${icon("refresh-cw", 12)}</span></div>
        ${diff ? `<pre>${esc(diff.stdout || "(差分なし。新しいファイルです)").split("\n").map((l) => (l.startsWith("+") && !l.startsWith("+++") ? `<span class="d-add">${l}</span>` : l.startsWith("-") && !l.startsWith("---") ? `<span class="d-del">${l}</span>` : l)).join("\n")}</pre>` : ""}
      </div>
      <div class="sec log"><h5>履歴</h5>${log.stdout.split("\n").filter(Boolean).map((l) => `<div><b>${esc(l.slice(0, 7))}</b>${esc(l.slice(8))}</div>`).join("")}</div></div>`;
  };
  el.oninput = (e) => {
    if ((e.target as HTMLElement).tagName === "TEXTAREA") msg = (e.target as HTMLTextAreaElement).value;
  };
  el.onclick = async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-a],[data-f]");
    if (!t) return;
    if (t.dataset.f) {
      selected = selected === t.dataset.f ? null : t.dataset.f;
      if (selected && /\.(gm|md|emet|toml|csv|tsv|svg|mmd|txt)$/.test(selected) && (e as MouseEvent).detail === 2)
        await ctx.openFile(`${root}/${selected}`);
    } else {
      const a = t.dataset.a;
      const out =
        a === "init" ? await git("init") :
        a === "commit" ? (msg.trim() ? (await git("add", "-A"), await git("commit", "-m", msg)) : null) :
        a === "push" ? await git("push") :
        a === "pull" ? await git("pull", "--no-rebase") : null;
      if (a === "commit" && !msg.trim()) ctx.toast("コミットメッセージを書いてください");
      if (out) {
        ctx.toast((out.stdout + out.stderr).trim().split("\n").slice(-3).join("\n") || "完了");
        if (a === "commit" && out.code === 0) msg = "";
        if (a === "commit") ctx.refreshMarks();
        await ctx.refreshTree();
        ctx.refreshRight();
      }
    }
    await render();
  };
  await render();
};

// ---------------- right panel: attachments ----------------
let meta: { root: string; data: MetaFile } | null = null;

export const mountAttachments = async (el: HTMLElement, ctx: Ctx, plot: PlotRow[], counts: { chars: number; sheets: number }) => {
  const cur = ctx.current();
  if (!cur) {
    el.innerHTML = `<div class="hint">シートを開くと、目標、キーワード、書くこと、ノートがここに出ます。</div>`;
    return;
  }
  const root = cur.project ?? cur.workspace ?? "";
  if (!meta || meta.root !== root) meta = { root, data: await loadMeta(root) };
  const key = rel(root, cur.path);
  const m = (meta.data[key] ??= { note: "", done: [] });
  const rows = cur.project ? rowsForFile(plot, cur.project, cur.path) : [];
  const planned = rows.reduce((a, r) => a + (Number(r.target) || 0), 0);
  const goal = m.goal ?? (planned || 0);
  const pct = goal ? Math.min(1, counts.chars / goal) : 0;
  const C = 2 * Math.PI * 18;
  const subs = [...new Set(plot.flatMap((r) => namesCell(r.subplots)))];
  const kws = [
    ...rows.flatMap((r) => namesCell(r.pov).map((v) => [`視点：${v}`, "#7c93b3"])),
    ...rows.flatMap((r) => namesCell(r.characters).map((v) => [v, "#7c93b3"])),
    ...rows.flatMap((r) => namesCell(r.place).map((v) => [v, "#8aa37f"])),
    ...rows.flatMap((r) => namesCell(r.subplots).map((v) => [v, subplotColor(subs, v)])),
  ].filter(([v], i, a) => a.findIndex(([w]) => w === v) === i);
  const musts = rows.flatMap((r) => listCell(r.must));
  const flavors = rows.flatMap((r) => listCell(r.flavor));
  const frags = rows.flatMap((r) => listCell(r.fragments));
  const memos = rows.map((r) => r.memo).filter(Boolean);
  el.innerHTML = `
    <div class="sec"><h5>目標 <small>${m.goal ? "手で決めた値" : planned ? "プロットの予定字数" : ""}</small></h5>
      <div class="goal">
        <svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--bg-3)" stroke-width="5"/><circle cx="22" cy="22" r="18" fill="none" stroke="var(--accent)" stroke-width="5" stroke-dasharray="${pct * C} ${C}" transform="rotate(-90 22 22)"/></svg>
        <div class="t"><b>${counts.chars.toLocaleString()}</b> / <input class="field" data-goal type="number" min="0" step="100" value="${goal || ""}" placeholder="—"> 字<br>${goal ? `残り ${Math.max(0, goal - counts.chars).toLocaleString()} 字 · ` : ""}原稿用紙 ${counts.sheets} 枚</div>
      </div></div>
    ${kws.length ? `<div class="sec"><h5>キーワード</h5><div class="kw">${kws.map(([v, c]) => `<span style="--c:${c}">${esc(v)}</span>`).join("")}</div></div>` : ""}
    ${
      musts.length || flavors.length
        ? `<div class="sec"><h5>書くこと <small>プロット ${rows.map((r) => esc(r.scene || "")).join("、")}</small></h5><div class="todo">${musts
            .map((x) => `<label class="${m.done.includes(x) ? "done" : ""}"><input type="checkbox" data-must="${esc(x)}" ${m.done.includes(x) ? "checked" : ""}>${esc(x)}</label>`)
            .join("")}</div>${flavors.length ? `<div class="flavor">フレーバー：${flavors.map(esc).join("、")}</div>` : ""}</div>`
        : ""
    }
    ${frags.length || memos.length ? `<div class="sec"><h5>プロットのメモと断片</h5>${memos.map((x) => `<div class="fragment" style="font-family:var(--ui);font-size:12.5px">${esc(x)}</div>`).join("")}${frags.map((x) => `<div class="fragment">${esc(x)}</div>`).join("")}</div>` : ""}
    <div class="sec"><h5>ノート</h5><textarea class="note" data-note placeholder="このシートのメモ">${esc(m.note)}</textarea></div>`;
  const persist = () => saveMeta(root, meta!.data);
  let t = 0;
  el.oninput = (e) => {
    const x = e.target as HTMLInputElement;
    if (x.dataset.note !== undefined) m.note = x.value;
    else if (x.dataset.goal !== undefined) m.goal = x.value ? Number(x.value) : undefined;
    else return;
    clearTimeout(t);
    t = window.setTimeout(persist, 400);
  };
  el.onchange = (e) => {
    const x = e.target as HTMLInputElement;
    if (x.dataset.must !== undefined) {
      m.done = x.checked ? [...m.done, x.dataset.must] : m.done.filter((d) => d !== x.dataset.must);
      persist();
      ctx.refreshRight();
    } else if (x.dataset.goal !== undefined) ctx.refreshRight();
  };
};

export const mountOutline = (el: HTMLElement, ctx: Ctx) => {
  const cur = ctx.current();
  if (!cur) return void (el.innerHTML = "");
  const heads =
    cur.kind === "gm"
      ? gmBlocks(cur.text).flatMap((b) => (b.kind === "h" ? [{ level: b.level, text: b.text, line: b.line }] : []))
      : cur.text.split("\n").flatMap((l, i) => {
          const m = /^(#{1,6})\s+(.*)/.exec(l);
          return m ? [{ level: m[1].length, text: m[2], line: i }] : [];
        });
  el.innerHTML = `<div class="sec"><h5>アウトライン</h5><div class="outline">${heads.map((x) => `<div data-l="${x.line + 1}" style="padding-left:${(x.level - 1) * 14 + 6}px">${esc(x.text)}</div>`).join("") || `<div class="muted">見出しがありません</div>`}</div></div>`;
  el.onclick = (e) => {
    const l = (e.target as HTMLElement).closest<HTMLElement>("[data-l]")?.dataset.l;
    if (l) ctx.openFile(cur.path, Number(l));
  };
};

export const mountLibrary = async (el: HTMLElement, ctx: Ctx) => {
  const cur = ctx.current();
  const project = cur?.project;
  if (!config.libraryDir) {
    el.innerHTML = `<div class="hint">設定で共有ライブラリのフォルダを決めると、そこの fonts/、plugins/（.wasm）、functions/（.emet）をプロジェクトに入れられます。</div>`;
    return;
  }
  if (!project) {
    el.innerHTML = `<div class="hint">Golem のプロジェクトのシートを開くと、共有ライブラリのプラグインと関数を入れられます。</div>
      <div class="sec"><div class="dropzone">.wasm、.emet、フォントのファイルをここにドロップすると、<br>共有ライブラリの plugins/、functions/、fonts/ にコピーします。</div></div>`;
    return;
  }
  const items = await libraryItems(project);
  const row = (it: (typeof items)[number]) =>
    `<div class="file" style="display:flex;gap:8px;align-items:center;padding:4px 0">${icon(it.kind === "plugin" ? "puzzle" : "sigma", 14)}<span style="flex:1">${esc(it.name)}</span>${
      it.state === "same" ? `<span class="muted" style="font-size:11.5px">入っています</span>` : `<span class="btn" data-i="${esc(it.from)}">${it.state === "changed" ? "更新" : "入れる"}</span>`
    }</div>`;
  const plugins = items.filter((i) => i.kind === "plugin");
  const fns = items.filter((i) => i.kind === "function");
  el.innerHTML = `<div class="sec"><h5>プラグイン <small>plugins/*.wasm</small></h5>${plugins.map(row).join("") || `<div class="muted">ありません</div>`}</div>
    <div class="sec"><h5>関数 <small>functions/*.emet</small></h5>${fns.map(row).join("") || `<div class="muted">ありません</div>`}
    <div class="muted" style="font-size:11.5px;margin-top:8px">.gm からは <code>@import functions/名前.emet as 名前</code> で使います。</div></div>
    <div class="sec"><h5>フォント</h5><div class="muted" style="font-size:12px">style.toml が指すフォントは、プロジェクトを開いたときに fonts/ にコピーします。</div></div>
    <div class="sec"><div class="dropzone">.wasm、.emet、フォントのファイルをここにドロップすると、<br>共有ライブラリの plugins/、functions/、fonts/ にコピーします。</div></div>`;
  el.onclick = async (e) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
    const it = items.find((i) => i.from === from);
    if (!it) return;
    await installItem(project, it);
    ctx.toast(`${it.name} を入れました${it.kind === "plugin" ? "（manifest.toml に宣言を足しました）" : ""}`);
    await ctx.refreshTree();
    await mountLibrary(el, ctx);
  };
};

// ---------------- diagnostics of golem check, lint and preflight (left panel) ----------------
type GolemDiag = {
  code: string;
  severity: "error" | "warning" | "notice" | "info";
  span?: { file: string; line: number; column: number };
  message: string;
  facts?: Record<string, string>;
};
const diagState = { project: "", kind: "check" as "check" | "lint" | "preflight", running: false, results: new Map<string, { at: string; items: GolemDiag[]; log: string }>() };

export const mountDiagnostics = async (el: HTMLElement, ctx: Ctx) => {
  const projects = await allProjects();
  if (!projects.length) {
    el.innerHTML = `<div class="hint">Golem のプロジェクトがありません。</div>`;
    return;
  }
  const cur = ctx.current()?.project;
  if (!projects.includes(diagState.project)) diagState.project = cur && projects.includes(cur) ? cur : projects[0];
  const key = () => `${diagState.project}\n${diagState.kind}`;
  const sev = { error: ["circle-x", "エラー"], warning: ["triangle-alert", "警告"], notice: ["info", "お知らせ"], info: ["info", "情報"] } as const;
  const render = () => {
    const r = diagState.results.get(key());
    const groups = new Map<string, GolemDiag[]>();
    r?.items.forEach((d) => groups.set(d.span?.file ?? "", [...(groups.get(d.span?.file ?? "") ?? []), d]));
    const count = (k: string) => r?.items.filter((d) => d.severity === k).length ?? 0;
    el.innerHTML = `<div class="diag">
      <select class="field diagproj">${projects.map((p) => `<option value="${esc(p)}" ${p === diagState.project ? "selected" : ""}>${esc(basename(p))}</option>`).join("")}</select>
      <div class="seg diagkind">${(["check", "lint", "preflight"] as const).map((k) => `<span data-k="${k}" class="${diagState.kind === k ? "on" : ""}">${k}</span>`).join("")}</div>
      <div class="diagbar"><span class="btn" data-run>${diagState.running ? "実行中…" : "実行"}</span><span class="muted">${
        r ? `${r.at} · エラー ${count("error")} · 警告 ${count("warning")}${count("notice") ? ` · お知らせ ${count("notice")}` : ""}` : { check: "出力を書かずに検査する", lint: "lint の規則を当てる", preflight: "入稿の前に PDF を検査する（preflight.toml）" }[diagState.kind]
      }</span></div>
      <div class="diaglist">${
        !r
          ? ""
          : !r.items.length
            ? r.log
              ? `<pre class="error">${esc(r.log)}</pre>`
              : `<div class="hint">問題はありません。</div>`
            : [...groups]
                .map(
                  ([f, ds]) =>
                    `<div class="f">${icon("file-text", 13)}${esc(f || "（プロジェクト）")}<small>${ds.length}</small></div>` +
                    ds
                      .map(
                        (d) =>
                          `<div class="d sev-${d.severity}" ${d.span ? `data-f="${esc(d.span.file)}" data-l="${d.span.line}" data-c="${d.span.column}"` : ""}>${icon(sev[d.severity]?.[0] ?? "info", 13)}<div><div class="m">${esc(d.message)}</div><div class="meta">${esc(d.code)}${d.span ? ` · ${d.span.line} 行 ${d.span.column} 列` : ""}${d.facts ? ` · ${esc(Object.entries(d.facts).map(([k, v]) => `${k}: ${v}`).join("、"))}` : ""}</div></div></div>`,
                      )
                      .join(""),
                )
                .join("")
      }</div></div>`;
  };
  const run = async () => {
    diagState.running = true;
    render();
    const args = diagState.kind === "preflight" ? ["preflight", "--format", "json"] : [diagState.kind, "--format", "json", "-v"];
    const out = await api.tool("golem", bin("golem"), diagState.project, args).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
    // check and lint write the JSON to stdout, preflight to stderr: take whichever parses
    const parse = (t: string): GolemDiag[] | null => {
      try {
        const v = JSON.parse(t.trim());
        return Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    };
    const parsed = parse(out.stdout) ?? parse(out.stderr);
    let items: GolemDiag[] = parsed ?? [];
    let log = parsed ? "" : (out.stdout + out.stderr).trim();
    if (!items.length && out.code !== 0 && !log) log = out.stderr.trim();
    const order = { error: 0, warning: 1, notice: 2, info: 3 };
    items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || (a.span?.file ?? "").localeCompare(b.span?.file ?? "") || (a.span?.line ?? 0) - (b.span?.line ?? 0));
    diagState.results.set(key(), { at: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }), items, log });
    diagState.running = false;
    render();
  };
  el.onchange = (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.classList.contains("diagproj")) {
      diagState.project = t.value;
      render();
    }
  };
  el.onclick = (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-k],[data-run],[data-f]");
    if (!t) return;
    if (t.dataset.k) {
      diagState.kind = t.dataset.k as typeof diagState.kind;
      render();
      if (!diagState.results.has(key())) run();
    } else if (t.dataset.run !== undefined && !diagState.running) run();
    else if (t.dataset.f) {
      const path = `${diagState.project}/${t.dataset.f}`;
      if (/\.(gm|emet|toml|md|csv|tsv|svg)$/.test(path)) ctx.openFile(path, Number(t.dataset.l), Math.max(0, Number(t.dataset.c) - 1));
    }
  };
  render();
  if (!diagState.results.has(key())) run();
};

// ---------------- the shared library across every project (left panel) ----------------
export const mountLibraryAll = async (el: HTMLElement, ctx: Ctx) => {
  if (!config.libraryDir) {
    el.innerHTML = `<div class="hint">設定の「共有ライブラリ」でフォルダを決めると、フォント、プラグイン、関数をすべてのプロジェクトにまたがって管理できます。</div>`;
    return;
  }
  el.innerHTML = `<div class="hint">読んでいます…</div>`;
  const [files, projects] = await Promise.all([libraryFiles(), allProjects()]);
  const states = await Promise.all(files.map(async (f) => ({ f, items: await Promise.all(projects.map((p) => itemIn(p, f))) })));
  const label = { font: ["フォント", "type"], plugin: ["プラグイン", "puzzle"], function: ["関数", "sigma"] } as const;
  const projName = (p: string) => {
    const ws = config.workspaces.find((w) => p.startsWith(w + "/"));
    return config.workspaces.length > 1 && ws ? `${basename(ws)} / ${basename(p)}` : basename(p);
  };
  const mark = { same: ["check", "入っている"], changed: ["refresh-cw", "ライブラリの方が新しい（押すと更新）"], absent: ["plus", "入っていない（押すと入れる）"] } as const;
  el.innerHTML =
    (["font", "plugin", "function"] as const)
      .map((k) => {
        const rows = states.filter((x) => x.f.kind === k);
        return `<div class="libsec"><div class="libh">${icon(label[k][1], 13)}${label[k][0]}<small>${rows.length}</small></div>${
          rows
            .map(({ f, items }) => {
              const missing = items.filter((i) => i.state !== "same").length;
              return `<div class="libitem"><div class="libname" title="${esc(f.from)}">${esc(f.name)}${missing ? `<span class="btn tiny" data-all="${esc(f.from)}">すべてに${items.some((i) => i.state === "changed") ? "入れる・更新" : "入れる"}</span>` : ""}</div>
                ${items.map((i, n) => `<div class="libproj ${i.state}" ${i.state === "same" ? "" : `data-one="${esc(f.from)}" data-p="${esc(projects[n])}"`} title="${mark[i.state][1]}">${icon(mark[i.state][0], 12)}<span>${esc(projName(projects[n]))}</span></div>`).join("")}</div>`;
            })
            .join("") || `<div class="muted libempty">ありません</div>`
        }</div>`;
      })
      .join("") +
    `<div class="libsec"><div class="dropzone">.wasm、.emet、フォントをここにドロップすると<br>共有ライブラリにコピーします</div>
     <div class="muted libnote">${esc(config.libraryDir)}<br>プロジェクトにはコピーして入れます。プラグインは manifest.toml に宣言も足します。</div></div>`;
  el.onclick = async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-all],[data-one]");
    if (!t) return;
    const target = states.find((x) => x.f.from === (t.dataset.all ?? t.dataset.one));
    if (!target) return;
    const todo = t.dataset.all ? target.items.filter((i) => i.state !== "same") : target.items.filter((i) => i.to.startsWith(t.dataset.p! + "/"));
    for (const i of todo) await installItem(i.to.slice(0, i.to.length - i.to.split("/").slice(-2).join("/").length - 1), i);
    ctx.toast(`${target.f.name} を ${todo.length} 件のプロジェクトに入れました`);
    await ctx.refreshTree();
    await mountLibraryAll(el, ctx);
  };
};

/** Copies dropped files into the library by kind; returns what was copied where. */
export const dropIntoLibrary = async (paths: string[]) => {
  const sub = (p: string) =>
    /\.wasm$/i.test(p) ? "plugins" : /\.emet$/i.test(p) ? "functions" : /\.(otf|ttf|ttc|woff2?)$/i.test(p) || /^LICENSE/i.test(basename(p)) ? "fonts" : null;
  const done: string[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    const s = sub(p);
    if (!s) {
      skipped.push(basename(p));
      continue;
    }
    await api.copyFile(p, `${config.libraryDir}/${s}/${basename(p)}`);
    done.push(`${s}/${basename(p)}`);
  }
  return { done, skipped };
};

// ---------------- settings ----------------
export const openSettings = async (ctx: Ctx) => {
  const versions = await Promise.all([
    api.toolVersion("golem", config.golemPath || undefined).catch((e) => `見つかりません（${e}）`),
    api.toolVersion("shem", config.shemPath || undefined).catch((e) => `見つかりません（${e}）`),
  ]);
  const pluginsDir = await api.pluginsDir();
  const dim = h(`<div class="dim"></div>`);
  const section = { v: "general" };
  const pick = async (dir: boolean) => (await openDialog({ directory: dir, multiple: false })) as string | null;
  const render = () => {
    dim.innerHTML = `<div class="modal">
      <div class="mnav">
        <h6>オプション</h6>
        ${[["general", "一般"], ["editor", "エディタと統計"], ["tools", "Golem と shem"], ["library", "共有ライブラリ"], ["workspaces", "ワークスペース"], ["plugins", "Aleph のプラグイン"]].map(([k, l]) => `<div data-sec="${k}" class="${section.v === k ? "on" : ""}">${l}</div>`).join("")}
      </div>
      <div class="mbody"><span class="iconbtn close" data-close>${icon("x")}</span>
        <div style="display:flex;gap:14px;align-items:center;margin-bottom:18px"><img class="app-ico" src="/icon.svg"><div><h2>Aleph</h2><small class="muted">0.0.0-prototype</small></div></div>
        ${
          section.v === "general"
            ? `<div class="item"><div class="d"><div>外観</div><small>システムに合わせるか、固定するか</small></div>${(["light", "dark", "auto"] as const).map((t) => `<span class="btn ${config.theme === t ? "pri" : ""}" data-theme="${t}">${{ light: "ライト", dark: "ダーク", auto: "自動" }[t]}</span>`).join("")}</div>
               <div class="item"><div class="d"><div>保存したらページを組みなおす</div><small>golem build --target pdf のあと shem でページを描く</small></div><span class="toggle ${config.rebuildOnSave ? "on" : ""}" data-toggle="rebuildOnSave"></span></div>
               <div class="item"><div class="d"><div>1 日 1 回自動でコミットする</div><small>ワークスペースに変更があれば git add -A して「Autosave 日付」でコミットする。手動では Git のパネルか ⌘⇧K</small></div><span class="toggle ${config.autoCommit ? "on" : ""}" data-toggle="autoCommit"></span></div>
               <div class="item"><div class="d"><div>ページの解像度</div><small>shem render --dpi。空なら自動（枠の幅、画面の倍率、拡大率、判型から決める）</small></div><input class="field num" type="number" min="0" data-num="dpi" value="${config.dpi || ""}" placeholder="自動"> dpi</div>`
            : section.v === "editor"
              ? `<div class="item"><div class="d"><div>1 行の字数</div><small>空なら style.toml の [page.grid] characters</small></div><input class="field num" type="number" data-num="charsOverride" value="${config.charsOverride ?? ""}" placeholder="—"></div>
                 <div class="item"><div class="d"><div>本文の文字サイズ</div><small>gm、md、txt のエディタ、縦書き、本文のプレビュー（既定 16 px）</small></div><input class="field num" type="number" min="10" max="32" data-num="fontSize" value="${config.fontSize}"> px</div>
                 <div class="item"><div class="d"><div>コードの文字サイズ</div><small>toml、emet などのエディタ（既定 13 px）。gm の中の命令と式は本文の大きさに合わせて少し小さくする</small></div><input class="field num" type="number" min="9" max="28" data-num="codeFontSize" value="${config.codeFontSize}"> px</div>
                 <div class="item"><div class="d"><div>行間</div><small>文字の大きさに対する行の高さ（既定 1.75）。エディタ、縦書き、本文のプレビューに効く</small></div><input class="field num" type="number" step="0.05" min="1" max="3" data-num="lineHeight" value="${config.lineHeight}"></div>
                 <div class="item"><div class="d"><div>自動保存の間隔</div><small>変更があれば、この秒数ごとに保存する。⌘S ですぐ保存する</small></div><input class="field num" type="number" min="2" data-num="autosaveSeconds" value="${config.autosaveSeconds}"> 秒</div>
                 <div class="item"><div class="d"><div>⌘S で整形する</div><small>gm と emet を LSP で整形してから保存する。10 秒ごとの自動保存では整形しない。⌥⇧F で整形だけする</small></div><span class="toggle ${config.formatOnSave ? "on" : ""}" data-toggle="formatOnSave"></span></div>
                                  <div class="item"><div class="d"><div>不可視文字を表示</div><small>半角スペース ·、全角スペース □、タブ →、改行 ↵。ゼロ幅の文字などはいつも表示する</small></div><span class="toggle ${config.showInvisibles ? "on" : ""}" data-toggle="showInvisibles"></span></div>
                 <div class="item"><div class="d"><div>原稿用紙の換算</div><small>字 × 行。段落ごとに行を改めて数える</small></div><input class="field num" type="number" data-ms="cols" value="${config.manuscript.cols}"> × <input class="field num" type="number" data-ms="rows" value="${config.manuscript.rows}"></div>`
              : section.v === "tools"
                ? `<div class="item"><div class="d"><div>Golem のバイナリ</div><small>${esc(versions[0])}<br>空なら同梱のもの、~/.local/bin、PATH の順に探す</small></div><input class="field" data-str="golemPath" value="${esc(config.golemPath)}" placeholder="同梱"><span class="btn" data-pick="golemPath">選ぶ</span></div>
                   <div class="item"><div class="d"><div>shem のバイナリ</div><small>${esc(versions[1])}<br>ページのプレビューで PDF を PNG にする</small></div><input class="field" data-str="shemPath" value="${esc(config.shemPath)}" placeholder="同梱"><span class="btn" data-pick="shemPath">選ぶ</span></div>`
                : section.v === "library"
                  ? `<div class="item"><div class="d"><div>共有ライブラリのフォルダ</div><small>fonts/、plugins/（.wasm）、functions/（.emet）を置く。プロジェクトにはコピーして入れる</small></div><input class="field" data-str="libraryDir" value="${esc(config.libraryDir)}"><span class="btn" data-pick-dir="libraryDir">選ぶ</span></div>
                     <div class="item"><div class="d"><div>フォルダを作る</div><small>fonts、plugins、functions のサブフォルダを作る</small></div><span class="btn" data-mklib>作る</span></div>`
                  : section.v === "workspaces"
                    ? `${config.workspaces.map((w, i) => `<div class="item"><div class="d"><div>${esc(basename(w))}</div><small>${esc(w)}</small></div><span class="btn" data-rmws="${i}">外す</span></div>`).join("")}
                       <div class="item"><div class="d"><div>ワークスペースを足す</div><small>Git のリポジトリを一つのワークスペースとし、プロジェクトをサブディレクトリに置く</small></div><span class="btn" data-addws>フォルダを選ぶ</span></div>`
                    : `<div class="item"><div class="d"><div>プラグインのフォルダ</div><small>${esc(pluginsDir)}<br>*.js を置き、export function activate(aleph) を書く</small></div></div>
                       ${config.plugins.map((p) => `<div class="item"><div class="d"><div>${esc(p)}</div></div></div>`).join("")}`
        }
      </div></div>`;
  };
  dim.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t === dim || t.closest("[data-close]")) {
      dim.remove();
      await ctx.afterConfig();
      return;
    }
    const d = t.closest<HTMLElement>("[data-sec],[data-theme],[data-toggle],[data-pick],[data-pick-dir],[data-addws],[data-rmws],[data-mklib]")?.dataset;
    if (!d) return;
    if (d.sec) section.v = d.sec;
    if (d.theme) config.theme = d.theme as typeof config.theme;
    if (d.toggle) (config as unknown as Record<string, boolean>)[d.toggle] = !(config as unknown as Record<string, boolean>)[d.toggle];
    if (d.pick) {
      const p = await pick(false);
      if (p) (config as unknown as Record<string, string>)[d.pick] = p;
    }
    if (d.pickDir) {
      const p = await pick(true);
      if (p) (config as unknown as Record<string, string>)[d.pickDir] = p;
    }
    if (d.addws !== undefined) {
      const p = await pick(true);
      if (p && !config.workspaces.includes(p)) config.workspaces.push(p);
    }
    if (d.rmws) config.workspaces.splice(Number(d.rmws), 1);
    if (d.mklib !== undefined && config.libraryDir) {
      for (const s of ["fonts", "plugins", "functions"]) await api.makeDir(`${config.libraryDir}/${s}`);
      ctx.toast("作りました");
    }
    await saveConfig();
    render();
  });
  dim.addEventListener("change", async (e) => {
    const x = e.target as HTMLInputElement;
    if (x.dataset.str) (config as unknown as Record<string, string>)[x.dataset.str] = x.value.trim();
    if (x.dataset.num) (config as unknown as Record<string, number | null>)[x.dataset.num] = x.value ? Number(x.value) : ({ lineHeight: 1.75, fontSize: 16, codeFontSize: 13, dpi: 0 } as Record<string, number>)[x.dataset.num] ?? null;
    if (x.dataset.ms) config.manuscript[x.dataset.ms as "cols" | "rows"] = Number(x.value) || 20;
    await saveConfig();
  });
  render();
  document.body.append(dim);
};

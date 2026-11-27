// The assistant's tab of the bottom panel (docs/adr/0081, 下部パネルのタブ): the request field (⌘↩
// sends), the target (the selection of the focused sheet, or the whole sheet), the connector and the
// send button, and the history of requests and answers, kept until Aleph quits and never written to
// files. An answer shows its explanation, the changed lines, 「適用」 and 「捨てる」, and the connector,
// the model and the time it took. 「適用」 runs the step of docs/adr/0088 before changing the editor;
// nothing touches the sheet or its file before it (I4).
import { api, type Answered, type ConnectorId, type ConnectorInfo } from "../api.ts";
import { addCommands } from "../commands.ts";
import type { Ctx } from "../ctx.ts";
import { prepareApply } from "../difftab/mount.ts";
import { esc } from "../esc.ts";
import { icon } from "../icons.ts";
import { allDocs, focused, type Doc } from "../store.ts";
import { gitOperation } from "../git-ipc.ts";
import { displayedSections } from "../ui/copy-displayed-text.ts";
import { copyText } from "../ui/notices.ts";
import { applyAnswer, assistantChange } from "./applyflow.ts";
import { applyEdits, type Scope } from "./edits.ts";
import { manifestChapters } from "../manifest.ts";
import { rel, within } from "../path.ts";
import { parseManuscriptAnswer, rangeLabel, runManuscript } from "./manuscript.ts";
import { chapterFor, rankSections, splitSections, terms, type Section } from "./material.ts";
import { connectorsRevoked } from "./models.ts";
import { commandList, messages } from "./prompt.ts";
import { askChecked, checkDiagnostics, checkedFile, type Outcome } from "./request.ts";
import { connectorChoices, isSendKey, lineDiff, promptFile, seconds, targetLabel, targetOf, targetText, type DiffLine } from "./tab.ts";

type Entry = {
  id: number;
  request: string;
  path: string;
  file: string;
  target: string;
  scope: Scope;
  /** The sheet's text at the request: the diff is shown against it. */
  sheet: string;
  connector: ConnectorId;
  state: "asking" | "failed" | "answered" | "applying" | "applied" | "discarded";
  error: string;
  outcome: Outcome<Answered> | null;
  /** Why 「適用」 did not apply, shown under the buttons. */
  note: string;
  requireVersion?: boolean;
};

/** The history of this run of Aleph; not written to files. */
const history: Entry[] = [];
let seq = 1;
let chosen: ConnectorId = "local";
let wholeManuscript = false;
let connectors: ConnectorInfo[] = [];
let root: HTMLElement | null = null;

/** The chapters of the manual, split into sections once; none when the chapter is not bundled. */
const chapters = new Map<string, Promise<Section[]>>();
const sectionsOf = (chapter: string) => {
  const hit = chapters.get(chapter);
  if (hit) return hit;
  const p = api.assistantManual(chapter).then(splitSections, () => []);
  chapters.set(chapter, p);
  return p;
};

const materialOf = async (ctx: Ctx, request: string, file: string, target: string) => {
  const chapter = chapterFor(file);
  const sections = chapter ? await sectionsOf(chapter) : [];
  const commands = ctx.commands.map((c) => ({ id: c.id, label: c.label }));
  return [commandList(commands), ...rankSections(sections, terms(request, target)).map((section) => section.text)];
};

const connectorName = (id: ConnectorId) => connectors.find((c) => c.id === id)?.name ?? (id === "local" ? "ローカル" : id === "claude" ? "Claude Code" : "Codex");

const loadConnectors = async () => {
  connectors = await api.assistantConnectors().catch(() => []);
  if (!connectorChoices(connectors).some((c) => c.id === chosen)) chosen = "local";
  drawForm();
};

/** The focused sheet of the selected tab, its editor and the target now; null when it is not a text sheet. */
const current = (ctx: Ctx) => {
  const doc = focused(ctx.store.get());
  const ed = doc && ctx.editors.get(doc.path);
  if (!doc || !ed?.edit) return null;
  const sheet = ed.text();
  return { doc, sheet, target: targetOf(doc.path, sheet, ed.edit.core.range()) };
};

const diffHtml = (lines: DiffLine[]) =>
  `<pre class="as-diff" data-response-text>${lines.map((l) => (l.op === "…" ? `<span class="d-gap">…</span>` : `<span class="${l.op === "+" ? "d-add" : l.op === "-" ? "d-del" : ""}">${esc(l.op + l.text)}</span>`)).join("\n")}</pre>`;

const copyAnswerButton = '<button type="button" class="btn small copy-text" data-copy-answer>応答をコピー</button>';

const checkHtml = (o: Outcome<Answered>) => {
  const c = o.check;
  if (!c) return "";
  if ("failed" in c) return `<div class="as-note muted" data-response-text>${esc(c.failed)}</div>`;
  if (c.after > c.before)
    return `<div class="as-note as-warn" data-response-text>${icon("triangle-alert", 12)}golem check のエラーが ${c.before} から ${c.after} に増えます${c.retried ? "（一度頼み直した後）" : ""}。<ul>${c.added
      .map((d) => `<li>${d.span ? `${d.span.line} 行：` : ""}${esc(d.message)}<small>${esc(d.code)}</small></li>`)
      .join("")}</ul></div>`;
  return c.retried ? `<div class="as-note muted" data-response-text>golem check のエラーが増えたので、一度頼み直しました。</div>` : "";
};

const answerHtml = (e: Entry) => {
  const o = e.outcome!;
  const a = o.answered;
  const fallback = a.fallbackReason ? `<div class="as-note muted" data-response-text>${esc(connectorName(a.fallbackReason.from))} で答えられなかったので、ローカルで頼み直しました（${esc(a.fallbackReason.message)}）。</div>` : "";
  const explanation = o.answer?.explanation.trim() ? `<div class="as-expl" data-response-text>${esc(o.answer.explanation)}</div>` : "";
  const reason = o.reason ? `<div class="as-note as-warn" data-response-text>${icon("triangle-alert", 12)}この案は当てられません：${esc(o.reason)}</div>` : "";
  const diff = o.after !== null && e.state !== "discarded" ? diffHtml(lineDiff(e.sheet, o.after)) : "";
  const buttons =
    o.after !== null && (e.state === "answered" || e.state === "applying")
      ? `<div class="row as-btns"><span class="btn pri${e.state === "applying" ? " off" : ""}" data-apply="${e.id}">適用</span><span class="btn" data-discard="${e.id}">捨てる</span></div>`
      : "";
  const done = e.state === "applied" ? `<div class="as-note muted">適用しました。</div>` : e.state === "discarded" ? `<div class="as-note muted">捨てました。</div>` : "";
  const note = e.note ? `<div class="as-note as-warn" data-response-text>${esc(e.note)}</div>` : "";
  const meta = `<small class="as-meta">${esc(connectorName(a.connector))}${a.model ? ` · ${esc(a.model)}` : ""} · ${seconds(a.ms)}</small>`;
  const content = explanation + fallback + reason + checkHtml(o) + diff;
  return content + buttons + done + note + meta + (content || note ? `<div class="as-btns">${copyAnswerButton}</div>` : "");
};

const entryHtml = (e: Entry) =>
  `<div class="as-entry" data-e="${e.id}"><div class="as-req"><div class="as-text">${esc(e.request)}</div><small>${esc(e.file)} · ${esc(e.target)} · ${esc(connectorName(e.connector))}</small></div><div class="as-ans">${
    e.state === "asking"
      ? `<div class="muted">${esc(e.note || "答えを待っています…")}</div>`
      : e.state === "failed"
        ? `<div class="as-note as-warn" data-response-text>${icon("circle-x", 12)}${esc(e.error)}</div>${e.error.trim() ? `<div class="as-btns">${copyAnswerButton}</div>` : ""}`
        : answerHtml(e)
  }</div></div>`;

const drawHistory = () => {
  const el = root?.querySelector<HTMLElement>(".as-history");
  if (!el) return;
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.innerHTML = history.length ? history.map(entryHtml).join("") : `<div class="empty">頼みを書いて送ると、書き換えの案と説明が出ます。</div>`;
  if (stick) el.scrollTop = el.scrollHeight;
};

let currentCtx: Ctx | null = null;

const drawTarget = () => {
  const el = root?.querySelector<HTMLElement>(".as-target");
  if (!el || !currentCtx) return;
  const c = current(currentCtx);
  const text = c ? wholeManuscript ? "対象：原稿全体" : `対象：${promptFile(c.doc.path, c.doc.project, c.doc.workspace)} の${targetLabel(c.target)}` : "対象：テキストのシートを開いてください";
  if (el.textContent !== text) el.textContent = text;
};

const drawForm = () => {
  const sel = root?.querySelector<HTMLSelectElement>("[data-connector]");
  if (!sel) return;
  sel.innerHTML = connectorChoices(connectors)
    .map((c) => `<option value="${c.id}" ${c.id === chosen ? "selected" : ""}>${esc(c.name)}${c.approved ? "" : "（初めて使うときに承認を求めます）"}</option>`)
    .join("");
  drawTarget();
};

const answerForManuscript = async (ctx: Ctx, entry: Entry, doc: Doc) => {
  const loaded = new Map(allDocs(ctx.store.get()).map((sheet) => [sheet.path, ctx.editors.get(sheet.path)?.text() ?? sheet.text]));
  let paths = [doc.path];
  if (doc.project) {
    const project = doc.project;
    const chapterNames = manifestChapters(loaded.get(`${project}/manifest.toml`) ?? await api.readText(`${project}/manifest.toml`));
    paths = [...new Set(chapterNames.map((name) => {
      const path = within(project, project, name);
      if (!path) throw new Error(`プロジェクト内の章を指定してください。 ${name}`);
      return path;
    }))];
    if (!paths.length) throw new Error("マニフェストに章がありません");
  }
  const fileToPath = new Map(paths.map((path) => [doc.project ? rel(doc.project, path) : entry.file, path]));
  const unavailable: string[] = [];
  const candidates = await Promise.all([...fileToPath].map(async ([file, path]) => {
    try { return { file, text: loaded.get(path) ?? await api.readText(path) }; }
    catch (error) { return { file, error: String(error) }; }
  }));
  const chapters = candidates.flatMap((chapter) => {
    if (chapter.text !== undefined) return [{ file: chapter.file, text: chapter.text }];
    unavailable.push(`${chapter.file} を読めません。 ${chapter.error}`);
    return [];
  });
  if (!chapters.length) throw new Error(unavailable.join("\n"));
  const started = performance.now();
  let answered: Answered | undefined;
  const result = await runManuscript(chapters, async (ranges, reconciliation) => {
    const file = ranges[0]?.file ?? chapters[0].file;
    const body = reconciliation
      ? JSON.stringify(reconciliation.map((finding) => ({ ranges: finding.ranges.map(({ file, from, to }) => ({ file, from, to })), explanation: finding.explanation, edits: finding.edits })))
      : ranges.map((chapter) => `章 ${JSON.stringify(chapter.file)}\n${chapter.text}`).join("\n\n");
    const request = reconciliation ? `${entry.request}\n章ごとの結果を照合し、章をまたぐ違いと比較できた範囲を説明してください。元の原稿にあったと確かめられない文字の編集案は出さないでください。` : entry.request;
    const prompt = messages("", request, file, body);
    prompt[0].content += "\n\n原稿の各章は、章のパスと本文で示す。編集案では file、find、replace を返し、file には対象の章のパスをそのまま書く。";
    const answer = await api.assistantAsk(entry.connector, prompt, await materialOf(ctx, request, file, body), true);
    const parsed = parseManuscriptAnswer(answer.answer);
    answered = answer;
    return parsed;
  }, (note) => { entry.note = note; drawHistory(); });
  const explanation = [
    ...result.splitReasons.map((reason) => `分割した理由 ${reason}`),
    result.reconciliation,
    ...result.findings.map(({ ranges, explanation }) => `${ranges.map(rangeLabel).join("、")}\n${explanation}`),
    ...result.failed.map(({ range, reason }) => `未処理 ${rangeLabel(range)}。 ${reason}`),
    ...unavailable,
    ...result.rejected,
  ].filter(Boolean).join("\n\n");
  if (!answered) throw new Error(explanation);
  const base = { ...answered, ms: Math.round(performance.now() - started) };
  entry.outcome = { answered: base, answer: { explanation, edits: [] }, after: null, reason: null, check: null };
  entry.note = "";
  const childEntries = result.chapters.flatMap((chapter): Entry[] => {
    if (!chapter.edits.length) return [];
    const after = applyEdits(chapter.text, chapter.edits);
    const path = fileToPath.get(chapter.file);
    if (!after.ok || !path || after.text === chapter.text) return [];
    const outcome: Outcome<Answered> = { answered: base, answer: { explanation: "", edits: chapter.edits }, after: after.text, reason: null, check: null };
    return [{ ...entry, id: seq++, path, file: chapter.file, target: "原稿全体からの編集案", scope: { kind: "sheet" }, sheet: chapter.text, state: "answered", outcome, requireVersion: true }];
  });
  history.splice(history.indexOf(entry) + 1, 0, ...childEntries);
};

const send = async (ctx: Ctx) => {
  const field = root?.querySelector<HTMLTextAreaElement>("textarea");
  const request = field?.value.trim() ?? "";
  if (!field || request === "") return;
  const c = current(ctx);
  if (!c) return void ctx.toast("テキストのシートを開いてから頼んでください");
  const { doc, sheet, target } = c;
  const file = promptFile(doc.path, doc.project, doc.workspace);
  const whole = wholeManuscript;
  const e: Entry = { id: seq++, request, path: doc.path, file, target: whole ? "原稿全体" : targetLabel(target), scope: target.scope, sheet, connector: chosen, state: "asking", error: "", outcome: null, note: "" };
  history.push(e);
  field.value = "";
  drawHistory();
  const connector = chosen;
  const project = doc.project;
  try {
    if (whole) await answerForManuscript(ctx, e, doc);
    else e.outcome = await askChecked({
      ask: async (r) => {
        const body = targetText(target, sheet);
        return api.assistantAsk(connector, messages("", r, file, body), await materialOf(ctx, r, file, body));
      },
      request,
      sheet,
      target,
      file: checkedFile(doc),
      check: async (texts) => (project ? api.assistantGolemCheck(project, doc.path, texts).then((outs) => outs.map(checkDiagnostics), () => texts.map(() => null)) : texts.map(() => null)),
    });
    e.state = "answered";
  } catch (err) {
    e.state = "failed";
    e.error = String(err);
  }
  drawHistory();
  // the approval of Claude Code or Codex may have changed
  void loadConnectors();
};

/** Whether the diff tab can show the edit: Git can be used and the workspace is a repository (docs/adr/0088). */
const repoNow = async (ctx: Ctx) => {
  const ws = ctx.store.get().workspace;
  return !!ws && !!(await gitOperation(ws, "repository", {}).catch(() => null));
};

const apply = async (ctx: Ctx, e: Entry) => {
  const edits = e.outcome?.answer?.edits ?? [];
  const doc = (): Doc | undefined => allDocs(ctx.store.get()).find((d) => d.path === e.path);
  const editor = () => ctx.editors.get(e.path);
  if (e.requireVersion && !editor()?.edit) {
    try { await ctx.open([e.path]); }
    catch (error) { e.note = String(error); return drawHistory(); }
  }
  if (!doc() || !editor()?.edit) {
    e.note = "このシートは開いていません。開いてから「適用」を押してください。";
    return drawHistory();
  }
  e.state = "applying";
  e.note = "";
  drawHistory();
  const r = await applyAnswer(
    {
      text: () => editor()?.text() ?? "",
      matchesVersion: e.requireVersion ? (text) => text === e.sheet : undefined,
      prepare: (applicable) => prepareApply(ctx, doc()!, applicable),
      change: (before, after) => editor()?.edit?.apply(assistantChange(before, after), "assistant"),
      save: async () => (await ctx.save([e.path])).has(e.path),
      diffAvailable: () => repoNow(ctx),
      showDiff: () => ctx.store.dispatch({ type: "showDiffAfterApply" }),
    },
    e.scope,
    edits,
  ).catch((err) => ({ kind: "unapplicable" as const, reason: String(err) }));
  e.state = r.kind === "applied" ? "applied" : "answered";
  e.note = r.kind === "unapplicable" ? `当てられません：${r.reason}` : "";
  drawHistory();
};

const build = (ctx: Ctx) => {
  const el = document.createElement("div");
  el.className = "assistant";
  el.innerHTML = `<div class="as-history"></div>
    <div class="as-form">
      <div class="as-target muted"></div>
      <textarea class="field wide" rows="3" placeholder="頼みを書く（⌘↩ で送る）"></textarea>
      <div class="row"><select class="field" data-assistant-target aria-label="対象"><option value="sheet">選択中のシート</option><option value="manuscript">原稿全体</option></select><span class="muted">コネクタ</span><select class="field" data-connector title="コネクタ"></select><span class="grow"></span><span class="btn pri" data-send title="送る（⌘↩）">送る</span></div>
    </div>`;
  const field = el.querySelector("textarea")!;
  field.addEventListener("keydown", (k) => {
    if (!isSendKey(k)) return;
    k.preventDefault();
    k.stopPropagation();
    void send(ctx);
  });
  field.addEventListener("focus", drawTarget);
  el.addEventListener("change", (k) => {
    const t = k.target as HTMLSelectElement;
    if (t.dataset.connector !== undefined) chosen = t.value as ConnectorId;
    if (t.dataset.assistantTarget !== undefined) {
      wholeManuscript = t.value === "manuscript";
      drawTarget();
    }
  });
  el.addEventListener("click", (k) => {
    const response = (k.target as Element).closest("[data-copy-answer]")?.closest(".as-ans");
    if (response) {
      const blocks = [...response.querySelectorAll<HTMLElement>("[data-response-text]")];
      void copyText(displayedSections(blocks.map((block) => block.innerText)));
      return;
    }
    const t = (k.target as HTMLElement).closest<HTMLElement>("[data-send],[data-apply],[data-discard]");
    if (!t) return;
    if (t.dataset.send !== undefined) return void send(ctx);
    const e = history.find((x) => x.id === Number(t.dataset.apply ?? t.dataset.discard));
    if (!e || e.state !== "answered") return;
    if (t.dataset.apply !== undefined) return void apply(ctx, e);
    e.state = "discarded";
    drawHistory();
  });
  return el;
};

/** The tab's element, made once and kept, so the field keeps what is typed while the panel redraws. */
export const assistantView = (ctx: Ctx): HTMLElement => {
  if (!root) {
    root = build(ctx);
    drawHistory();
    void loadConnectors();
  }
  drawTarget();
  return root;
};

/** Puts the caret in the request field. */
const focusField = () => root?.querySelector<HTMLTextAreaElement>("textarea")?.focus();

/** Opens the bottom panel on the assistant's tab: set by the bottom panel. */
export const assistantTab = { open: (_ctx: Ctx) => {} };

export const mountAssistant = (ctx: Ctx) => {
  currentCtx = ctx;
  // a revoke in the settings changes the choices' wording (docs/adr/0089); read them again once the tab is made
  connectorsRevoked.notify = () => {
    if (root) void loadConnectors();
  };
  // the target follows the caret and the selection: the status bar is drawn again after each move
  ctx.status.push(() => (drawTarget(), ""));
  const open = (c: Ctx) => {
    assistantTab.open(c);
    focusField();
    drawTarget();
  };
  addCommands(
    ctx.commands,
    { id: "assistant.open", label: "アシスタント", icon: "sparkles", when: () => true, run: open },
    {
      id: "assistant.askSelection",
      label: "選択した範囲でアシスタントに頼む",
      icon: "sparkles",
      when: (s) => {
        const d = focused(s);
        const r = d && ctx.editors.get(d.path)?.edit?.core.range();
        return !!r && r.from < r.to;
      },
      run: (c) => {
        wholeManuscript = false;
        open(c);
        const target = root?.querySelector<HTMLSelectElement>("[data-assistant-target]");
        if (target) target.value = "sheet";
      },
    },
  );
};

// The plot: a table in plot.csv, previewed as a Gantt chart by subplot.
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api, basename } from "./api";
import { esc, h, icon } from "./icons";
import { PLOT_COLUMNS, loadPlot, namesCell, savePlot, type PlotKey, type PlotRow } from "./project";

const ICONS: Record<PlotKey, string> = {
  scene: "clapperboard",
  file: "file-text",
  subplots: "git-branch",
  pov: "eye",
  characters: "users",
  place: "map-pin",
  must: "square-check",
  flavor: "sparkles",
  target: "target",
  memo: "sticky-note",
  fragments: "quote",
  start: "calendar",
  end: "calendar-check",
};

const PALETTE = ["#d99a0b", "#4f8fd6", "#5aa469", "#c46ad0", "#e06c4f", "#3fa7a0", "#8a7f6d"];

export const subplotColor = (names: string[], s: string) => PALETTE[Math.max(0, names.indexOf(s)) % PALETTE.length];

/** A number or an ISO-like date, when a label is one; for sorting only. */
const valueOf = (s: string): number | null => {
  const t = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(t)) return null;
  const d = Date.parse(/^\d{4}$/.test(t) ? `${t}-01-01` : /^\d{4}-\d{2}$/.test(t) ? `${t}-01` : t);
  return Number.isNaN(d) ? null : d;
};

/** The story's calendar: the labels in order. The calendar file wins; otherwise
 * numbers and dates sort by value, and any other labels keep the table's order. */
export const calendarOf = (rows: PlotRow[], file: string[]): string[] => {
  const used = rows.flatMap((r) => [r.start.trim(), r.end.trim()]).filter(Boolean);
  const seen = [...new Set(used)];
  if (file.length) return [...file, ...seen.filter((l) => !file.includes(l))];
  return seen.every((l) => valueOf(l) !== null) ? [...seen].sort((x, y) => valueOf(x)! - valueOf(y)!) : seen;
};

const gantt = (rows: PlotRow[], subplots: string[], calendar: string[]) => {
  const items = rows
    .map((r, i) => {
      const s = calendar.indexOf(r.start.trim());
      const e = r.end.trim() ? calendar.indexOf(r.end.trim()) : s;
      return { r, i, s, e: Math.max(s, e) + 1 }; // the end label is included
    })
    .filter((x) => x.s >= 0);
  if (!items.length)
    return `<div class="hint">「開始」と「終了」の列に、物語の中の時を書くとガントチャートになります。「帝国暦302年・春」のような任意の文字列でかまいません。並び順は「暦」で決めます。</div>`;
  const col = Math.max(70, Math.min(140, Math.floor(1000 / calendar.length)));
  const W = col * calendar.length;
  const lanes = subplots.length ? subplots : ["(なし)"];
  const laneH = 34;
  let svg = `<svg class="gantt-svg" width="${W + 150}" height="${lanes.length * laneH + 34}" viewBox="-130 -26 ${W + 150} ${lanes.length * laneH + 34}">`;
  calendar.forEach((label, k) => {
    svg += `<line x1="${k * col}" x2="${k * col}" y1="-6" y2="${lanes.length * laneH}" class="tick"/><text x="${k * col + 4}" y="-10" class="tl">${esc(label.length > 12 ? label.slice(0, 11) + "…" : label)}</text>`;
  });
  lanes.forEach((lane, li) => {
    svg += `<text x="-120" y="${li * laneH + 21}" class="lane" fill="${subplotColor(subplots, lane)}">${esc(lane)}</text>`;
    items
      .filter((it) => (subplots.length ? namesCell(it.r.subplots).includes(lane) : true))
      .forEach((it) => {
        const c = subplotColor(subplots, lane);
        svg += `<g class="bar" data-row="${it.i}"><rect x="${it.s * col + 2}" y="${li * laneH + 7}" width="${(it.e - it.s) * col - 4}" height="20" rx="3" fill="${c}" fill-opacity=".22" stroke="${c}"/><text x="${it.s * col + 7}" y="${li * laneH + 21}" fill="${c}">${esc(it.r.scene || basename(it.r.file))}</text></g>`;
      });
  });
  return svg + "</svg>";
};

/** Edits the order of the calendar: one label per line. */
const editCalendar = (labels: string[]): Promise<string[] | null> =>
  new Promise((resolve) => {
    const dim = h(`<div class="dim"><div class="modal" style="width:440px;height:auto;flex-direction:column;padding:18px 20px;gap:10px">
      <div style="font-weight:600">暦</div>
      <div class="muted" style="font-size:12px;line-height:1.7">物語の中の時を、早い順に 1 行に 1 つ書きます。表の「開始」と「終了」に書いた文字列をそのまま使います。plot-calendar.txt に保存します。</div>
      <textarea class="field" style="width:100%;height:280px;font:13px/1.7 var(--body)">${esc(labels.join("\n"))}</textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end"><span class="btn" data-x>やめる</span><span class="btn pri" data-ok>保存</span></div>
    </div></div>`);
    const ta = dim.querySelector("textarea")!;
    dim.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === dim || t.closest("[data-x]")) (dim.remove(), resolve(null));
      if (t.closest("[data-ok]")) {
        dim.remove();
        resolve(ta.value.split("\n").map((l) => l.trim()).filter(Boolean));
      }
    });
    document.body.append(dim);
    ta.focus();
  });

export type PlotView = { reload: () => Promise<void>; el: HTMLElement };

export const mountPlot = (parent: HTMLElement, project: string, opts: { onOpenFile?: (rel: string) => void; standalone?: boolean } = {}): PlotView => {
  let rows: PlotRow[] = [];
  let calendarFile: string[] = [];
  const calPath = `${project}/plot-calendar.txt`;
  let mode: "table" | "gantt" | "both" = "both";
  let filter: string | null = null;
  let timer = 0;
  const el = h(`<div class="plot"></div>`);
  parent.replaceChildren(el);

  const subplotsOf = () => [...new Set(rows.flatMap((r) => namesCell(r.subplots)))];
  const save = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      await savePlot(project, rows);
      await emit("aleph:plot-saved", { project });
    }, 400);
  };

  const render = () => {
    const subs = subplotsOf();
    const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => !filter || namesCell(r.subplots).includes(filter));
    const total = rows.reduce((a, r) => a + (Number(r.target) || 0), 0);
    el.innerHTML = `
      <div class="bar2">
        <span class="f ${mode !== "gantt" ? "on" : ""}" data-mode="table">${icon("table-2", 14)}表</span>
        <span class="f ${mode !== "table" ? "on" : ""}" data-mode="gantt">${icon("calendar-range", 14)}ガント</span>
        <span class="sep"></span>
        <span class="f ${filter === null ? "on" : ""}" data-filter="">すべて</span>
        ${subs.map((s) => `<span class="f chip ${filter === s ? "on" : ""}" data-filter="${esc(s)}" style="--c:${subplotColor(subs, s)}">${esc(s)}</span>`).join("")}
        <span class="sp"></span>
        <span class="muted">${rows.length} シーン · 予定 ${total.toLocaleString()} 字</span>
        <span class="f" data-act="add">${icon("plus", 14)}シーン</span>
        ${mode !== "table" ? `<span class="f" data-act="calendar" title="ガントの時の並び">${icon("calendar-cog", 14)}暦</span>` : ""}
        ${opts.standalone ? "" : `<span class="f" data-act="window" title="別ウィンドウ">${icon("external-link", 14)}</span>`}
      </div>
      ${
        mode !== "gantt"
          ? `<div class="table-wrap"><table class="grid"><thead><tr><th></th>${PLOT_COLUMNS.map(([k, l]) => `<th>${icon(ICONS[k], 13)}${l}</th>`).join("")}</tr></thead><tbody>
        ${visible
          .map(
            ({ r, i }) =>
              `<tr data-row="${i}"><td class="rowtools"><span data-act="del" title="削除">${icon("x", 12)}</span></td>${PLOT_COLUMNS.map(
                ([k]) =>
                  k === "subplots"
                    ? `<td><div class="cell" contenteditable="plaintext-only" data-k="${k}">${esc(r[k])}</div><div class="chips">${namesCell(r[k]).map((s) => `<span class="chip" style="--c:${subplotColor(subs, s)}">${esc(s)}</span>`).join("")}</div></td>`
                    : k === "file" && r[k]
                      ? `<td><div class="cell link" contenteditable="plaintext-only" data-k="${k}">${esc(r[k])}</div><span class="open" data-open="${esc(r[k])}">${icon("arrow-up-right", 12)}</span></td>`
                      : `<td><div class="cell ${k === "fragments" ? "body" : ""}" contenteditable="plaintext-only" data-k="${k}">${esc(r[k])}</div></td>`,
              ).join("")}</tr>`,
          )
          .join("")}</tbody></table></div>`
          : ""
      }
      ${mode !== "table" ? `<div class="gantt">${gantt(filter ? rows.filter((r) => namesCell(r.subplots).includes(filter!)) : rows, filter ? [filter] : subs, calendarOf(rows, calendarFile))}</div>` : ""}`;
  };

  el.addEventListener("input", (e) => {
    const c = e.target as HTMLElement;
    const tr = c.closest("tr");
    if (!c.dataset.k || !tr) return;
    rows[Number(tr.dataset.row)][c.dataset.k as PlotKey] = c.innerText.replace(/\n$/, "");
    save();
  });
  el.addEventListener("focusout", (e) => {
    if ((e.target as HTMLElement).dataset.k) render();
  });
  el.addEventListener("click", async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-mode],[data-filter],[data-act],[data-open],.bar");
    if (!t) return;
    if (t.dataset.mode) {
      // toggles one of the two; at least one stays shown
      const showTable = mode !== "gantt";
      const showGantt = mode !== "table";
      const [tb, gt] = t.dataset.mode === "table" ? [!showTable, showGantt] : [showTable, !showGantt];
      mode = tb && gt ? "both" : tb ? "table" : gt ? "gantt" : mode;
    } else if (t.dataset.filter !== undefined) filter = t.dataset.filter || null;
    else if (t.dataset.act === "add") {
      rows.push(Object.fromEntries(PLOT_COLUMNS.map(([k]) => [k, k === "subplots" && filter ? filter : ""])) as PlotRow);
      save();
    } else if (t.dataset.act === "del") {
      rows.splice(Number(t.closest("tr")!.dataset.row), 1);
      save();
    } else if (t.dataset.act === "calendar") {
      const next = await editCalendar(calendarOf(rows, calendarFile));
      if (next === null) return;
      calendarFile = next;
      await api.writeText(calPath, next.join("\n") + "\n");
    } else if (t.dataset.act === "window") {
      new WebviewWindow(`plot-${Date.now()}`, {
        url: `index.html?view=plot&project=${encodeURIComponent(project)}`,
        title: `プロット — ${basename(project)}`,
        width: 1300,
        height: 800,
      });
      return;
    } else if (t.dataset.open) return opts.onOpenFile?.(t.dataset.open);
    else if (t.classList.contains("bar")) {
      const r = rows[Number(t.dataset.row)];
      if (r?.file) return opts.onOpenFile?.(r.file);
      return;
    }
    render();
  });

  const reload = async () => {
    rows = await loadPlot(project);
    calendarFile = (await api.exists(calPath))
      ? (await api.readText(calPath)).split("\n").map((l) => l.trim()).filter(Boolean)
      : [];
    render();
  };
  reload();
  return { reload, el };
};

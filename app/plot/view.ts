// The plot's table and Gantt chart (docs/adr/0013), drawn into an element of
// the main window or of the plot's own window.
import { emit } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../api.ts";
import { esc } from "../esc.ts";
import { h, icon } from "../icons.ts";
import { basename, underRoot } from "../path.ts";
import { uiState } from "../uistate.ts";
import { confirmDialog, ask, toast } from "../ui/dom.ts";
import {
  PLOT_COLUMNS,
  barsOf,
  calendarOf,
  columnWidths,
  freeColumnName,
  insertRow,
  moveRow,
  namesCell,
  newRow,
  parsePlot,
  stackLanes,
  writePlot,
  type PlotKey,
  type PlotRow,
} from "./data.ts";

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
const colorOf = (names: string[], s: string) => PALETTE[Math.max(0, names.indexOf(s)) % PALETTE.length];

const ellipsis = (s: string, fit: number) => ([...s].length > fit ? [...s].slice(0, Math.max(1, fit - 1)).join("") + "…" : s);

const ganttSvg = (rows: PlotRow[], indices: number[], subplots: string[], calendar: string[], zoom: number) => {
  const items = barsOf(rows, indices, calendar).map((b) => ({ ...b, r: rows[b.i] }));
  if (!items.length)
    return `<div class="hint">「開始」と「終了」に物語の中の時を書くと、ガントチャートになります。「帝国暦 302 年の春」のような任意の文字列でかまいません。並びは「暦」で決めます。</div>`;
  const col = Math.max(70, Math.min(140, Math.floor(1000 / calendar.length)));
  const W = col * calendar.length;
  const lanes = subplots.length ? subplots : ["（なし）"];
  const rowH = 30;
  const gap = 10;
  const packed = lanes.map((lane) => {
    const its = items.filter((it) => !subplots.length || namesCell(it.r.subplots).includes(lane));
    const { rows: at, count } = stackLanes(its);
    return { lane, placed: its.map((it, k) => ({ it, row: at[k] })), count };
  });
  const tops: number[] = [];
  const H = packed.reduce((y, p, i) => ((tops[i] = y), y + p.count * rowH + gap), 0);
  let svg = `<svg class="gantt-svg" width="${(W + 150) * zoom}" height="${(H + 30) * zoom}" viewBox="-130 -26 ${W + 150} ${H + 30}">`;
  calendar.forEach((label, k) => {
    svg += `<line x1="${k * col}" x2="${k * col}" y1="-6" y2="${H}" class="tick"/><text x="${k * col + 4}" y="-10" class="tl"><title>${esc(label)}</title>${esc(ellipsis(label, 12))}</text>`;
  });
  packed.forEach(({ lane, placed, count }, li) => {
    const top = tops[li];
    const c = colorOf(subplots, lane);
    if (li > 0) svg += `<line x1="-130" x2="${W}" y1="${top - gap / 2}" y2="${top - gap / 2}" class="lanesep"/>`;
    svg += `<text x="-120" y="${top + (count * rowH) / 2 + 4}" class="lane" fill="${c}">${esc(ellipsis(lane, 9))}</text>`;
    for (const { it, row } of placed) {
      const x = it.s * col + 2;
      const w = (it.e - it.s) * col - 4;
      const y = top + row * rowH + 4;
      const label = it.r.scene || basename(it.r.file) || "（無題）";
      const when = `${it.r.start}${it.r.end && it.r.end !== it.r.start ? `〜${it.r.end}` : ""}`;
      svg += `<g class="bar" data-row="${it.i}"><title>${esc(label)}（${esc(when)}）</title><rect x="${x}" y="${y}" width="${w}" height="${rowH - 8}" rx="3" fill="${c}" fill-opacity=".18" stroke="${c}"/><text x="${x + 6}" y="${y + 15}" fill="${c}">${esc(
        ellipsis(label, Math.max(1, Math.floor((w - 10) / 12))),
      )}</text></g>`;
    }
  });
  return svg + "</svg>";
};

const editCalendar = (labels: string[]): Promise<string[] | null> =>
  new Promise((resolve) => {
    const dim = h(`<div class="dim"><div class="modal small cal">
      <div class="mtitle">暦</div>
      <div class="muted">物語の中の時を、早い順に 1 行に 1 つ書きます。表の「開始」と「終了」に書いた文字列をそのまま使い、plot-calendar.txt に保存します。</div>
      <textarea class="field">${esc(labels.join("\n"))}</textarea>
      <div class="mbuttons"><span class="btn" data-x>やめる</span><span class="btn pri" data-ok>保存</span></div>
    </div></div>`);
    const ta = dim.querySelector("textarea")!;
    dim.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === dim || t.closest("[data-x]")) return dim.remove(), resolve(null);
      if (t.closest("[data-ok]")) {
        dim.remove();
        resolve(ta.value.split("\n").map((l) => l.trim()).filter(Boolean));
      }
    });
    document.body.append(dim);
    ta.focus();
  });

export type PlotView = { reload: () => Promise<void>; destroy: () => void };

export const openPlotWindow = (project: string) =>
  new WebviewWindow(`plot-${Date.now()}`, { url: `index.html?view=plot&project=${encodeURIComponent(project)}`, title: `プロット — ${basename(project)}`, width: 1300, height: 800 });

export const mountPlot = (parent: HTMLElement, project: string, opts: { onOpenFile?: (rel: string) => void; standalone?: boolean } = {}): PlotView => {
  // a file that leaves the project is not opened (docs/adr/0048)
  const openFile = (f: string) => {
    const r = underRoot(project, f.trim());
    if (r) opts.onOpenFile?.(r);
  };
  const csvPath = `${project}/plot.csv`;
  const calPath = `${project}/plot-calendar.txt`;
  let rows: PlotRow[] = [];
  let extras: string[] = [];
  let calendarFile: string[] = [];
  let showTable = true;
  let showGantt = true;
  let filter: string | null = null;
  let gz = Math.min(4, Math.max(0.4, uiState().get("ganttZoom", 1)));
  let timer = 0;
  const el = h(`<div class="plot"></div>`);
  parent.replaceChildren(el);

  const subplots = () => [...new Set(rows.flatMap((r) => namesCell(r.subplots)))];
  const save = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      timer = 0;
      await api.writeText(csvPath, writePlot(rows, extras));
      await emit("aleph:plot-saved", { project, from: getCurrentWindow().label }).catch(() => {});
    }, 400);
  };
  const setGz = (z: number) => {
    gz = Math.min(4, Math.max(0.4, z));
    uiState().set("ganttZoom", gz);
  };
  const blank = () => newRow(extras, filter ? { subplots: filter } : {});

  // columns written at length grow taller while edited
  const LONG = new Set(["memo", "fragments", "must", "flavor"]);
  const cell = (r: PlotRow, k: string, subs: string[]) => {
    const v = esc(r[k] ?? "");
    if (k === "subplots")
      return `<td><div class="cell" contenteditable="plaintext-only" data-k="${k}">${v}</div><div class="chips">${namesCell(r[k])
        .map((s) => `<span class="chip" style="--c:${colorOf(subs, s)}">${esc(s)}</span>`)
        .join("")}</div></td>`;
    if (k === "file" && r[k].trim())
      return `<td><div class="cell link" contenteditable="plaintext-only" data-k="${k}">${v}</div><span class="open" data-open="${v}" title="開く">${icon("arrow-up-right", 12)}</span></td>`;
    return `<td><div class="cell ${k === "fragments" ? "body" : ""} ${LONG.has(k) ? "long" : ""}" contenteditable="plaintext-only" data-k="${esc(k)}">${v}</div></td>`;
  };

  const render = () => {
    const subs = subplots();
    const visible = rows.map((_, i) => i).filter((i) => !filter || namesCell(rows[i].subplots).includes(filter));
    const total = rows.reduce((a, r) => a + (Number(r.target) || 0), 0);
    el.innerHTML = `
      <div class="bar2">
        <span class="f ${showTable ? "on" : ""}" data-mode="table">${icon("table-2", 14)}表</span>
        <span class="f ${showGantt ? "on" : ""}" data-mode="gantt">${icon("calendar-range", 14)}ガント</span>
        <span class="sep"></span>
        <span class="f ${filter === null ? "on" : ""}" data-filter="">すべて</span>
        ${subs.map((s) => `<span class="f chip ${filter === s ? "on" : ""}" data-filter="${esc(s)}" style="--c:${colorOf(subs, s)}">${esc(s)}</span>`).join("")}
        <span class="sp"></span>
        <span class="muted">${rows.length} シーン · 予定 ${total.toLocaleString()} 字</span>
        ${showTable ? `<span class="f" data-act="addcol" title="任意の列を足す">${icon("plus", 14)}列</span>` : ""}
        ${showGantt ? `<span class="f" data-act="calendar" title="ガントの時の並び">${icon("calendar-cog", 14)}暦</span>` : ""}
        ${opts.standalone ? "" : `<span class="f" data-act="window" title="別のウィンドウに出す">${icon("external-link", 14)}</span>`}
      </div>
      ${
        showTable
          ? `<div class="table-wrap"><table class="grid" style="width:${24 + columnWidths(extras).reduce((a, b) => a + b, 0)}px"><colgroup><col style="width:24px">${columnWidths(extras)
              .map((w) => `<col style="width:${w}px">`)
              .join("")}</colgroup><thead><tr><th></th>${PLOT_COLUMNS.map(([k, l]) => `<th>${icon(ICONS[k], 13)}${l}</th>`).join("")}${extras
              .map((x) => `<th class="extra">${icon("columns-3", 13)}${esc(x)}<span class="rmcol" data-rmcol="${esc(x)}" title="この列を消す">${icon("x", 11)}</span></th>`)
              .join("")}</tr></thead><tbody>${visible
              .map(
                (i) =>
                  `<tr data-row="${i}"><td class="rowtools"><span class="grip" data-grip title="ドラッグして並べ替える">${icon("grip-vertical", 13)}</span><span data-act="del" title="このシーンを消す">${icon("x", 12)}</span></td>${[
                    ...PLOT_COLUMNS.map(([k]) => k as string),
                    ...extras,
                  ]
                    .map((k) => cell(rows[i], k, subs))
                    .join("")}</tr>`,
              )
              .join("")}</tbody></table>
          <div class="addrow" data-act="add">${icon("plus", 13)}シーンを足す</div>
          <div class="insline" hidden><span class="insplus" title="ここにシーンを足す">${icon("plus", 12)}</span></div></div>`
          : ""
      }
      ${
        showGantt
          ? `<div class="gantt-box"><div class="gtools"><span class="iconbtn" data-gz="out" title="縮小">${icon("zoom-out", 14)}</span><span class="gzv" data-gz="fit" title="100% に戻す">${Math.round(gz * 100)}%</span><span class="iconbtn" data-gz="in" title="拡大">${icon(
              "zoom-in",
              14,
            )}</span></div><div class="gantt">${ganttSvg(rows, visible, filter ? [filter] : subs, calendarOf(rows, calendarFile), gz)}</div></div>`
          : ""
      }`;
  };

  el.addEventListener("input", (e) => {
    const c = e.target as HTMLElement;
    const tr = c.closest("tr");
    if (!c.dataset.k || !tr) return;
    rows[Number(tr.dataset.row)][c.dataset.k] = c.innerText.replace(/\n$/, "");
    save();
  });
  el.addEventListener("focusout", (e) => {
    // draw again (chips, the chart) once editing ends, but not while moving from cell to cell
    const next = e.relatedTarget as HTMLElement | null;
    if ((e.target as HTMLElement).dataset.k && !next?.dataset?.k) render();
  });
  el.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    if (target.closest(".insplus")) {
      const at = Number(target.closest<HTMLElement>(".insline")!.dataset.at);
      rows = insertRow(rows, at, blank());
      save();
      render();
      el.querySelector<HTMLElement>(`tr[data-row="${at}"] .cell`)?.focus();
      return;
    }
    const t = target.closest<HTMLElement>("[data-mode],[data-filter],[data-act],[data-open],[data-gz],[data-rmcol],.bar");
    if (!t) return;
    const d = t.dataset;
    if (d.mode) {
      // one of the two always stays shown
      if (d.mode === "table" && (!showTable || showGantt)) showTable = !showTable;
      if (d.mode === "gantt" && (!showGantt || showTable)) showGantt = !showGantt;
    } else if (d.gz) setGz(d.gz === "in" ? gz * 1.25 : d.gz === "out" ? gz / 1.25 : 1);
    else if (d.rmcol) {
      const x = d.rmcol;
      if (!(await confirmDialog(`列「${x}」を、中身ごと消します`, "消す"))) return;
      extras = extras.filter((c) => c !== x);
      rows.forEach((r) => delete r[x]);
      save();
    } else if (d.act === "addcol") {
      const name = (await ask("足す列の名前"))?.replace(/[,\n"]/g, " ").trim();
      if (!name) return;
      if (!freeColumnName(name, extras)) return toast(`「${name}」という列はもうあります`);
      extras = [...extras, name];
      rows.forEach((r) => (r[name] = ""));
      save();
    } else if (d.filter !== undefined) filter = d.filter || null;
    else if (d.act === "add") {
      rows = [...rows, blank()];
      save();
      render();
      const wrap = el.querySelector<HTMLElement>(".table-wrap");
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
      el.querySelector<HTMLElement>(`tr[data-row="${rows.length - 1}"] .cell`)?.focus();
      return;
    } else if (d.act === "del") {
      const i = Number(t.closest("tr")!.dataset.row);
      if (!(await confirmDialog(`シーン「${rows[i].scene || "（無題）"}」を消します`, "消す"))) return;
      rows = rows.filter((_, k) => k !== i);
      save();
    } else if (d.act === "calendar") {
      const next = await editCalendar(calendarOf(rows, calendarFile));
      if (next === null) return;
      calendarFile = next;
      await api.writeText(calPath, next.join("\n") + "\n");
    } else if (d.act === "window") return void openPlotWindow(project);
    else if (d.open) return openFile(d.open);
    else if (t.classList.contains("bar")) {
      const r = rows[Number(d.row)];
      if (r?.file.trim()) openFile(r.file);
      return;
    }
    render();
  });

  // ---- inserting at a row border, and dragging rows by the grip ----
  /** The border nearest to y within `slack` px: the index to insert before, and its y in the wrap. */
  const borderAt = (wrap: HTMLElement, y: number, slack: number) => {
    const top = wrap.getBoundingClientRect().top - wrap.scrollTop;
    let best: { at: number; y: number; d: number } | null = null;
    [...wrap.querySelectorAll<HTMLTableRowElement>("tbody tr")].forEach((tr, n) => {
      const r = tr.getBoundingClientRect();
      const idx = Number(tr.dataset.row);
      const edges: [number, number][] = n === 0 ? [[r.top, idx], [r.bottom, idx + 1]] : [[r.bottom, idx + 1]];
      for (const [edge, at] of edges) {
        const dist = Math.abs(y - edge);
        if (dist <= slack && (!best || dist < best.d)) best = { at, y: edge - top, d: dist };
      }
    });
    return best as { at: number; y: number } | null;
  };
  let drag: { from: number; at: number | null } | null = null;
  const showLine = (wrap: HTMLElement, b: { at: number; y: number } | null, dragging: boolean) => {
    const line = wrap.querySelector<HTMLElement>(".insline");
    if (!line) return;
    line.hidden = !b;
    line.classList.toggle("dragging", dragging);
    if (b) {
      line.style.top = `${b.y}px`;
      line.dataset.at = String(b.at);
    }
  };
  el.addEventListener("mousemove", (e) => {
    const t = e.target as HTMLElement;
    const wrap = t.closest<HTMLElement>(".table-wrap");
    if (!wrap || drag || t.closest(".insline")) return;
    showLine(wrap, borderAt(wrap, e.clientY, 4), false);
  });
  el.addEventListener("mouseleave", () => el.querySelector<HTMLElement>(".insline")?.setAttribute("hidden", ""));
  el.addEventListener("mousedown", (e) => {
    const grip = (e.target as HTMLElement).closest<HTMLElement>("[data-grip]");
    const wrap = grip?.closest<HTMLElement>(".table-wrap");
    if (!grip || !wrap) return;
    e.preventDefault();
    const tr = grip.closest("tr")!;
    drag = { from: Number(tr.dataset.row), at: null };
    tr.classList.add("dragged");
    const move = (ev: MouseEvent) => {
      const b = borderAt(wrap, ev.clientY, 1e9);
      drag!.at = b?.at ?? null;
      showLine(wrap, b, true);
      const r = wrap.getBoundingClientRect();
      if (ev.clientY < r.top + 30) wrap.scrollTop -= 12;
      if (ev.clientY > r.bottom - 30) wrap.scrollTop += 12;
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      const dd = drag!;
      drag = null;
      if (dd.at !== null) {
        const next = moveRow(rows, dd.from, dd.at);
        if (next !== rows) (rows = next), save();
      }
      render();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // pinch, or ⌘ with the wheel, over the chart zooms it
  el.addEventListener(
    "wheel",
    (e) => {
      if ((!e.ctrlKey && !e.metaKey) || !(e.target as HTMLElement).closest(".gantt")) return;
      e.preventDefault();
      setGz(gz * Math.exp(-e.deltaY * 0.01));
      render();
    },
    { passive: false },
  );

  const reload = async () => {
    ({ rows, extras } = parsePlot(await api.readText(csvPath).catch(() => "")));
    calendarFile = (await api.readText(calPath).catch(() => ""))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    render();
  };
  void reload();
  return {
    reload,
    destroy: () => {
      clearTimeout(timer);
      if (timer) void api.writeText(csvPath, writePlot(rows, extras));
      el.remove();
    },
  };
};

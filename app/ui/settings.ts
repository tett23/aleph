// The settings dialog: sections registered by each part of the app (docs/adr/0004, docs/adr/0005).
import { getVersion } from "@tauri-apps/api/app";
import type { Ctx } from "../ctx.ts";
import { esc } from "../esc.ts";
import { h, icon } from "../icons.ts";

export const openSettings = async (ctx: Ctx, sectionId?: string) => {
  // the version of the build (tauri.conf.json), not a number written here
  const version = await getVersion().catch(() => "");
  let current = sectionId ?? ctx.settings[0]?.id ?? "";
  const dim = h(`<div class="dim"></div>`);
  const groups = [...new Set(ctx.settings.map((s) => s.group))];
  const render = async () => {
    const sec = ctx.settings.find((s) => s.id === current);
    dim.innerHTML = `<div class="modal">
      <div class="mnav">${groups
        .map((g) => `<h6>${esc(g)}</h6>${ctx.settings.filter((s) => s.group === g).map((s) => `<div data-sec="${s.id}" class="${s.id === current ? "on" : ""}">${esc(s.label)}</div>`).join("")}`)
        .join("")}</div>
      <div class="mbody"><span class="iconbtn close" data-close>${icon("x")}</span>
        <div class="mhead"><img class="app-ico" src="/icon.svg" alt=""><div><h2>Aleph</h2><small class="muted">${esc(version)}</small></div></div>
        <div class="msec">${sec ? await sec.render(ctx) : ""}</div>
      </div></div>`;
  };
  dim.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t === dim || t.closest("[data-close]")) {
      dim.remove();
      ctx.refresh();
      return;
    }
    const s = t.closest<HTMLElement>("[data-sec]")?.dataset.sec;
    if (s) {
      current = s;
      return render();
    }
    const sec = ctx.settings.find((x) => x.id === current);
    if (sec?.onClick && (await sec.onClick(t, ctx))) await render();
  });
  dim.addEventListener("change", async (e) => {
    const sec = ctx.settings.find((x) => x.id === current);
    if (sec?.onChange && (await sec.onChange(e.target as HTMLInputElement, ctx))) await render();
  });
  await render();
  document.body.append(dim);
};

/** A settings item: a label, a note, and the control on the right. */
export const item = (label: string, note: string, control: string) =>
  `<div class="item"><div class="d"><div>${esc(label)}</div><small>${note}</small></div>${control}</div>`;

export const toggle = (key: string, on: boolean) => `<span class="toggle ${on ? "on" : ""}" data-toggle="${key}"></span>`;

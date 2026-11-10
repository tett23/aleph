// The screen to settle where the disk and the editor changed the same place differently
// (docs/adr/0063): no Git words; each place side by side, the disk's on the left and
// Aleph's on the right, the characters changed from the base marked; the whole result
// below, drawn again as the choices change.
import { esc } from "../esc.ts";
import { h } from "../icons.ts";
import { resolve, type Choice, type Chunk } from "../merge3.ts";
import { diffText } from "../ed/ime.ts";

/** `side` with the part that differs from `base` marked (one changed stretch: the common head and tail kept plain). */
const marked = (base: string, side: string) => {
  const d = diffText(base, side);
  if (!d || !d.insert) return esc(side);
  return `${esc(side.slice(0, d.from))}<ins>${esc(d.insert)}</ins>${esc(side.slice(d.from + d.insert.length))}`;
};

const LABEL: Record<Choice, string> = { theirs: "左を使う", ours: "右を使う", both: "両方残す" };

/** Resolves to the settled text, or null when the writer stops. */
export const settleConflicts = (name: string, chunks: Chunk[]): Promise<string | null> =>
  new Promise((done) => {
    const conflicts = chunks.filter((c): c is Chunk & { t: "conflict" } => c.t === "conflict");
    const choices: Choice[] = conflicts.map(() => "ours");
    // the line each conflict starts at in the result, and the two lines before it
    const places = (() => {
      let line = 1;
      let before: string[] = [];
      let k = 0;
      return chunks.flatMap((c) => {
        if (c.t === "ok") {
          line += c.lines.length;
          before = [...before, ...c.lines].slice(-2);
          return [];
        }
        const at = { line, before, k: k++ };
        line += c.ours.length;
        before = c.ours.slice(-2);
        return [at];
      });
    })();
    const dim = h(`<div class="dim"><div class="modal merge"></div></div>`);
    const box = dim.querySelector<HTMLElement>(".modal")!;
    const draw = () => {
      box.innerHTML = `<div class="mtitle">${esc(name)} の食い違いを直す</div>
        <div class="msub">ほかのアプリと Aleph の両方で、同じ箇所が違うように直されています。箇所ごとに、残す方を選んでください。ほかの箇所の変更は、両方とも取り込み済みです。</div>
        <div class="hunks">${conflicts
          .map((c, i) => {
            const p = places[i];
            const b = c.base.join("\n");
            const side = (who: "theirs" | "ours", label: string, lines: string[]) =>
              `<div class="mside${choices[i] === who || choices[i] === "both" ? " on" : ""}" data-pick="${i}:${who}"><div class="lab"><span>${label}</span>${
                choices[i] === who ? "<span>✓ 選択中</span>" : ""
              }</div><div class="txt">${lines.length ? marked(b, lines.join("\n")) : '<span class="none">（消されています）</span>'}</div></div>`;
            return `<div class="hunk"><div class="mh"><span>${i + 1} か所目（${p.line} 行目）</span><span>${i + 1} / ${conflicts.length}</span></div>
              ${p.before.length ? `<div class="ctx">${esc(p.before.join("\n"))}</div>` : ""}
              <div class="two">${side("theirs", "ほかのアプリでの変更", c.theirs)}${side("ours", "Aleph での変更", c.ours)}</div>
              <div class="choose"><span class="seg">${(["theirs", "ours", "both"] as Choice[])
                .map((w) => `<span class="${choices[i] === w ? "on" : ""}" data-pick="${i}:${w}">${LABEL[w]}</span>`)
                .join("")}</span></div></div>`;
          })
          .join("")}</div>
        <div class="rlab">決まる全文</div><div class="result">${esc(resolve(chunks, choices))}</div>
        <div class="mbuttons"><span class="btn" data-x>やめる</span><span class="btn pri" data-ok>これで決める</span></div>`;
    };
    draw();
    dim.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === dim || t.closest("[data-x]")) return (dim.remove(), done(null));
      if (t.closest("[data-ok]")) return (dim.remove(), done(resolve(chunks, choices)));
      const pick = t.closest<HTMLElement>("[data-pick]")?.dataset.pick;
      if (!pick) return;
      const [i, w] = pick.split(":");
      choices[Number(i)] = w as Choice;
      const scroll = box.querySelector(".hunks")?.scrollTop ?? 0;
      draw();
      box.querySelector(".hunks")!.scrollTop = scroll;
    });
    document.body.append(dim);
  });

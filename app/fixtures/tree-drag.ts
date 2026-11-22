import { api } from "../api.ts";
import type { Ctx } from "../ctx.ts";
import { mountDragOut } from "../dragout.ts";
import { icon } from "../icons.ts";
import { createStore, initialState, type Doc } from "../store.ts";

const check = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message);
};
const assert: typeof check = check;
const same = (a: unknown, b: unknown, message: string) => assert(JSON.stringify(a) === JSON.stringify(b), message);
const tree = document.querySelector<HTMLElement>(".file-tree")!;
const sheetName = "<img src=example onerror='throw new Error()'> " + "見出し".repeat(180);
const groups = [
  ["/w/source", "展開フォルダ", "folder", true],
  ["/w/source/chapter.gm", sheetName, "file-text", false, "chapter"],
  ["/w/empty", "空フォルダ", "folder", true],
  ["/w/project", "Project", "book-open", true],
  ["/w/project/images/cover.png", "Cover", "image", false, "png"],
  ["/w/project/style.toml", "Style", "file-cog", false, "toml"],
  ["/w/collision", "Collision", "folder", true],
  ["/w/source/raw.txt", "Raw", "file", false],
  ["/w/source/child", "Child", "folder", true],
] as const;
const rows = new Map<string, HTMLElement>(groups.map(([path, text, symbol, dir, detail]) => {
  const row = document.createElement("div");
  row.className = dir && symbol === "book-open" ? "r proj" : "r";
  row.dataset[dir ? "dir" : "file"] = path;
  row.innerHTML = (dir ? icon("chevron-right", 13) : "") +
    (symbol === "book-open" ? `<span class="ic book">${icon(symbol, 15)}</span>` : icon(symbol, 14)) +
    '<span class="ttl"></span><span class="fn"></span>';
  row.querySelector(".ttl")!.textContent = text;
  if (detail) row.querySelector(".fn")!.textContent = detail;
  tree.append(row);
  return [path, row];
}));
const filler = document.createElement("div");
filler.style.height = "360px";
tree.append(filler);
const row = (path: string) => rows.get(path)!;
const chapter = document.querySelector<HTMLElement>("#chapter")!;
const markdown = document.querySelector<HTMLElement>("#markdown")!;
const loose = document.querySelector<HTMLElement>("#loose-gm")!;
const doc = (path: string, kind: string, project: string | null): Doc => ({
  path, kind, project, workspace: "/w", text: "Verse\nNext", saved: "Verse\nNext",
  grid: { chars: 20, lines: 20, vertical: false },
});
const docs = [doc("/w/project/manuscript.gm", "gm", "/w/project"), doc("/w/notes.md", "md", null), doc("/w/loose.gm", "gm", null)];
const store = createStore({
  ...initialState(), workspace: "/w", workspaces: ["/w", "/other"],
  panes: [{ active: 0, tabs: [{ id: 1, open: docs, focus: 0, plot: null, preview: false, diff: false }] }],
});
const insertions: string[] = [];
const editors = new Map(docs.map(({ path, text }, i) => [path, { edit: {
  core: { text: () => text, doc: () => ({ length: text.length, lineAt: () => ({ number: 1 }) }) },
  view: { root: [chapter, markdown, loose][i], posAtCoords: () => 1, lineEndBar: () => ({ left: 350, top: 54, width: 100, height: 2 }) },
  apply: ([change]: { insert: string }[]) => insertions.push(change.insert),
} }]));
const notifications: string[] = [];
const moves: [string, string][] = [];
const native: string[][] = [];
const fixture = window as Window & { testTreeMove?: (file: string, dir: string) => void; webkit?: { messageHandlers: Record<string, { postMessage: (message: string) => void }> }; afterPageZoom?: () => void };
fixture.testTreeMove = (file, dir) => {
  assert(!preview(), "drop cleaned the preview before move");
  moves.push([file, dir]);
};
api.dragOut = async (paths) => {
  assert(!preview(), "native handoff cleaned the preview first");
  native.push(paths);
  throw new Error("intentional handoff failure");
};
mountDragOut({
  store, editors, projects: ["/w/project"], toast: (message: string) => notifications.push(message),
  notify: ({ message }: { message: string }) => notifications.push(message),
} as unknown as Ctx);

const preview = () => document.querySelector<HTMLElement>(".tree-drag-preview");
const ref = () => !!preview()?.querySelector<HTMLElement>(".tree-drag-refuse:not([hidden])");
const bar = () => !!document.querySelector(".drop-line");
const rect = (e: Element) => e.getBoundingClientRect().toJSON();
const point = (e: Element, dx = 10, dy = 10) => {
  const { x, y } = e.getBoundingClientRect();
  return { x: x + dx, y: y + dy };
};
type Point = ReturnType<typeof point>;
const press = (kind: string, { x, y }: Point, on?: Element) => {
  const init = { isPrimary: true, pointerId: 1, pointerType: "mouse", bubbles: true, cancelable: true,
    button: 0, buttons: kind.endsWith("up") ? 0 : 1, clientX: x, clientY: y };
  (on ?? document.elementFromPoint(x, y) ?? document).dispatchEvent(kind.startsWith("pointer")
    ? new PointerEvent(kind, init) : new MouseEvent(kind, init));
};
const down = (e: Element) => {
  const at = point(e);
  press("pointerdown", at, e);
  press("mousedown", at, e);
  return at;
};
const move = (at: Point) => {
  press("pointermove", at);
  press("mousemove", at);
};
const up = (at: Point) => {
  press("pointerup", at);
  press("mouseup", at);
};
const esc = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
const hits = (at: Point) => document.elementFromPoint(at.x, at.y);
const bounds = () => [...rows.values()].map(rect);
const inside = () => {
  const { left, top, right, bottom, width } = preview()!.getBoundingClientRect();
  const viewport = window.visualViewport!;
  const tolerance = 0.05;
  assert(width <= 240 && left >= viewport.offsetLeft - tolerance && top >= viewport.offsetTop - tolerance &&
    right <= viewport.offsetLeft + viewport.width + tolerance && bottom <= viewport.offsetTop + viewport.height + tolerance, "preview stays within viewport at <= 240px");
};

const results: string[] = [];
const run = (name: string, test: () => void) => {
  test();
  results.push(name);
};
const report = (ok: boolean, error?: unknown) => {
  const result = JSON.stringify({ ok, results, ...(error ? { error: String(error), stack: error instanceof Error ? error.stack : "" } : {}) });
  document.querySelector("#result")!.textContent = result;
  fixture.webkit?.messageHandlers.report.postMessage(result);
};

try {
  const sheet = row("/w/source/chapter.gm");
  const folder = row("/w/empty");
  const image = row("/w/project/images/cover.png");

  run("ADR 0103 I1: threshold, element content and compatibility events", () => {
    const at = down(sheet);
    up(at);
    assert(!preview(), "a click has no preview");
    down(sheet);
    move({ x: at.x + 3, y: at.y });
    assert(!preview(), "3px stays below threshold");
    move({ x: at.x + 4, y: at.y });
    assert(document.querySelectorAll(".tree-drag-preview").length === 1, "4px shows exactly one preview");
    assert(preview()!.textContent?.includes(sheetName), "HTML-looking name remains text");
    assert(!preview()!.querySelector("img") && preview()!.querySelector(".fn")?.textContent === "chapter", "filename and text-only title");
    assert(preview()!.querySelector("svg")!.getBoundingClientRect().width === 14, "long title retains file icon width");
    assert(getComputedStyle(preview()!).opacity === "0.65", "opacity is 0.65");
    up(at);
    assert(!preview(), "drop cleared preview");
    for (const path of ["/w/source", "/w/empty", "/w/project", "/w/source/raw.txt"]) {
      const source = row(path);
      const p = down(source);
      move({ x: p.x + 4, y: p.y });
      const sourceIcon = source.querySelector(".book svg") ?? source.querySelector("svg:last-of-type");
      assert(preview()!.querySelector("svg")?.innerHTML === sourceIcon?.innerHTML, `kind icon for ${path}`);
      assert(preview()!.textContent?.includes(source.querySelector(".ttl")!.textContent!), `label for ${path}`);
      esc();
      up(p);
    }
  });

  run("ADR 0103 I2, I4: overlapped rows, empty tree, no-op, self, descendant, collision and protected source", () => {
    const original = bounds();
    const scroll = tree.scrollTop;
    const target = point(folder);
    const at = down(sheet);
    move(target);
    const floating = preview()!;
    const floatingRect = floating.getBoundingClientRect();
    const behind = { x: floatingRect.left + 4, y: floatingRect.top + 4 };
    assert(hits(behind)?.closest(".r") && hits(behind) !== floating, "actual tree row is behind preview");
    const snapshots = [hits(behind), hits(target)];
    // Force overlap at the pointer itself to compare hit testing at identical coordinates.
    floating.style.left = `${target.x - 2}px`;
    floating.style.top = `${target.y - 2}px`;
    assert(hits(target) === snapshots[1], "pointer over preview still hits the target row");
    floating.remove();
    assert(hits(behind) === snapshots[0] && hits(target) === snapshots[1], "same elements with preview removed");
    move(target);
    assert(folder.classList.contains("tree-move-target"), "drop classification is unchanged without preview");
    same(bounds(), original, "all tree row rectangles unchanged");
    assert(tree.scrollTop === scroll, "tree scroll unchanged");
    document.body.append(floating);
    assert(folder.classList.contains("tree-move-target") && !ref(), "valid folder");
    move(point(row("/w/source")));
    assert(!ref() && !tree.querySelector(".tree-move-target,.tree-move-refuse"), "same parent is a no-op");
    move(point(row("/w/collision")));
    assert(ref(), "same-name collision");
    move({ x: 100, y: 303 });
    assert(tree.classList.contains("tree-move-target") && !ref(), "blank tree root is highlighted");
    floating.style.left = `${target.x - 2}px`;
    floating.style.top = `${target.y - 2}px`;
    up(target);
    same(moves, [[sheet.dataset.file, folder.dataset.dir]], "exactly one move to the overlapped release target");
    const parent = row("/w/source");
    down(parent);
    move(point(row("/w/source/child")));
    assert(ref(), "descendant is forbidden");
    move({ ...point(parent), x: 60 });
    assert(ref(), "folder itself is forbidden");
    esc();
    up(at);
    down(row("/w/project/style.toml"));
    move(target);
    assert(ref() && folder.classList.contains("tree-move-refuse"), "protected source is refused");
    up(target);
    assert(moves.length === 1 && notifications.some((text) => text.includes("設定ファイル")), "protected source reports refusal without moving");
  });

  run("ADR 0103 I2, I4: tree scroll recomputes the destination at a stationary pointer", () => {
    const target = point(folder);
    down(sheet);
    move(target);
    assert(folder.classList.contains("tree-move-target"), "original row highlighted");
    tree.scrollTop = row("/w/project/images/cover.png").offsetTop - folder.offsetTop;
    tree.dispatchEvent(new Event("scroll"));
    const hit = hits(target)?.closest(".r");
    assert(tree.scrollTop > 0 && hit && hit !== folder, "test scrolled to another row");
    assert(!folder.classList.contains("tree-move-target") && hit.classList.contains("tree-move-target"), "stationary pointer now marks scrolled row");
    esc();
    up(target);
    tree.scrollTop = 0;
  });

  run("ADR 0103 I1, I4: image dragging shares the preview, routes each release once and draws the existing line", () => {
    const target = point(chapter);
    down(image);
    move(target);
    assert(document.querySelectorAll(".tree-drag-preview").length === 1 && !ref() && bar(), "one preview and valid chapter line");
    assert(getComputedStyle(chapter.firstElementChild!).webkitUserSelect === "none", "drag disables selection in editor");
    move(point(markdown));
    assert(ref() && !bar(), "Markdown does not accept image");
    move(point(loose));
    assert(ref() && !bar(), "standalone gm does not accept image");
    move(point(folder));
    assert(!ref() && !bar() && folder.classList.contains("tree-move-target"), "back to tree routes to move");
    move(target);
    up(target);
    assert(!preview() && !bar() && insertions.length === 1 && insertions[0].includes("@figure images/cover.png"), "insertion happens once and clears both marks");
    same(moves.length, 1, "insertion did not move the file");
    down(image);
    move(target);
    up(point(folder));
    assert(moves.length === 2 && insertions.length === 1, "release in tree overrides the last editor mark");
  });

  run("ADR 0103 I5: Esc, pointercancel, blur, workspace switch and native handoff cannot resurrect a preview", () => {
    const target = point(folder);
    for (const stop of [
      esc,
      () => press("pointercancel", target),
      () => window.dispatchEvent(new Event("blur")),
      () => {
        store.dispatch({ type: "workspace", path: "/other" });
        store.dispatch({ type: "workspace", path: "/w" });
      },
      () => move({ x: innerWidth + 1, y: 20 }),
    ]) {
      down(sheet);
      move(target);
      assert(preview(), "new drag is live");
      stop();
      assert(!preview(), "stop cleared preview");
      move(target);
      up(target);
      assert(!preview() && moves.length === 2, "stale events do not restart after stop");
    }
    same(native, [[sheet.dataset.file]], "one external handoff for the pressed row");
  });

  run("ADR 0103 I3: actual light and dark rectangles fit at edges and when the viewport is narrowed", () => {
    down(sheet);
    for (const dark of [false, true]) {
      document.body.classList.toggle("theme-dark", dark);
      move({ x: innerWidth - 1, y: innerHeight - 1 });
      inside();
      const bottom = preview()!.getBoundingClientRect().bottom;
      assert(bottom <= innerHeight - 13, "preview flips above pointer");
      const color = getComputedStyle(preview()!).backgroundColor;
      assert(color === (dark ? "rgb(38, 38, 38)" : "rgb(246, 246, 246)"), "themed background");
      move({ x: 0, y: 0 });
      inside();
      assert(preview()!.getBoundingClientRect().top === 12, "preview 12px below pointer");
    }
    move({ x: innerWidth - 1, y: innerHeight - 1 });
  });

  if (!fixture.webkit) report(true);
  else {
    fixture.afterPageZoom = () => {
      try {
        run("ADR 0103 I3: active preview is contained after WKWebView page zoom and window resize", () => {
          assert(preview(), "still the same drag after zoom");
          assert(innerWidth < 200 && innerHeight < 50, "WKWebView has a small CSS viewport");
          inside();
          assert(preview()!.getBoundingClientRect().right <= innerWidth - 3.95, "preview respects right margin after resize");
          esc();
          assert(!preview(), "resized drag cancels");
        });
        assert(notifications.some((text) => text.includes("intentional handoff failure")), "asynchronous native failure was reported");
        report(true);
      } catch (error) { report(false, error); }
    };
    fixture.webkit.messageHandlers.zoom.postMessage("resize");
  }
} catch (error) { report(false, error); }

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, normalize, type Config, type Theme } from "./config.ts";
import { chooseTheme, createAppearance, drawingRevision, themeChoicesHtml, themeOf } from "./appearance.ts";

// The windows the ADR names, each with the appearance it shows, joined by a
// bus that stands for the Tauri event every window receives.
const WINDOWS = ["main", "plain", "pages", "plot"] as const;

const app = (stored: string, systemDark: boolean) => {
  const disk = { text: stored, fail: false };
  const shown = new Map<string, boolean>();
  const open = (label: string) => {
    const config = normalize(JSON.parse(disk.text));
    const look = createAppearance(config.theme, systemDark, (dark) => shown.set(label, dark));
    return { label, config, look };
  };
  const windows = WINDOWS.map(open);
  const main = windows[0];
  const save = async (c: Config) => {
    if (disk.fail) throw new Error("disk full");
    disk.text = JSON.stringify(c);
  };
  const announce = (t: Theme) => windows.forEach((w) => w.look.receive({ theme: t }));
  return {
    disk,
    shown,
    windows,
    open,
    choose: (t: Theme) => chooseTheme(main.config, t, save, announce),
    system: (dark: boolean) => windows.forEach((w) => w.look.system(dark)),
    all: () => WINDOWS.map((w) => shown.get(w)),
  };
};

const stored = (theme?: unknown) => JSON.stringify(theme === undefined ? {} : { theme });

test("ADR 0099 I1: OS dark and light chosen: every window is light", async () => {
  const a = app(stored("auto"), true);
  assert.deepEqual(a.all(), [true, true, true, true]);
  assert.deepEqual(await a.choose("light"), { ok: true });
  assert.deepEqual(a.all(), [false, false, false, false]);
});

test("ADR 0099 I1: OS light and dark chosen: every window is dark", async () => {
  const a = app(stored("auto"), false);
  assert.deepEqual(await a.choose("dark"), { ok: true });
  assert.deepEqual(a.all(), [true, true, true, true]);
});

test("ADR 0099 I1: switching the OS while light or dark is chosen changes no window", () => {
  for (const [theme, dark] of [["light", false], ["dark", true]] as const) {
    const a = app(stored(theme), false);
    a.system(true);
    assert.deepEqual(a.all(), [dark, dark, dark, dark]);
    a.system(false);
    assert.deepEqual(a.all(), [dark, dark, dark, dark]);
  }
});

test("ADR 0099 I2: switching the OS in auto: every window follows", async () => {
  const a = app(stored("dark"), false);
  assert.deepEqual(await a.choose("auto"), { ok: true });
  assert.deepEqual(a.all(), [false, false, false, false]);
  a.system(true);
  assert.deepEqual(a.all(), [true, true, true, true]);
  a.system(false);
  assert.deepEqual(a.all(), [false, false, false, false]);
});

test("ADR 0099 I2: no setting or an unknown value is auto", () => {
  assert.equal(defaults().theme, "auto");
  assert.equal(normalize({}).theme, "auto");
  for (const raw of [undefined, null, "sepia", "Dark", 1, {}]) {
    assert.equal(normalize({ theme: raw }).theme, "auto");
    assert.equal(themeOf(raw), "auto");
  }
  for (const t of ["auto", "light", "dark"] as const) assert.equal(themeOf(t), t);
  const a = app(stored("sepia"), true);
  assert.deepEqual(a.all(), [true, true, true, true]);
  a.system(false);
  assert.deepEqual(a.all(), [false, false, false, false]);
});

test("ADR 0099 I2: an unknown value received from another window is read as auto", () => {
  const seen: boolean[] = [];
  const look = createAppearance("light", true, (dark) => seen.push(dark));
  look.receive({ theme: "sepia" });
  assert.equal(look.theme(), "auto");
  assert.equal(seen.at(-1), true);
  look.receive(null);
  assert.equal(look.theme(), "auto");
});

test("ADR 0099 I3: a failed save keeps every window and the config at the last saved value", async () => {
  const a = app(stored("light"), true);
  a.disk.fail = true;
  const r = await a.choose("dark");
  assert.equal(r.ok, false);
  assert.match(String(!r.ok && r.error), /disk full/);
  assert.equal(a.windows[0].config.theme, "light");
  assert.deepEqual(a.all(), [false, false, false, false]);
  assert.equal(normalize(JSON.parse(a.disk.text)).theme, "light");
});

test("ADR 0099 I3: a new window and a restart use the last value saved", async () => {
  const a = app(stored("auto"), false);
  await a.choose("dark");
  a.disk.fail = true;
  await a.choose("light");
  const late = a.open("plot");
  assert.equal(late.look.theme(), "dark");
  assert.equal(a.shown.get("plot"), true);
  const restarted = app(a.disk.text, false);
  assert.deepEqual(restarted.all(), [true, true, true, true]);
});

test("ADR 0099 I4: changing the appearance saves nothing but the theme", async () => {
  const before = normalize({ theme: "light", manuscript: { cols: 30, rows: 25 }, dpi: 300, markdownBreaks: "blank-line", charsOverride: 42 });
  const saved: string[] = [];
  const config = structuredClone(before);
  await chooseTheme(config, "dark", async (c) => void saved.push(JSON.stringify(c)), () => {});
  const after = normalize(JSON.parse(saved[0]));
  assert.equal(after.theme, "dark");
  assert.deepEqual({ ...after, theme: before.theme }, before);
});

test("ADR 0099: the setting shows the three choices with the current one selected", () => {
  for (const t of ["auto", "light", "dark"] as const) {
    const html = themeChoicesHtml(t);
    const buttons = [...html.matchAll(/<span class="btn( pri)?" data-theme="(\w+)" aria-pressed="(true|false)">([^<]+)<\/span>/g)];
    assert.deepEqual(buttons.map((b) => b[2]), ["auto", "light", "dark"]);
    assert.deepEqual(buttons.map((b) => b[4]), ["OS に合わせる", "ライト", "ダーク"]);
    assert.deepEqual(buttons.filter((b) => b[1]).map((b) => b[2]), [t]);
    assert.deepEqual(buttons.filter((b) => b[3] === "true").map((b) => b[2]), [t]);
  }
});

test("ADR 0099: a drawing that depends on the theme is drawn again when the theme changes", () => {
  assert.notEqual(drawingRevision("graph TD; a-->b", true), drawingRevision("graph TD; a-->b", false));
  assert.equal(drawingRevision("graph TD; a-->b", true), drawingRevision("graph TD; a-->b", true));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarOf, insertRow, linesCell, moveRow, namesCell, newRow, parsePlot, stackLanes, targetFor, writePlot, type PlotRow } from "./data.ts";

const CSV = "scene,file,subplots,pov,characters,place,must,flavor,target,memo,fragments,start,end,天気\n" +
  '霧笛,chapters/01.gm,本筋,私,私、父,岬,"父が油を量る;母の不在",霧笛の回数,900,,,冬のはじめ,冬至,霧\n' +
  "\n" +
  "帳面,chapters/01.gm,本筋,私,私,台所,油が減る,,400,,,冬至,,\n";

test("reading: the fixed columns, the added ones after them, empty lines skipped", () => {
  const p = parsePlot(CSV);
  assert.deepEqual(p.extras, ["天気"]);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].must, "父が油を量る;母の不在");
  assert.equal(p.rows[0]["天気"], "霧");
  assert.equal(p.rows[1].end, "");
});

test("reading a file whose header lacks fixed columns, or has them in another order", () => {
  const p = parsePlot("start,scene,色\n冬,霧笛,青\n");
  assert.deepEqual(p.extras, ["色"]);
  assert.equal(p.rows[0].scene, "霧笛");
  assert.equal(p.rows[0].start, "冬");
  assert.equal(p.rows[0].file, "");
});

test("writing and reading again gives the same table", () => {
  const p = parsePlot(CSV);
  assert.deepEqual(parsePlot(writePlot(p.rows, p.extras)), p);
  assert.equal(parsePlot("").rows.length, 0);
});

test("names split on ; ； 、 , and line breaks; sentences on ; ； and line breaks", () => {
  assert.deepEqual(namesCell("私、父;母；灯台守,  港の青年\n郵便局員"), ["私", "父", "母", "灯台守", "港の青年", "郵便局員"]);
  assert.deepEqual(linesCell("油を量る、毎晩;母の不在；\n手紙"), ["油を量る、毎晩", "母の不在", "手紙"]);
  assert.deepEqual(namesCell(""), []);
});

const row = (start: string, end = ""): PlotRow => ({ ...newRow([]), start, end });

test("calendar: the file's order, then times it lacks in the table's order", () => {
  assert.deepEqual(calendarOf([row("冬至"), row("春"), row("初雪")], ["初雪", "冬至"]), ["初雪", "冬至", "春"]);
});

test("calendar without a file: numbers and dates by value, other labels in the table's order", () => {
  assert.deepEqual(calendarOf([row("10"), row("2"), row("-1", "3")], []), ["-1", "2", "3", "10"]);
  assert.deepEqual(calendarOf([row("2026-03"), row("2025"), row("2026-01-15")], []), ["2025", "2026-01-15", "2026-03"]);
  assert.deepEqual(calendarOf([row("帝国暦302年・春"), row("2025"), row("冬")], []), ["帝国暦302年・春", "2025", "冬"]);
});

test("stacking: overlapping bars of a lane go to the first free row", () => {
  // [start, end) in calendar steps
  const r = stackLanes([
    { s: 0, e: 2 },
    { s: 2, e: 3 }, // touches, does not overlap
    { s: 1, e: 3 }, // overlaps the first
    { s: 0, e: 2 }, // overlaps both rows
    { s: 3, e: 4 },
  ]);
  assert.deepEqual(r.rows, [0, 0, 2, 1, 0]); // the earliest start is placed first
  assert.equal(r.count, 3);
  assert.deepEqual(stackLanes([]), { rows: [], count: 1 });
});

test("moving a row before another index, and inserting", () => {
  const xs = ["a", "b", "c", "d"];
  assert.deepEqual(moveRow(xs, 0, 3), ["b", "c", "a", "d"]); // back
  assert.deepEqual(moveRow(xs, 3, 1), ["a", "d", "b", "c"]); // forward
  assert.deepEqual(moveRow(xs, 1, 1), xs); // same place
  assert.deepEqual(moveRow(xs, 1, 2), xs); // just after itself
  assert.deepEqual(moveRow(xs, 0, 4), ["b", "c", "d", "a"]); // to the end
  assert.deepEqual(insertRow(xs, 2, "x"), ["a", "b", "x", "c", "d"]);
  assert.deepEqual(insertRow(xs, 9, "x"), ["a", "b", "c", "d", "x"]);
});

test("the planned characters of a sheet: the sum of its rows' targets", () => {
  const p = parsePlot(CSV);
  assert.equal(targetFor(p.rows, "/w/p", "/w/p/chapters/01.gm"), 1300);
  assert.equal(targetFor(p.rows, "/w/p", "/w/p/chapters/02.gm"), null);
});

test("cells beyond the header are dropped, and the table reads back the same", async () => {
  const p = parsePlot("scene,start\n霧笛,冬,余り,もう一つ\n");
  assert.equal(p.rows[0].scene, "霧笛");
  assert.equal(p.rows[0].start, "冬");
  assert.deepEqual(p.extras, []);
  assert.ok(!Object.values(p.rows[0]).includes("余り"));
  assert.deepEqual(parsePlot(writePlot(p.rows, p.extras)), p);
});

test("bars on the calendar: the end is included; a scene without an end takes one step and stacks against one at the same start", async () => {
  const { barsOf } = await import("./data.ts");
  const cal = ["初雪", "冬至", "春"];
  const rows = [row("初雪", "冬至"), row("冬至"), row("冬至", "春"), row("どこにもない")];
  assert.deepEqual(barsOf(rows, [0, 1, 2, 3], cal), [
    { i: 0, s: 0, e: 2 },
    { i: 1, s: 1, e: 2 },
    { i: 2, s: 1, e: 3 },
  ]);
  const st = stackLanes(barsOf(rows, [1, 2], cal));
  assert.deepEqual(st.rows, [0, 1]);
});

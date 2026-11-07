import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDelimited, writeDelimited } from "./csv.ts";

test("quotes, doubled quotes, separators and line breaks in a cell", () => {
  assert.deepEqual(parseDelimited('a,"b,c","d ""e""","f\ng"\n1,2,3,4\n', ","), [
    ["a", "b,c", 'd "e"', "f\ng"],
    ["1", "2", "3", "4"],
  ]);
});

test("CRLF, a last line without a newline, empty cells and empty lines", () => {
  assert.deepEqual(parseDelimited("a,,c\r\n\r\nx,y", ","), [["a", "", "c"], [""], ["x", "y"]]);
});

test("TSV has no quoting", () => {
  assert.deepEqual(parseDelimited('a\t"b"\tc\n', "\t"), [["a", '"b"', "c"]]);
});

test("writing quotes only what needs it, and reads back the same", () => {
  const rows = [["scene", "must"], ["霧笛", "父が油を量る;\n母の不在"], ['引用"', "a,b"]];
  const text = writeDelimited(rows, ",");
  assert.equal(text, 'scene,must\n霧笛,"父が油を量る;\n母の不在"\n"引用""","a,b"\n');
  assert.deepEqual(parseDelimited(text, ","), rows);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { autoDpi, lengthInches, pageInches } from "./pages.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-3, `${a} ≈ ${b}`);

test("lengths in Golem's units", () => {
  near(lengthInches("25.4mm")!, 1);
  near(lengthInches("72pt")!, 1);
  near(lengthInches("4Q")!, 1 / 25.4);
  near(lengthInches("4H")!, 1 / 25.4);
  near(lengthInches("5.5in")!, 5.5);
  assert.equal(lengthInches("3zw"), null);
});

test("the page width: a named size, plus the bleed on both sides", () => {
  near(pageInches('[page]\nsize = "A6"\nbleed = "3mm"\n\n[page.grid]\ncharacters = 38\n'), 111 / 25.4);
  near(pageInches('[page]\nsize = "A5"\n'), 148 / 25.4);
  near(pageInches('[page]\nsize = "四六判"\n'), 127 / 25.4);
  near(pageInches('[page]\nsize = "mass-market"\n'), 4.25);
});

test("the page width: a size written as dimensions", () => {
  near(pageInches('[page]\nsize = { width = "5.5in", height = "8.5in" }\n'), 5.5);
  near(pageInches('[page]\nsize = { height = "210mm", width = "148mm" }\nbleed = "0mm"\n'), 148 / 25.4);
});

test("without a size, A5 is assumed; a size outside [page] is not read", () => {
  near(pageInches(""), 148 / 25.4);
  near(pageInches('[headings.1]\nsize = "A6"\n'), 148 / 25.4);
});

test("the automatic resolution fills the pane on this screen at this zoom", () => {
  const inches = 111 / 25.4;
  assert.equal(autoDpi({ width: 500, ratio: 2, zoom: 1, inches }), Math.ceil((464 * 2) / inches));
  assert.equal(autoDpi({ width: 500, ratio: 2, zoom: 2, inches }), Math.ceil((464 * 4) / inches));
  assert.equal(autoDpi({ width: 500, ratio: 1, zoom: 0.5, inches }), Math.ceil(464 / inches)); // never below the pane
});

test("the resolution is kept between 72 and 1200, and a fixed one wins", () => {
  assert.equal(autoDpi({ width: 60, ratio: 1, zoom: 1, inches: 8 }), 72);
  assert.equal(autoDpi({ width: 3000, ratio: 3, zoom: 4, inches: 4 }), 1200);
  assert.equal(autoDpi({ width: 500, ratio: 2, zoom: 1, inches: 4, fixed: 150 }), 150);
});

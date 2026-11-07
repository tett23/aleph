import { test } from "node:test";
import assert from "node:assert/strict";
import { stripRemoteImages } from "./svgimages.ts";

test("remote images leave a drawn diagram; local ones stay (docs/adr/0047)", () => {
  const svg = `<svg><image href="https://e.example/a.png" width="1"/><image xlink:href='http://e.example/b.png'></image><image href="//e.example/c.png"/><image href="#local"/><g><foreignObject><div><img src="https://e.example/d.png"><img src="x.png"></div></foreignObject></g></svg>`;
  const out = stripRemoteImages(svg);
  assert.doesNotMatch(out, /e\.example/);
  assert.match(out, /<image href="#local"\/>/);
  assert.match(out, /<img src="x.png">/);
});

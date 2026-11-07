// Tests of scripts/bundle-tools.sh with fake releases served from file:// (docs/adr/0008).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "bundle-tools.sh");

/** A fake release of `name` with an archive holding an executable that prints `out`. */
const release = (base: string, name: string, tag: string, out: string, tamper = false) => {
  const top = `${name}-${tag}-test`;
  const build = mkdtempSync(join(tmpdir(), "aleph-rel-"));
  mkdirSync(join(build, top), { recursive: true });
  writeFileSync(join(build, top, name), `#!/bin/sh\necho ${out}\n`);
  chmodSync(join(build, top, name), 0o755);
  writeFileSync(join(build, top, "LICENSE"), "MIT\n");
  const dl = join(base, name, "releases", "download", tag);
  mkdirSync(dl, { recursive: true });
  execFileSync("tar", ["-czf", join(dl, `${top}.tar.gz`), "-C", build, top]);
  const sum = createHash("sha256").update(readFileSync(join(dl, `${top}.tar.gz`))).digest("hex");
  writeFileSync(join(dl, "SHA256SUMS"), `${tamper ? "0".repeat(64) : sum}  ${top}.tar.gz\n`);
  return `${name} ${tag} ${name}-{tag}-test.tar.gz\n`;
};

const run = (versions: string, base: string) => {
  const dir = mkdtempSync(join(tmpdir(), "aleph-bundle-"));
  writeFileSync(join(dir, "tools.versions"), versions);
  const res = join(dir, "resources");
  const r = spawnSync("sh", [script, join(dir, "tools.versions"), res], { env: { ...process.env, ALEPH_RELEASES_URL: `file://${base}` }, encoding: "utf8" });
  return { ...r, res };
};

test("archives that match SHA256SUMS are unpacked into the resources with their licenses", () => {
  const base = mkdtempSync(join(tmpdir(), "aleph-base-"));
  const v = "# comment\n\n" + release(base, "golem", "v1", "golem-1") + release(base, "shem", "v2", "shem-2");
  const r = run(v, base);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(execFileSync(join(r.res, "golem"), { encoding: "utf8" }), "golem-1\n");
  assert.equal(execFileSync(join(r.res, "shem"), { encoding: "utf8" }), "shem-2\n");
  assert.ok(existsSync(join(r.res, "licenses", "golem", "LICENSE")));
});

test("an archive that does not match stops the script and is not installed", () => {
  const base = mkdtempSync(join(tmpdir(), "aleph-base-"));
  const r = run(release(base, "golem", "v1", "bad", true), base);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not match SHA256SUMS/);
  assert.ok(!existsSync(join(r.res, "golem")));
});

test("a missing release stops the script", () => {
  const base = mkdtempSync(join(tmpdir(), "aleph-base-"));
  const r = run("golem v9 golem-{tag}-test.tar.gz\n", base);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot fetch/);
});

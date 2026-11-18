// Tests of scripts/bundle-tools.sh with fake releases served from file://
// (docs/adr/0008, and llama.cpp and the Golem manual of docs/adr/0081).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * A fake llama.cpp release under `base` (as github.com): an archive with no
 * SHA256SUMS, holding llama-server printing `out`, a dynamic library reached
 * through a symbolic link, LICENSE and a tool that is not copied.
 */
const llama = (base: string, tag: string, out: string, tamper = false) => {
  const top = `llama-${tag}`;
  const build = mkdtempSync(join(tmpdir(), "aleph-llama-"));
  mkdirSync(join(build, top));
  writeFileSync(join(build, top, "llama-server"), `#!/bin/sh\necho ${out}\n`);
  chmodSync(join(build, top, "llama-server"), 0o755);
  writeFileSync(join(build, top, "llama-cli"), "#!/bin/sh\n");
  writeFileSync(join(build, top, "libfoo.1.0.0.dylib"), "lib\n");
  symlinkSync("libfoo.1.0.0.dylib", join(build, top, "libfoo.1.dylib"));
  writeFileSync(join(build, top, "LICENSE"), "MIT llama\n");
  const dl = join(base, "test", "llama.cpp", "releases", "download", tag);
  mkdirSync(dl, { recursive: true });
  const archive = join(dl, `${top}-bin-test.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", build, top]);
  const sum = tamper ? "0".repeat(64) : sha256(archive);
  return `llama.cpp ${tag} llama-{tag}-bin-test.tar.gz test/llama.cpp ${sum} llama-server libfoo.1.dylib LICENSE\n`;
};

/** A fake chapter of the Golem manual under `raw` (as raw.githubusercontent.com) at the tag `tag`. */
const chapter = (raw: string, tag: string, file: string, body: string, tamper = false) => {
  const dir = join(raw, "tett23", "golem", tag, "manual", "chapters");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
  return `manual ${file} tett23/golem ${tamper ? "0".repeat(64) : sha256(join(dir, file))}\n`;
};

const run = (versions: string, base: string, more: { github?: string; raw?: string; res?: string } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "aleph-bundle-"));
  writeFileSync(join(dir, "tools.versions"), versions);
  const res = more.res ?? join(dir, "resources");
  const env = {
    ...process.env,
    ALEPH_RELEASES_URL: `file://${base}`,
    ALEPH_GITHUB_URL: `file://${more.github ?? base}`,
    ALEPH_RAW_URL: `file://${more.raw ?? base}`,
  };
  const r = spawnSync("sh", [script, join(dir, "tools.versions"), res], { env, encoding: "utf8" });
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

test("a later archive that does not match leaves nothing installed, not even the earlier one", () => {
  const base = mkdtempSync(join(tmpdir(), "aleph-base-"));
  const r = run(release(base, "golem", "v1", "golem-1") + release(base, "shem", "v2", "bad", true), base);
  assert.equal(r.status, 1);
  assert.ok(!existsSync(join(r.res, "golem")));
  assert.ok(!existsSync(join(r.res, "shem")));
});

/** golem and shem releases, a llama.cpp archive and the three chapters, all good. */
const fullSet = () => {
  const base = mkdtempSync(join(tmpdir(), "aleph-base-"));
  const github = mkdtempSync(join(tmpdir(), "aleph-github-"));
  const raw = mkdtempSync(join(tmpdir(), "aleph-raw-"));
  const head = release(base, "golem", "v1", "golem-1") + release(base, "shem", "v2", "shem-2") + llama(github, "b7", "llama-7");
  const chapters = ["03-markup.gm", "04-manifest.gm", "05-style.gm"].map((f) => chapter(raw, "v1", f, `# ${f}\n`)).join("");
  return { base, github, raw, head, chapters };
};

test("a llama.cpp archive and manual chapters that match tools.versions are installed with golem and shem", () => {
  const s = fullSet();
  const r = run(s.head + s.chapters, s.base, s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(execFileSync(join(r.res, "golem"), { encoding: "utf8" }), "golem-1\n");
  assert.equal(execFileSync(join(r.res, "shem"), { encoding: "utf8" }), "shem-2\n");
  assert.equal(execFileSync(join(r.res, "llama.cpp", "llama-server"), { encoding: "utf8" }), "llama-7\n");
  // the library is copied as a file under the name llama-server loads it by
  const lib = join(r.res, "llama.cpp", "libfoo.1.dylib");
  assert.ok(lstatSync(lib).isFile());
  assert.equal(readFileSync(lib, "utf8"), "lib\n");
  assert.ok(!existsSync(join(r.res, "llama.cpp", "llama-cli")));
  assert.ok(!existsSync(join(r.res, "llama.cpp", "LICENSE")));
  assert.equal(readFileSync(join(r.res, "licenses", "llama.cpp", "LICENSE"), "utf8"), "MIT llama\n");
  for (const f of ["03-markup.gm", "04-manifest.gm", "05-style.gm"]) {
    assert.equal(readFileSync(join(r.res, "manual", f), "utf8"), `# ${f}\n`);
  }
});

test("a llama.cpp archive that does not match its SHA-256 leaves the resources untouched", () => {
  const s = fullSet();
  const r = run(release(s.base, "golem", "v1", "golem-1") + llama(s.github, "b7", "bad", true) + s.chapters, s.base, s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /llama-b7-bin-test\.tar\.gz does not match its SHA-256/);
  assert.ok(!existsSync(join(r.res, "golem")));
  assert.ok(!existsSync(join(r.res, "llama.cpp")));
  assert.ok(!existsSync(join(r.res, "manual")));
});

test("a manual chapter that does not match its SHA-256 leaves the resources untouched", () => {
  const s = fullSet();
  const bad = chapter(s.raw, "v1", "05-style.gm", "# changed\n", true);
  const r = run(s.head + chapter(s.raw, "v1", "03-markup.gm", "# 03\n") + bad, s.base, s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /05-style\.gm does not match its SHA-256/);
  assert.ok(!existsSync(join(r.res, "golem")));
  assert.ok(!existsSync(join(r.res, "llama.cpp")));
  assert.ok(!existsSync(join(r.res, "manual")));
});

test("the manual is taken from the source at the tag of the golem row", () => {
  const s = fullSet();
  // the chapter exists only at another tag
  const r = run(release(s.base, "golem", "v1", "golem-1") + chapter(s.raw, "v0", "03-markup.gm", "# old\n"), s.base, s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot fetch .*\/v1\/manual\/chapters\/03-markup\.gm/);
});

test("manual rows without a golem row are a usage error", () => {
  const s = fullSet();
  const r = run(chapter(s.raw, "v1", "03-markup.gm", "# 03\n"), s.base, s);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /golem row/);
});

test("a file that tools.versions lists but the llama.cpp archive lacks stops the script", () => {
  const s = fullSet();
  const row = llama(s.github, "b8", "llama-8").replace("LICENSE", "libmissing.dylib LICENSE");
  const r = run(row, s.base, s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no libmissing\.dylib in llama-b8-bin-test\.tar\.gz/);
  assert.ok(!existsSync(join(r.res, "llama.cpp")));
});

test("bundling again replaces the llama.cpp and manual directories, not leaving old files", () => {
  const s = fullSet();
  const res = join(mkdtempSync(join(tmpdir(), "aleph-res-")), "resources");
  mkdirSync(join(res, "llama.cpp"), { recursive: true });
  mkdirSync(join(res, "manual"), { recursive: true });
  writeFileSync(join(res, "llama.cpp", "libold.dylib"), "old\n");
  writeFileSync(join(res, "manual", "99-old.gm"), "old\n");
  const r = run(s.head + s.chapters, s.base, { ...s, res });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(res, "llama.cpp", "llama-server")));
  assert.ok(!existsSync(join(res, "llama.cpp", "libold.dylib")));
  assert.ok(!existsSync(join(res, "manual", "99-old.gm")));
});

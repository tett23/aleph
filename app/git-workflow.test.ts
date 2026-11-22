import assert from "node:assert/strict";
import { test } from "node:test";
import { commitWithIdentity, identityInputValid, identityWarningKey, withGitCredentials } from "./git-workflow.ts";

test("ADR 0105 I3: failed preflight prevents both sheet save and commit", async () => {
  const operations: string[] = [];
  await assert.rejects(commitWithIdentity(async () => {
    operations.push("preflight");
    throw new Error("identity required");
  }, async () => { operations.push("save"); }, async () => { operations.push("commit"); }));
  assert.deepEqual(operations, ["preflight"]);
});

test("ADR 0105 I4: one local key can accompany inherited identity, but blank global keys are invalid", () => {
  const inherited = { name: { value: "Name", source: "~/.gitconfig" }, email: null };
  assert.equal(identityInputValid("", "mail@example.test", inherited), true);
  assert.equal(identityInputValid("", "mail@example.test"), false);
  assert.equal(identityInputValid("", "bad\nmail", inherited), false);
});

test("ADR 0105 I6: cancellation stops the operation before a retry", async () => {
  let attempts = 0;
  await assert.rejects(withGitCredentials(async () => {
    attempts++;
    throw { kind: "authRequired", message: "credentials required", authTarget: "target" };
  }, async () => null), { kind: "authentication" });
  assert.equal(attempts, 1);
});


test("ADR 0105 I6: credentials are bound to the challenged remote and are attempted once", async () => {
  let attempts = 0;
  await assert.rejects(withGitCredentials(async (credentials) => {
    attempts++;
    if (!credentials) throw { kind: "authRequired", message: "credentials required", authTarget: "target" };
    assert.deepEqual(credentials, { username: "user", password: "token", target: "target" });
    throw { kind: "authentication", message: "wrong credentials" };
  }, async () => ({ username: "user", password: "token" })), { kind: "authentication" });
  assert.equal(attempts, 2);
});

test("ADR 0105 I3: linked worktrees share the warning for the same missing fields", () => {
  const config = "/main/.git/config";
  const main = { repository: "/main", identityTarget: config, missing: ["name", "email"] as const };
  const linked = { repository: "/linked", identityTarget: config, missing: ["email", "name"] as const };
  assert.equal(identityWarningKey(main), identityWarningKey(linked));
  assert.notEqual(identityWarningKey(main), identityWarningKey({ ...linked, missing: ["email"] }));
  assert.notEqual(identityWarningKey(main), identityWarningKey({ ...linked, identityTarget: "/other/.git/config" }));
});

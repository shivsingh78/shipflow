import { test } from "node:test";
import assert from "node:assert/strict";

import { sensitiveCodeReason, forbiddenPathReason } from "../../dist/src/repopilot/paths.js";
import { validatePatchProposal, patchDigest } from "../../dist/src/repopilot/patch.js";
import { buildPatchPrompt, excerptFor, PATCH_SYSTEM_PROMPT, PATCH_TOOL } from "../../dist/src/repopilot/patchGen.js";
import { createPatchHandler } from "../../dist/src/repopilot/stagesPatch.js";
import { createManifestHandler } from "../../dist/src/repopilot/stagesIngest.js";
import { createGithubClient } from "../../dist/src/repopilot/github.js";
import { generateCredentialKeyPair, sealCredential } from "../../dist/src/repopilot/credentials.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { createFakeGithub } from "../helpers/fakeGithub.js";

const API_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const SHA = "a".repeat(40);
const keys = generateCredentialKeyPair();

// ------------------------------------------------- security-sensitive paths

test("source patches may not touch authentication, secrets, crypto, sandbox or RepoPilot code", () => {
  for (const path of [
    "src/auth/login.js", "src/auth.js", "lib/authMiddleware.js".replace("authMiddleware", "auth-middleware"), "src/authorization/check.ts", "server/oauth/callback.js", "src/session-store.js",
    "src/secrets.ts", "config/credentials.js", "src/password_reset.js", "src/crypto/hash.js", "src/jwt.js", "src/sandbox.ts", "src/egressProxy.ts".replace("egressProxy", "egress-proxy"),
    "src/repopilot/store.ts", "src/permissions/acl.js", "src/rbac.js", "src/vault/client.js", "src/login.js", "lib/csrf.js", "src/policy/engine.js",
  ]) {
    assert.notEqual(sensitiveCodeReason(path), null, path);
  }
});

test("ordinary paths, including near-misses, are allowed (whole words only)", () => {
  for (const path of ["src/index.js", "src/authors.js", "src/github.js", "src/author-list.js", "lib/envelope.js", "src/tokenizer.js", "src/policyholder.js", "src/utils/format.js", "src/passwordless.js", "src/sessionless.js"]) {
    assert.equal(sensitiveCodeReason(path), null, path);
  }

  // The function is role-agnostic; applying it only to source patches is patch.ts's job (next test).
  assert.notEqual(sensitiveCodeReason("test/auth.test.js"), null);
});

test("the sensitive-code rule applies to source patches, not to newly added tests", () => {
  const source = (path) => ["diff --git a/" + path + " b/" + path, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
  const test = (path) => ["diff --git a/" + path + " b/" + path, "new file mode 100644", "index 0000000..1111111", "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1 @@", "+x", ""].join("\n");

  const bad = validatePatchProposal({ diff: source("src/auth/login.js"), testDiff: test("test/a.test.js") });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.code === "sensitive_code" && i.role === "source"));

  assert.ok(validatePatchProposal({ diff: source("src/index.js"), testDiff: test("test/auth.test.js") }).ok, "a test about auth is fine; changing auth is not");
  assert.equal(forbiddenPathReason("src/auth/login.js"), null, "the sensitivity rule is separate from the forbidden-file list");
});

// ---------------------------------------------------------------- prompting

const manifest = { version: 1, repo: { owner: "acme", name: "widgets" }, commitSha: SHA, package: { name: "demo", type: "module", testScript: "node --test" } };
const finding = { id: 4, title: "Unchecked JSON.parse", category: "error-handling", severity: "high", evidenceKind: "observed", file: "src/index.js", lineStart: 1, lineEnd: 1, evidence: "JSON.parse(x) can throw.", impact: "Crash.", remediation: "Catch it." };

test("the patch prompt states the rules, binds to the commit and finding, and scrubs secrets", () => {
  const out = buildPatchPrompt({ manifest, finding, file: { path: "src/index.js", content: `const k = "${API_KEY}";\nconst a = JSON.parse(x);\n` }, testSamples: [{ path: "test/a.test.js", content: "import test from 'node:test';\n" }], boundary: "0123456789abcdef" });

  assert.match(out.user, new RegExp(`commit ${SHA}`));
  assert.match(out.user, /test script: node --test/);
  assert.match(out.user, /title: Unchecked JSON\.parse/);
  assert.match(out.user, /location: src\/index\.js lines 1-1/);
  assert.ok(!out.user.includes(API_KEY));
  assert.match(out.user, /2\| const a = JSON\.parse\(x\);/);
  assert.equal((out.user.match(/<<<END 0123456789abcdef>>>/g) ?? []).length, 2);
  assert.match(out.system, /Never modify: CI\/workflow files/);
  assert.match(out.system, /authentication, authorisation, secret-handling/);
  assert.match(out.system, /Do not claim the change or the test has been run/);
  assert.equal(PATCH_TOOL.name, "propose_patch");
  assert.equal(PATCH_SYSTEM_PROMPT, out.system);
});

test("big files are shown as a window around the finding, small ones whole", () => {
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
  const windowed = excerptFor(big, { lineStart: 1000, lineEnd: 1002 });

  assert.match(windowed.note, /lines 750-1252 of 2000/);
  assert.match(windowed.text, /1000\| line 1000/);
  assert.ok(!windowed.text.includes("line 100\n") && !windowed.text.includes("| line 1900"));
  assert.match(excerptFor("a\nb\n", { lineStart: 1, lineEnd: 1 }).note, /entire file, 2 lines/);
});

// ------------------------------------------------------------ stage handler

const INDEX = "const a = JSON.parse(x);\nexport default a;\nfunction f() {}\n";
const FILES = { "package.json": JSON.stringify({ name: "demo", scripts: { test: "node --test" } }), "package-lock.json": "{}", "src/index.js": INDEX, "src/auth/login.js": "export const login = 1;\n", "test/old.test.js": "// old\n" };
const GOOD_DIFF = ["diff --git a/src/index.js b/src/index.js", "index 1111111..2222222 100644", "--- a/src/index.js", "+++ b/src/index.js", "@@ -1,2 +1,2 @@", "-const a = JSON.parse(x);", "+const a = (() => { try { return JSON.parse(x); } catch { return null; } })();", " export default a;", ""].join("\n");
const GOOD_TEST = ["diff --git a/test/new.test.js b/test/new.test.js", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/test/new.test.js", "@@ -0,0 +1,2 @@", "+import test from 'node:test';", "+test('handles bad json', () => {});", ""].join("\n");
const proposal = (o = {}) => ({ title: "Guard JSON.parse", explanation: "Wrap in try/catch.", diff: GOOD_DIFF, testDiff: GOOD_TEST, ...o });
const toolReply = (input) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", name: "propose_patch", input }], usage: { input_tokens: 700, output_tokens: 400 } }) });
const RUN = { id: 7, owner: "instance", repoOwner: "acme", repoName: "widgets", commitSha: SHA, defaultBranch: "main" };

async function fixture({ answer = toolReply(proposal()), findingOverride, params = { findingId: 4 }, files = FILES } = {}) {
  const gh = createFakeGithub({ owner: "acme", name: "widgets", branches: { main: SHA }, commits: { [SHA]: files } });
  const github = createGithubClient({ token: "ghp_unitTestTokenValue0123456789abcdef", fetch: gh.fetch, timeoutMs: 1000 });
  const objects = new Map();
  const evidence = { put: async (k, b) => void objects.set(k, Buffer.from(b)), get: async (k) => objects.get(k) ?? null, remove: async () => {} };
  const artifacts = [];
  const aiCalls = [];
  const usage = [];
  const inserted = [];
  const tx = {
    run: RUN, setRunFacts: async () => {},
    insertArtifact: async (i) => (artifacts.push({ ...i, id: artifacts.length + 1 }), artifacts.at(-1)),
    insertPatch: async (findingId, p, options) => {
      const validation = validatePatchProposal(p, options);
      const usable = validation.ok && (options.apply?.ok ?? true);
      inserted.push({ findingId, proposal: p, options, validation, usable });

      return { patch: { id: 9, baseCommit: SHA, diffSha256: patchDigest(p.diff, p.testDiff), title: p.title, explanation: p.explanation }, validation, usable };
    },
  };
  const store = {
    listArtifacts: async () => artifacts.filter((a) => a.kind === "manifest"),
    getFinding: async (_o, _r, id) => (id === 4 ? { ...finding, ...findingOverride } : null),
    readCredentialCiphertext: async () => sealCredential(keys.publicKeyPem, API_KEY),
    reserveAiRequest: async () => true,
    recordAiUsage: async (_id, u) => void usage.push(u),
  };
  const config = loadRepoPilotConfig({});
  const base = { store, github, evidence, config };

  await (await createManifestHandler(base)({ run: RUN, signal: new AbortController().signal, log: async () => {} })).persist(tx);

  const ai = async (url, init) => { aiCalls.push({ url, init, body: JSON.parse(init.body) }); return answer; };
  const handler = createPatchHandler({ ...base, ai: { credentialPrivateKey: keys.privateKeyPem, fetch: ai, timeoutMs: 1000 } });
  const context = { run: RUN, stage: "patch", attempt: 1, params, signal: new AbortController().signal, log: async () => {} };

  return { handler, context, tx, inserted, usage, aiCalls, objects, artifacts, gh };
}

test("a clean proposal is dry-run against the pinned snapshot and stored with both verdicts", async () => {
  const fx = await fixture();
  const out = await fx.handler(fx.context);

  assert.equal(fx.aiCalls.length, 1);
  assert.equal(fx.aiCalls[0].body.tool_choice.name, "propose_patch");
  assert.deepEqual(fx.usage, [{ inputTokens: 700, outputTokens: 400 }]);
  assert.ok(!JSON.stringify(fx.aiCalls[0].body).includes(API_KEY));

  const result = await out.persist(fx.tx);
  const saved = fx.inserted[0];

  assert.deepEqual(result, {}, "usable patches continue to verification");
  assert.equal(saved.findingId, 4);
  assert.deepEqual(saved.options.apply, { ok: true, issues: [] });
  assert.equal(saved.proposal.diff, GOOD_DIFF, "the model's bytes are stored untouched");

  const kinds = fx.artifacts.map((a) => a.kind);
  assert.deepEqual(kinds, ["manifest", "patch", "patch_validation"]);

  const patchObject = JSON.parse(fx.objects.get(fx.artifacts[1].objectKey).toString());
  assert.equal(patchObject.diff, GOOD_DIFF, "patch evidence keeps exact bytes (not redacted)");
  assert.equal(patchObject.diffSha256, patchDigest(GOOD_DIFF, GOOD_TEST));

  const report = JSON.parse(fx.objects.get(fx.artifacts[2].objectKey).toString());
  assert.match(report.note, /does not mean correct or verified/);
});

test("a policy-violating proposal is stored for review, never dry-run, and sent back for a new choice", async () => {
  for (const [diff, code] of [
    [GOOD_DIFF.replaceAll("src/index.js", "package.json"), "forbidden_path"],
    [GOOD_DIFF.replaceAll("src/index.js", "src/auth/login.js"), "sensitive_code"],
    [GOOD_DIFF.replaceAll("src/index.js", ".github/workflows/ci.js"), "forbidden_path"],
  ]) {
    const fx = await fixture({ answer: toolReply(proposal({ diff })) });
    const out = await fx.handler(fx.context);
    const result = await out.persist(fx.tx);

    assert.deepEqual(result, { rejected: true }, code);
    assert.ok(fx.inserted[0].validation.issues.some((i) => i.code === code), code);
    assert.equal(fx.inserted[0].options.apply.issues[0].code, "not_applied");
    assert.equal(fx.inserted[0].proposal.diff, diff, "the rejected bytes are preserved");
  }
});

test("a diff that does not apply to the pinned file is rejected with the reason", async () => {
  const stale = GOOD_DIFF.replace("-const a = JSON.parse(x);", "-const a = JSON.parse(y);");
  const fx = await fixture({ answer: toolReply(proposal({ diff: stale })) });
  const result = await (await fx.handler(fx.context)).persist(fx.tx);

  assert.deepEqual(result, { rejected: true });
  assert.equal(fx.inserted[0].options.apply.ok, false);
  assert.equal(fx.inserted[0].options.apply.issues[0].code, "context_mismatch");
  assert.equal(fx.inserted[0].validation.ok, true, "policy passed; applying failed");
});

test("a test file that already exists cannot be added", async () => {
  const clash = GOOD_TEST.replaceAll("test/new.test.js", "test/old.test.js");
  const fx = await fixture({ answer: toolReply(proposal({ testDiff: clash })) });
  const result = await (await fx.handler(fx.context)).persist(fx.tx);

  assert.deepEqual(result, { rejected: true });
  assert.ok(fx.inserted[0].validation.issues.some((i) => i.code === "add_existing_file"));
});

test("model answers that claim results or break the schema are rejected before any patch is stored", async () => {
  for (const [input, code] of [[{ ...proposal(), testsPassed: true }, "ai_forbidden_field"], [{ ...proposal(), verified: true }, "ai_forbidden_field"], [{ title: "t", explanation: "e", diff: GOOD_DIFF }, "ai_malformed_output"], [{ ...proposal(), diff: "" }, "ai_malformed_output"]]) {
    const fx = await fixture({ answer: toolReply(input) });

    await assert.rejects(() => fx.handler(fx.context), (e) => e.code === code && e.retryable === true, code);
    assert.equal(fx.inserted.length, 0);
    assert.equal(fx.usage.length, 1, "spent tokens are still counted");
  }
});

test("only a finding of this run in a patchable source file is accepted", async () => {
  await assert.rejects(async () => (await fixture({ params: {} })).handler((await fixture({ params: {} })).context), (e) => e.code === "finding_missing");
  await assert.rejects(async () => { const fx = await fixture({ params: { findingId: 99 } }); await fx.handler(fx.context); }, (e) => e.code === "finding_missing");
  await assert.rejects(async () => { const fx = await fixture({ findingOverride: { file: "test/old.test.js" } }); await fx.handler(fx.context); }, (e) => e.code === "finding_not_patchable");
  await assert.rejects(async () => { const fx = await fixture({ findingOverride: { file: "src/ghost.js" } }); await fx.handler(fx.context); }, (e) => e.code === "finding_not_patchable");
});

test("a missing patch request never reaches the provider", async () => {
  const fx = await fixture({ params: {} });

  await assert.rejects(() => fx.handler(fx.context), (e) => e.code === "finding_missing" && !e.retryable);
  assert.equal(fx.aiCalls.length, 0);
});

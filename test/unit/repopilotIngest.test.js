import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createGithubClient, githubFailure, GITHUB_API } from "../../dist/src/repopilot/github.js";
import { buildManifest, selectContext, readPackageInfo, estimateTokens } from "../../dist/src/repopilot/manifest.js";
import { createIngestHandler, createManifestHandler, loadManifest } from "../../dist/src/repopilot/stagesIngest.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { StageError } from "../../dist/src/repopilot/errors.js";
import { evidenceKey } from "../../dist/src/repopilot/evidence.js";
import { createFakeGithub } from "../helpers/fakeGithub.js";

const TOKEN = "ghp_unitTestTokenValue0123456789abcdef";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const PKG = JSON.stringify({ name: "demo", scripts: { test: "node --test" }, main: "src/index.js" });
const FILES = { "package.json": PKG, "package-lock.json": "{}", "src/index.js": "export const a = 1;\n", "src/util.js": "export const b = 2;\n", "test/util.test.js": "import test from 'node:test';\n" };

const repoSpec = (extra = {}) => ({ owner: "acme", name: "widgets", defaultBranch: "main", branches: { main: SHA, dev: SHA2 }, commits: { [SHA]: FILES, [SHA2]: FILES }, ...extra });
const clientFor = (fake, token = TOKEN) => createGithubClient({ token, fetch: fake.fetch, timeoutMs: 1000 });
const failsWith = (code) => (error) => error instanceof StageError && error.code === code;

// ----------------------------------------------------------- GitHub client

test("the token only ever travels in the Authorization header, to api.github.com, with redirects refused", async () => {
  const fake = createFakeGithub(repoSpec());
  const github = clientFor(fake);

  await github.getRepository("acme", "widgets");
  await github.resolveCommit("acme", "widgets", "main");
  await github.getTree("acme", "widgets", SHA);

  assert.equal(fake.requests.length, 3);

  for (const request of fake.requests) {
    assert.equal(request.host, new URL(GITHUB_API).host);
    assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(request.redirect, "error");
    assert.ok(!request.url.includes(TOKEN), "token must not be in the URL");
    assert.ok(request.url.startsWith(GITHUB_API));
  }
});

test("without a token nothing is requested and the error says how to fix it", async () => {
  const fake = createFakeGithub(repoSpec());

  await assert.rejects(() => clientFor(fake, null).getRepository("acme", "widgets"), (e) => failsWith("github_not_configured")(e) && /REPOPILOT_GITHUB_TOKEN/.test(e.message));
  assert.equal(fake.requests.length, 0);
});

test("owner and repository names are validated before any request", async () => {
  const fake = createFakeGithub(repoSpec());
  const github = clientFor(fake);

  for (const [owner, name] of [["acme/../x", "widgets"], ["acme", "../../admin"], ["-bad", "w"], ["acme", ""], ["acme", ".."], ["a b", "w"], ["acme", "w?x=1"], ["acme", "w#f"]]) {
    await assert.rejects(() => github.getRepository(owner, name), failsWith("invalid_repository"), `${owner}/${name}`);
  }

  assert.equal(fake.requests.length, 0);
});

test("a ref is URL-encoded so it cannot traverse to another endpoint", async () => {
  const fake = createFakeGithub(repoSpec());

  await assert.rejects(() => clientFor(fake).resolveCommit("acme", "widgets", "../../repos/other/secret/commits/main"));
  assert.ok(fake.requests[0].url.includes("%2F"));
  assert.ok(!fake.requests[0].url.includes("/../"));
});

test("HTTP failures map to stable, actionable codes and never leak the token", () => {
  const h = (map = {}) => ({ get: (name) => map[name.toLowerCase()] ?? null });
  const cases = [
    [401, h(), "{}", "github_auth_failed", false],
    [403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }), "{}", "github_rate_limited", true],
    [403, h({ "retry-after": "30" }), "{}", "github_rate_limited", true],
    [403, h(), '{"message":"You have exceeded a secondary rate limit"}', "github_rate_limited", true],
    [429, h(), "{}", "github_rate_limited", true],
    [403, h(), '{"message":"Resource not accessible by personal access token"}', "github_forbidden", false],
    [404, h(), "{}", "repository_not_accessible", false],
    [409, h(), "{}", "repository_empty", false],
    [422, h(), "{}", "invalid_ref", false],
    [451, h(), "{}", "repository_unavailable", false],
    [301, h(), "{}", "repository_moved", false],
    [502, h(), "{}", "github_unavailable", true],
    [418, h(), `{"message":"teapot ${TOKEN}"}`, "github_error", false],
  ];

  for (const [status, headers, body, code, retryable] of cases) {
    const error = githubFailure(status, headers, body);
    assert.equal(error.code, code, `${status}`);
    assert.equal(error.retryable, retryable, `${status}`);
    assert.ok(!error.message.includes(TOKEN), `${status} leaked the token`);
  }

  assert.match(githubFailure(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }), "{}").message, /Resets at 2030-/);
});

test("network errors and timeouts are retryable and carry no URL or token", async () => {
  const fake = createFakeGithub(repoSpec());
  fake.fail.set("/repos/acme/widgets", { throw: `getaddrinfo ENOTFOUND api.github.com while fetching ${GITHUB_API}/repos/acme/widgets?token=${TOKEN}` });

  await assert.rejects(() => clientFor(fake).getRepository("acme", "widgets"), (e) => failsWith("github_unavailable")(e) && e.retryable === true && !e.message.includes(TOKEN) && !e.message.includes("ENOTFOUND"));
});

test("a redirect is reported as a moved repository, not followed", async () => {
  const fake = createFakeGithub(repoSpec());
  fake.fail.set("/repos/acme/widgets", { throw: "fetch failed: unexpected redirect" });

  await assert.rejects(() => clientFor(fake).getRepository("acme", "widgets"), failsWith("repository_moved"));
});

test("malformed, oversized or wrong-shaped responses are rejected", async () => {
  const fake = createFakeGithub(repoSpec());
  const github = clientFor(fake);

  fake.fail.set("/repos/acme/widgets", { status: 200, body: "not json at all" });
  await assert.rejects(() => github.getRepository("acme", "widgets"), failsWith("github_bad_response"));

  fake.fail.set("/repos/acme/widgets", { status: 200, body: { default_branch: 5, private: "yes" } });
  await assert.rejects(() => github.getRepository("acme", "widgets"), failsWith("github_bad_response"));

  fake.fail.set("/repos/acme/widgets", { status: 200, body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }) });
  await assert.rejects(() => github.getRepository("acme", "widgets"), failsWith("github_response_too_large"));

  fake.fail.clear();
  fake.fail.set("/commits/", { status: 200, body: { sha: "not-a-sha" } });
  await assert.rejects(() => github.resolveCommit("acme", "widgets", "main"), failsWith("github_bad_response"));
});

test("downloaded files are verified against their git object id", async () => {
  const fake = createFakeGithub(repoSpec({ corruptBlobs: new Set() }));
  const github = clientFor(fake);
  const { entries } = await github.getTree("acme", "widgets", SHA);
  const index = entries.find((e) => e.path === "src/index.js");

  assert.equal((await github.getBlob("acme", "widgets", index.sha)).toString(), FILES["src/index.js"]);

  const bad = createFakeGithub(repoSpec({ corruptBlobs: new Set([index.sha]) }));
  await assert.rejects(() => clientFor(bad).getBlob("acme", "widgets", index.sha), failsWith("github_integrity_failed"));
  await assert.rejects(() => github.getBlob("acme", "widgets", "not-a-sha"), failsWith("invalid_object"));
});

// ---------------------------------------------------------------- manifest

const item = (path, extra = {}) => ({ path, mode: "100644", type: "blob", sha: crypto.createHash("sha1").update(path).digest("hex"), size: 500, ...extra });
const LIMITS = { maxFiles: 100, maxFileBytes: 100_000, maxTotalBytes: 1_000_000 };
const build = (entries, packageJson = PKG, limits = LIMITS) => buildManifest({ repo: { owner: "a", name: "b" }, commitSha: SHA, defaultBranch: "main", entries, packageJson, limits });

test("the manifest is deterministic and independent of tree order", () => {
  const entries = [item("src/b.js"), item("src/a.js"), item("package.json"), item("package-lock.json"), item("test/a.test.js")];
  const forward = JSON.stringify(build(entries));
  const reversed = JSON.stringify(build([...entries].reverse()));

  assert.equal(forward, reversed);
  assert.deepEqual(JSON.parse(forward).files.map((f) => f.path), ["package.json", "src/a.js", "src/b.js", "test/a.test.js"]);
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(forward), "no timestamps");
});

test("secrets, binaries, generated files, vendored dirs, symlinks and submodules are excluded with a reason", () => {
  const manifest = build([
    item("src/app.js"), item(".env"), item(".env.production"), item("config/.env"), item("deploy/key.pem"), item("id_rsa"), item(".npmrc"), item("secrets.json"),
    item("logo.png"), item("dist/app.js"), item("node_modules/x/index.js"), item("src/app.min.js"), item("src/app.js.map"), item("yarn.lock"),
    item("src/link.js", { mode: "120000" }), item("vendor/mod", { mode: "160000", type: "commit" }), item("src/huge.js", { size: 200_000 }),
    item("src/../../etc/passwd.js"), item("src//double.js"), item("a\\b.js"),
  ]);

  assert.deepEqual(manifest.files.map((f) => f.path), ["src/app.js"]);
  assert.deepEqual(manifest.symlinkPaths, ["src/link.js"]);

  const reasons = manifest.skipped.byReason;
  assert.equal(reasons.sensitive_file, 7);
  assert.equal(reasons.binary, 1);
  assert.equal(reasons.excluded_directory, 2);
  assert.equal(reasons.generated, 2);
  assert.equal(reasons.lockfile, 1);
  assert.equal(reasons.symlink, 1);
  assert.equal(reasons.submodule, 1);
  assert.equal(reasons.too_large, 1);
  assert.equal(reasons.unsafe_path, 3);
  assert.equal(manifest.skipped.total, 19);
});

test("file-count and total-size limits are enforced", () => {
  const entries = Array.from({ length: 10 }, (_, i) => item(`src/f${i}.js`, { size: 400 }));

  assert.equal(build(entries, PKG, { ...LIMITS, maxFiles: 4 }).files.length, 4);
  assert.equal(build(entries, PKG, { ...LIMITS, maxFiles: 4 }).skipped.byReason.too_many_files, 6);
  assert.equal(build(entries, PKG, { ...LIMITS, maxTotalBytes: 1000 }).files.length, 2);
});

test("skip samples are bounded", () => {
  const entries = Array.from({ length: 500 }, (_, i) => item(`img/p${i}.png`));
  const manifest = build(entries);

  assert.equal(manifest.skipped.total, 500);
  assert.equal(manifest.skipped.samples.length, 50);
});

test("only a plain npm project with a real test script counts as verifiable", () => {
  const names = (...n) => new Set(n);
  const cases = [
    [PKG, names("package.json", "package-lock.json"), { ok: true }],
    [null, names(), { ok: false, reason: "no_package_json" }],
    ["{ nope", names("package.json"), { ok: false, reason: "invalid_package_json" }],
    [JSON.stringify({ scripts: {} }), names("package-lock.json"), { ok: false, reason: "no_test_script" }],
    [JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), names("package-lock.json"), { ok: false, reason: "placeholder_test_script" }],
    [PKG, names("package.json"), { ok: false, reason: "no_lockfile" }],
    [PKG, names("pnpm-lock.yaml"), { ok: false, reason: "unsupported_package_manager" }],
    [PKG, names("yarn.lock"), { ok: false, reason: "unsupported_package_manager" }],
    [PKG, names("package-lock.json", "yarn.lock"), { ok: false, reason: "unsupported_package_manager" }],
    [JSON.stringify({ scripts: { test: "x" }, packageManager: "pnpm@9.0.0" }), names("package-lock.json"), { ok: false, reason: "unsupported_package_manager" }],
    [JSON.stringify({ scripts: { test: "x" }, workspaces: ["packages/*"] }), names("package-lock.json"), { ok: false, reason: "monorepo_unsupported" }],
  ];

  for (const [json, rootNames, expected] of cases) {
    const { verifiable } = readPackageInfo(json, rootNames);
    assert.equal(verifiable.ok, expected.ok, JSON.stringify(expected));
    if (!expected.ok) assert.equal(verifiable.reason, expected.reason, JSON.stringify(expected));
  }
});

test("an unverifiable project is still analysable; the manifest says why", () => {
  const manifest = build([item("src/a.js")], JSON.stringify({ name: "x" }));

  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.verifiable.ok, false);
  assert.equal(manifest.verifiable.reason, "no_test_script");
});

test("context selection fits the token budget, prefers entry points, and is deterministic", () => {
  const entries = [
    item("src/index.js", { size: 4000 }), item("src/deep/very/nested/helper.js", { size: 3000 }), item("src/server.js", { size: 6000 }), item("lib/a.js", { size: 2000 }),
    item("README.md", { size: 100 }), item("test/a.test.js", { size: 900 }), item("test/b.test.js", { size: 300 }), item("test/c.test.js", { size: 600 }), item("package.json"),
  ];
  const manifest = build(entries);
  const a = selectContext(manifest, { budgetTokens: 3000 });
  const b = selectContext(build([...entries].reverse()), { budgetTokens: 3000 });

  assert.deepEqual(a, b);
  assert.ok(a.estimatedTokens <= 3000);
  assert.ok(a.files.some((f) => f.path === "src/index.js"), "the declared entry point is chosen first");
  assert.ok(a.files.every((f) => f.kind === "source"));
  assert.deepEqual(a.testSamples.map((f) => f.path), ["test/b.test.js"], "tests only get what the sources leave over");
  assert.deepEqual(selectContext(manifest, { budgetTokens: 4000 }).testSamples.map((f) => f.path), ["test/b.test.js", "test/c.test.js"], "smallest tests are shown as conventions");
  assert.equal(selectContext(manifest, { budgetTokens: 1 }).files.length, 0);
  assert.ok(selectContext(manifest, { budgetTokens: 1_000_000, maxFiles: 2 }).files.length <= 2);
  assert.equal(estimateTokens(350), 100);
});

// ------------------------------------------------------------ stage handlers

function fakeEvidence() {
  const objects = new Map();

  return { objects, put: async (key, bytes) => void objects.set(key, Buffer.from(bytes)), get: async (key) => objects.get(key) ?? null, remove: async () => {} };
}

function fakeTx(run) {
  const calls = { facts: [], artifacts: [] };

  return { calls, tx: { run, setRunFacts: async (facts) => void calls.facts.push(facts), insertArtifact: async (input) => (calls.artifacts.push(input), { id: calls.artifacts.length, runId: run.id, ...input }) } };
}

const RUN = { id: 5, owner: "instance", repoOwner: "acme", repoName: "widgets", repoUrl: "https://github.com/acme/widgets", requestedRef: null, commitSha: null, defaultBranch: null };
const ctx = (run, extra = {}) => ({ run, stage: "ingest", attempt: 1, params: {}, signal: new AbortController().signal, log: async () => {}, ...extra });
const deps = (fake, { config = loadRepoPilotConfig({}), token = TOKEN, evidence = fakeEvidence(), store } = {}) => ({ store, github: token ? clientFor(fake, token) : null, evidence, config });

test("ingest pins the default branch's exact commit", async () => {
  const fake = createFakeGithub(repoSpec());
  const out = await createIngestHandler(deps(fake))(ctx(RUN));
  const { calls, tx } = fakeTx(RUN);

  await out.persist(tx);
  assert.deepEqual(calls.facts, [{ commitSha: SHA, defaultBranch: "main" }]);
});

test("ingest resolves an explicit branch, tag-like ref or commit", async () => {
  const fake = createFakeGithub(repoSpec());

  for (const [ref, expected] of [["dev", SHA2], [SHA2, SHA2], ["main", SHA]]) {
    const { calls, tx } = fakeTx(RUN);
    await (await createIngestHandler(deps(fake))(ctx({ ...RUN, requestedRef: ref }))).persist(tx);
    assert.equal(calls.facts[0].commitSha, expected, ref);
  }

  await assert.rejects(() => createIngestHandler(deps(fake))(ctx({ ...RUN, requestedRef: "deleted-branch" })), failsWith("repository_not_accessible"));
});

test("a retry re-verifies the pinned commit and refuses if it vanished", async () => {
  const fake = createFakeGithub(repoSpec());
  const pinned = { ...RUN, commitSha: SHA, requestedRef: "dev" };
  const { calls, tx } = fakeTx(pinned);

  await (await createIngestHandler(deps(fake))(ctx(pinned))).persist(tx);
  assert.equal(calls.facts[0].commitSha, SHA, "the pinned SHA wins over a ref that has moved on");

  const gone = { ...RUN, commitSha: "c".repeat(40) };
  await assert.rejects(() => createIngestHandler(deps(fake))(ctx(gone)), failsWith("repository_not_accessible"));
});

test("private repositories are refused unless explicitly allowed", async () => {
  const fake = createFakeGithub(repoSpec({ private: true }));

  await assert.rejects(() => createIngestHandler(deps(fake))(ctx(RUN)), (e) => failsWith("private_repository_not_allowed")(e) && !e.retryable && /REPOPILOT_ALLOW_PRIVATE/.test(e.message));
  assert.ok(await createIngestHandler(deps(fake, { config: loadRepoPilotConfig({ REPOPILOT_ALLOW_PRIVATE: "true" }) }))(ctx(RUN)));
});

test("ingest without a configured GitHub token fails with the fix in the message", async () => {
  await assert.rejects(() => createIngestHandler(deps(createFakeGithub(repoSpec()), { token: null }))(ctx(RUN)), failsWith("github_not_configured"));
});

const RUN2 = { ...RUN, commitSha: SHA, defaultBranch: "main" };

test("manifest stores the manifest as evidence and reports verifiability", async () => {
  const fake = createFakeGithub(repoSpec());
  const evidence = fakeEvidence();
  const out = await createManifestHandler(deps(fake, { evidence }))(ctx(RUN2, { stage: "manifest" }));
  const { calls, tx } = fakeTx(RUN2);

  await out.persist(tx);

  assert.equal(calls.artifacts.length, 1);
  assert.equal(calls.artifacts[0].kind, "manifest");
  assert.equal(calls.artifacts[0].objectKey, evidenceKey({ runId: 5, kind: "manifest" }));

  const stored = JSON.parse(evidence.objects.get(calls.artifacts[0].objectKey).toString());
  assert.equal(stored.commitSha, SHA);
  assert.equal(stored.verifiable.ok, true);
  assert.equal(calls.artifacts[0].sha256, crypto.createHash("sha256").update(evidence.objects.get(calls.artifacts[0].objectKey)).digest("hex"));
});

test("a truncated tree, an empty source set, and a missing commit fail the stage instead of pretending", async () => {
  await assert.rejects(() => createManifestHandler(deps(createFakeGithub(repoSpec({ truncated: true }))))(ctx(RUN2)), failsWith("repository_too_large"));
  await assert.rejects(() => createManifestHandler(deps(createFakeGithub(repoSpec())))(ctx(RUN)), failsWith("revision_missing"));

  const docsOnly = createFakeGithub(repoSpec({ commits: { [SHA]: { "README.md": "# hi\n", "logo.png": Buffer.from([1, 2, 3]) } } }));
  await assert.rejects(() => createManifestHandler(deps(docsOnly))(ctx(RUN2)), (e) => failsWith("no_supported_files")(e) && !e.retryable);
});

test("manifest reads package.json only from the repository root", async () => {
  const fake = createFakeGithub(repoSpec({ commits: { [SHA]: { "src/a.js": "x\n", "sub/package.json": JSON.stringify({ scripts: { test: "x" } }) } } }));
  const evidence = fakeEvidence();
  const { calls, tx } = fakeTx(RUN2);

  await (await createManifestHandler(deps(fake, { evidence }))(ctx(RUN2))).persist(tx);

  const stored = JSON.parse(evidence.objects.get(calls.artifacts[0].objectKey).toString());
  assert.equal(stored.verifiable.reason, "no_package_json");
  assert.equal(fake.requests.filter((r) => r.url.includes("/git/blobs/")).length, 0);
});

test("loading the manifest back detects tampering and mismatches", async () => {
  const fake = createFakeGithub(repoSpec());
  const evidence = fakeEvidence();
  const { calls, tx } = fakeTx(RUN2);

  await (await createManifestHandler(deps(fake, { evidence }))(ctx(RUN2))).persist(tx);

  const row = { kind: "manifest", objectKey: calls.artifacts[0].objectKey, sha256: calls.artifacts[0].sha256 };
  const store = (rows) => ({ listArtifacts: async () => rows });

  assert.equal((await loadManifest({ store: store([row]), evidence }, RUN2)).commitSha, SHA);
  await assert.rejects(() => loadManifest({ store: store([]), evidence }, RUN2), failsWith("manifest_missing"));
  await assert.rejects(() => loadManifest({ store: store([{ ...row, objectKey: "repopilot/runs/5/other.txt" }]), evidence }, RUN2), failsWith("manifest_missing"));

  evidence.objects.set(row.objectKey, Buffer.from(JSON.stringify({ version: 1, commitSha: SHA, tampered: true })));
  await assert.rejects(() => loadManifest({ store: store([row]), evidence }, RUN2), failsWith("evidence_tampered"));

  const other = { ...RUN2, commitSha: SHA2 };
  evidence.objects.set(row.objectKey, Buffer.from(JSON.stringify({ version: 1, commitSha: SHA })));
  const fixed = { ...row, sha256: crypto.createHash("sha256").update(evidence.objects.get(row.objectKey)).digest("hex") };
  await assert.rejects(() => loadManifest({ store: store([fixed]), evidence }, other), failsWith("manifest_mismatch"));
});

test("evidence keys are built from integers and a fixed list only", () => {
  assert.equal(evidenceKey({ runId: 7, kind: "verification_log", patchId: 3, arm: "baseline", attempt: 2 }), "repopilot/runs/7/verification_log/p3/baseline/a2.txt");

  for (const bad of [{ runId: 0, kind: "manifest" }, { runId: 1.5, kind: "manifest" }, { runId: 1, kind: "../../etc/passwd" }, { runId: 1, kind: "manifest", patchId: -1 }, { runId: 1, kind: "manifest", arm: "../x" }, { runId: "1; rm", kind: "manifest" }]) {
    assert.throws(() => evidenceKey(bad), TypeError, JSON.stringify(bad));
  }
});

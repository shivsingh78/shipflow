// The real Express app + RepoPilot router over HTTP, against REAL PostgreSQL.
// Queue calls go to a recording fake (Redis behaviour is covered by repopilotQueue.test.js).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createApiApp } from "../../dist/src/app.js";
import { createRepoPilotRouter, createDisabledRepoPilotRouter } from "../../dist/src/repopilot/routes.js";
import { createRepoPilotStore } from "../../dist/src/repopilot/store.js";
import { createOrchestrator } from "../../dist/src/repopilot/orchestrator.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { generateCredentialKeyPair, openCredential } from "../../dist/src/repopilot/credentials.js";
import { patchDigest } from "../../dist/src/repopilot/patch.js";
import { REPO, SHA, addTestDiff, apiShell, fakeQueue, finding, modifyDiff, openDatabase, proposal, resetDatabase, skipPg } from "./helpers.js";

const TOKEN = "integration-test-token-0123456789abcdef";
const KEYS = generateCredentialKeyPair();
const AI_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const caps = async () => ({ workers: 1, github: true, credentialDecryption: true, sandbox: "off" });

let pool;
let store;
let queue;
let server;
let base;

function configWith(extra = {}) {
  return loadRepoPilotConfig({ REPOPILOT: "enabled", REPOPILOT_CREDENTIAL_PUBLIC_KEY: KEYS.publicKeyPem.replace(/\n/g, "\\n"), ...extra });
}

async function startServer({ router, config = configWith(), principal } = {}) {
  const repopilotRouter = router ?? createRepoPilotRouter({ store, enqueue: queue.enqueue, config, capabilities: caps, ...(principal ? { resolvePrincipal: principal } : {}) });
  const app = createApiApp({ ...apiShell(TOKEN), repopilotRouter });
  const s = http.createServer(app);

  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));

  return { server: s, base: `http://127.0.0.1:${s.address().port}` };
}

async function call(method, path, { body, headers = {}, auth = true, url = base } = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;

  try { json = JSON.parse(text); } catch { /* not JSON */ }

  return { status: res.status, json, text, headers: res.headers };
}

before(async () => {
  if (skipPg) return;
  pool = await openDatabase();
});

after(async () => {
  server?.close();
  await pool?.end();
});

beforeEach(async () => {
  if (skipPg) return;
  server?.close();
  await resetDatabase(pool);
  store = createRepoPilotStore(pool, { retryBaseMs: 10 });
  queue = fakeQueue();
  ({ server, base } = await startServer());
});

const authorizeRepo = () => call("POST", "/repopilot/repositories", { body: { repoUrl: REPO.url } });
const createRun = async (headers) => (await call("POST", "/repopilot/runs", { body: { repoUrl: REPO.url }, headers })).json.run;

async function reviewableRun() {
  const run = (await store.createRun({ owner: "instance", actor: "user:operator", repo: REPO })).run;
  const o = createOrchestrator({
    store, enqueue: queue.enqueue, workerId: "t", handlers: {
      ingest: async () => ({ persist: (tx) => tx.setRunFacts({ commitSha: SHA, defaultBranch: "main" }) }),
      manifest: async () => {},
      analyze: async () => ({ persist: (tx) => tx.insertFindings([finding()]) }),
    },
  });

  for (const stage of ["ingest", "manifest", "analyze"]) await o.processJob({ runId: run.id, stage, attempt: 1 });

  const [found] = await store.listFindings("instance", run.id);
  let patchId;
  const p = createOrchestrator({ store, enqueue: queue.enqueue, workerId: "t", handlers: { patch: async () => ({ persist: async (tx) => { patchId = (await tx.insertPatch(found.id, proposal())).patch.id; } }) } });

  await p.processJob({ runId: run.id, stage: "patch", attempt: 1, findingId: found.id });

  for (const arm of ["baseline", "patched"]) for (const attempt of [1, 2]) await store.recordVerification({ runId: run.id, patchId, arm, attempt, run: { kind: "exited", exitCode: 0, durationMs: 4 }, testCommand: "npm test", environmentProfile: {} });
  for (const attempt of [1, 2]) await store.recordVerification({ runId: run.id, patchId, arm: "control", attempt, run: { kind: "exited", exitCode: 1, durationMs: 4 }, testCommand: "npm test", environmentProfile: {} });

  await createOrchestrator({ store, enqueue: queue.enqueue, workerId: "t", handlers: { verify: async () => ({ persist: (tx) => tx.computeOutcome(patchId) }) } }).processJob({ runId: run.id, stage: "verify", attempt: 1 });

  return { run, patchId, found };
}

// -------------------------------------------------------------- auth / mode

test("every RepoPilot route needs the API token", { skip: skipPg }, async () => {
  for (const [method, path] of [["GET", "/repopilot/status"], ["GET", "/repopilot/runs"], ["POST", "/repopilot/runs"], ["GET", "/repopilot/runs/1"], ["PUT", "/repopilot/credentials/anthropic"], ["POST", "/repopilot/runs/1/pull-request"], ["POST", "/repopilot/repositories"]]) {
    for (const headers of [{}, { Authorization: "Bearer wrong-token-0123456789abcdef" }, { Authorization: "Basic abc" }]) {
      const res = await call(method, path, { auth: false, headers, body: method === "GET" ? undefined : {} });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  }
});

test("when disabled, only /status answers and says so; everything else is 404", { skip: skipPg }, async () => {
  const disabled = await startServer({ router: createDisabledRepoPilotRouter({ problems: ["example problem"] }) });

  try {
    const status = await call("GET", "/repopilot/status", { url: disabled.base });
    assert.equal(status.json.enabled, false);
    assert.deepEqual(status.json.problems, ["example problem"]);

    for (const [method, path] of [["GET", "/repopilot/runs"], ["POST", "/repopilot/runs"], ["PUT", "/repopilot/credentials/anthropic"]]) {
      const res = await call(method, path, { url: disabled.base, body: method === "GET" ? undefined : {} });
      assert.equal(res.status, 404, path);
      assert.equal(res.json.code, "repopilot_disabled");
    }
  } finally {
    disabled.server.close();
  }
});

test("status reports capabilities and contains no secrets", { skip: skipPg }, async () => {
  const res = await call("GET", "/repopilot/status");

  assert.equal(res.status, 200);
  assert.equal(res.json.enabled, true);
  assert.equal(res.json.sandbox.mode, "off");
  assert.match(res.json.sandbox.note, /inconclusive/);
  assert.ok(res.json.limitations.length >= 3);
  assert.doesNotMatch(res.text, /BEGIN|sk-ant|ghp_|integration-test-token/);
});

// ------------------------------------------------------------------- inputs

test("malformed identifiers are rejected before touching the database", { skip: skipPg }, async () => {
  for (const id of ["abc", "0", "-1", "1e3", "01", "1.5", "99999999999999999999", "%00", "1;drop"]) {
    for (const path of [`/repopilot/runs/${id}`, `/repopilot/runs/${id}/findings`, `/repopilot/runs/${id}/logs`, `/repopilot/runs/${id}/audit`]) {
      const res = await call("GET", path);
      assert.equal(res.status, 400, path);
      assert.equal(res.json.code, "invalid_id");
    }
  }

  assert.equal((await call("GET", "/repopilot/runs/1/patches/abc")).status, 400);
  assert.equal((await call("GET", "/repopilot/runs/1/artifacts/0")).status, 400);
  assert.equal((await call("POST", "/repopilot/runs/1/findings/x/patch", { body: {} })).status, 400);
  assert.equal((await call("GET", "/repopilot/runs/987654")).status, 404);
});

test("list and log queries validate their parameters", { skip: skipPg }, async () => {
  for (const q of ["limit=0", "limit=201", "limit=abc", "limit=-5", "before=abc", "before=0", "limit=1&limit=2"]) {
    assert.equal((await call("GET", `/repopilot/runs?${q}`)).status, 400, q);
  }

  const run = await createRunAfterAuth();

  for (const q of ["after=abc", "limit=0", "limit=1001"]) assert.equal((await call("GET", `/repopilot/runs/${run.id}/logs?${q}`)).status, 400, q);
  assert.equal((await call("GET", `/repopilot/runs/${run.id}/logs?after=1&limit=10`)).status, 200);
});

async function createRunAfterAuth() {
  await authorizeRepo();

  return createRun();
}

test("repositories: validated, listed, revoked", { skip: skipPg }, async () => {
  for (const body of [{}, { repoUrl: "https://gitlab.com/a/b" }, { repoUrl: "http://github.com/a/b" }, { repoUrl: REPO.url, extra: 1 }, { repoUrl: 5 }, "not-json{"]) {
    const res = await call("POST", "/repopilot/repositories", { body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }

  assert.equal((await authorizeRepo()).status, 201);
  assert.deepEqual((await call("GET", "/repopilot/repositories")).json.repositories.map((r) => `${r.owner}/${r.name}`), ["acme/widgets"]);
  assert.equal((await call("DELETE", "/repopilot/repositories/acme/widgets")).status, 200);
  assert.equal((await call("DELETE", "/repopilot/repositories/acme/widgets")).status, 404);
  assert.equal((await call("DELETE", "/repopilot/repositories/..%2F/x")).status, 400);
});

// --------------------------------------------------------------------- runs

test("a run needs an explicitly authorised repository", { skip: skipPg }, async () => {
  const res = await call("POST", "/repopilot/runs", { body: { repoUrl: REPO.url } });

  assert.equal(res.status, 403);
  assert.equal(res.json.code, "repository_not_authorized");
  assert.equal(queue.jobs.length, 0);
});

test("creating a run queues ingest; an Idempotency-Key replay does not queue twice", { skip: skipPg }, async () => {
  await authorizeRepo();

  const first = await call("POST", "/repopilot/runs", { body: { repoUrl: `${REPO.url}.git`, ref: "main" }, headers: { "Idempotency-Key": "client-key-0001" } });
  const replay = await call("POST", "/repopilot/runs", { body: { repoUrl: REPO.url, ref: "main" }, headers: { "Idempotency-Key": "client-key-0001" } });

  assert.equal(first.status, 202);
  assert.equal(first.json.created, true);
  assert.equal(first.json.run.repo.url, REPO.url);
  assert.equal(first.json.run.requestedRef, "main");
  assert.equal(replay.status, 200);
  assert.equal(replay.json.created, false);
  assert.equal(replay.json.run.id, first.json.run.id);
  assert.deepEqual(queue.jobs.map((j) => j.job), [{ runId: first.json.run.id, stage: "ingest", attempt: 1 }]);
  assert.ok(!("owner" in first.json.run) && !("idempotencyKey" in first.json.run), "internal fields are not exposed");
});

test("bad run requests are rejected with safe errors", { skip: skipPg }, async () => {
  await authorizeRepo();

  const bad = [
    [{ repoUrl: "https://evil.example/a/b" }, {}], [{}, {}], [{ repoUrl: REPO.url, ref: "../../etc" }, {}], [{ repoUrl: REPO.url, ref: "-rf" }, {}], [{ repoUrl: REPO.url, ref: "a b" }, {}],
    [{ repoUrl: REPO.url, ref: "x".repeat(201) }, {}], [{ repoUrl: REPO.url, ref: "a.lock" }, {}], [{ repoUrl: REPO.url, extra: true }, {}], [{ repoUrl: REPO.url, commitSha: SHA }, {}],
    [{ repoUrl: REPO.url }, { "Idempotency-Key": "short" }], [{ repoUrl: REPO.url }, { "Idempotency-Key": "has spaces in it!" }],
  ];

  for (const [body, headers] of bad) {
    const res = await call("POST", "/repopilot/runs", { body, headers });
    assert.equal(res.status, 400, JSON.stringify([body, headers]));
    assert.equal(res.json.success, false);
  }

  assert.equal((await call("POST", "/repopilot/runs", { body: "{not json" })).status, 400);
  assert.equal((await call("POST", "/repopilot/runs", { body: { repoUrl: REPO.url, pad: "x".repeat(70_000) } })).status, 413);
  assert.equal(queue.jobs.length, 0);
});

test("the active-run quota answers 429", { skip: skipPg }, async () => {
  await authorizeRepo();
  for (let i = 0; i < 3; i += 1) assert.equal((await call("POST", "/repopilot/runs", { body: { repoUrl: REPO.url } })).status, 202);

  const res = await call("POST", "/repopilot/runs", { body: { repoUrl: REPO.url } });
  assert.equal(res.status, 429);
  assert.equal(res.json.code, "quota");
});

test("if the queue is down the run fails explicitly instead of hanging", { skip: skipPg }, async () => {
  const broken = await startServer({ router: createRepoPilotRouter({ store, enqueue: async () => { throw new Error("redis down ghp_abcdefghijklmnopqrstuvwxyz123456"); }, config: configWith(), capabilities: caps }) });

  try {
    await authorizeRepo();
    const res = await call("POST", "/repopilot/runs", { body: { repoUrl: REPO.url }, url: broken.base });

    assert.equal(res.status, 503);
    assert.equal(res.json.code, "queue_unavailable");
    assert.doesNotMatch(res.text, /redis down|ghp_/);
    assert.equal((await store.listRuns("instance"))[0].state, "failed");
  } finally {
    broken.server.close();
  }
});

test("run detail and list expose progress without internal fields", { skip: skipPg }, async () => {
  const { run } = await reviewableRun();
  const detail = await call("GET", `/repopilot/runs/${run.id}`);

  assert.equal(detail.status, 200);
  assert.equal(detail.json.run.state, "ready_for_review");
  assert.deepEqual(detail.json.stages.map((s) => `${s.stage}:${s.state}`), ["ingest:succeeded", "manifest:succeeded", "analyze:succeeded", "patch:succeeded", "verify:succeeded"]);
  assert.deepEqual(detail.json.counts, { findings: 1, patches: 1 });
  assert.equal(detail.json.outcomes[0].outcome, "improved");
  assert.ok(detail.json.limitations.some((l) => /not proven correct/.test(l)));
  assert.equal((await call("GET", "/repopilot/runs")).json.runs[0].id, run.id);
});

test("findings are labelled as the model's suggestions", { skip: skipPg }, async () => {
  const { run } = await reviewableRun();
  const res = await call("GET", `/repopilot/runs/${run.id}/findings`);

  assert.equal(res.json.findings[0].modelConfidence, 0.7);
  assert.ok(!("confidence" in res.json.findings[0]));
  assert.match(res.json.notice, /suggestions/);
});

test("patch review shows both diffs, the digest and the policy verdict", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();
  const res = await call("GET", `/repopilot/runs/${run.id}/patches/${patchId}`);

  assert.equal(res.json.patch.diff, modifyDiff());
  assert.equal(res.json.patch.testDiff, addTestDiff());
  assert.equal(res.json.patch.diffSha256, patchDigest(modifyDiff(), addTestDiff()));
  assert.equal(res.json.patch.policy.passed, true);
  assert.equal(res.json.patch.baseCommit, SHA);
  assert.equal((await call("GET", `/repopilot/runs/${run.id}/patches/99999`)).status, 404);
});

test("verification views include evidence and the standing caveat", { skip: skipPg }, async () => {
  const { run } = await reviewableRun();
  const res = await call("GET", `/repopilot/runs/${run.id}/verifications`);

  assert.equal(res.json.verifications.length, 6);
  assert.equal(res.json.verifications[0].testCommand, "npm test");
  assert.equal(res.json.verifications[0].commitSha, SHA);
  assert.match(res.json.notice, /do not prove|not prove/i);
});

// ----------------------------------------------------------------- ownership

test("another principal can neither see nor change a run, through any endpoint", { skip: skipPg }, async () => {
  const { run, patchId, found } = await reviewableRun();
  const other = await startServer({ principal: () => ({ owner: "someone-else", actor: "user:mallory" }) });

  try {
    const probes = [
      ["GET", `/repopilot/runs/${run.id}`], ["GET", `/repopilot/runs/${run.id}/findings`], ["GET", `/repopilot/runs/${run.id}/patches`], ["GET", `/repopilot/runs/${run.id}/patches/${patchId}`],
      ["GET", `/repopilot/runs/${run.id}/verifications`], ["GET", `/repopilot/runs/${run.id}/logs`], ["GET", `/repopilot/runs/${run.id}/audit`], ["GET", `/repopilot/runs/${run.id}/artifacts`],
      ["GET", `/repopilot/runs/${run.id}/pull-request`], ["POST", `/repopilot/runs/${run.id}/cancel`], ["POST", `/repopilot/runs/${run.id}/findings/${found.id}/patch`],
    ];

    for (const [method, path] of probes) {
      const res = await call(method, path, { url: other.base, body: method === "POST" ? {} : undefined });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.doesNotMatch(res.text, /acme|widgets|Unchecked/);
    }

    const pr = await call("POST", `/repopilot/runs/${run.id}/pull-request`, { url: other.base, body: { patchId, diffSha256: patchDigest(modifyDiff(), addTestDiff()), baseCommitSha: SHA, outcome: "improved", confirm: true } });
    assert.equal(pr.status, 404);
    assert.deepEqual((await call("GET", "/repopilot/runs", { url: other.base })).json.runs, []);
    assert.equal((await store.getRun("instance", run.id)).state, "ready_for_review");
  } finally {
    other.server.close();
  }
});

// -------------------------------------------------------------- credentials

test("storing a provider key seals it; the key is never echoed, listed or stored in the clear", { skip: skipPg }, async () => {
  const put = await call("PUT", "/repopilot/credentials/anthropic", { body: { apiKey: AI_KEY } });

  assert.equal(put.status, 200);
  assert.doesNotMatch(put.text, /sk-ant/);

  const list = await call("GET", "/repopilot/credentials");
  assert.deepEqual(Object.keys(list.json.credentials[0]).sort(), ["fingerprint", "provider", "updatedAt"]);
  assert.doesNotMatch(list.text, /sk-ant/);

  const sealed = await store.readCredentialCiphertext("instance", "anthropic");
  assert.ok(!sealed.includes(AI_KEY));
  assert.equal(openCredential(KEYS.privateKeyPem, sealed), AI_KEY, "only the worker's private key recovers it");

  const dump = JSON.stringify((await pool.query("SELECT * FROM rp_credentials")).rows) + JSON.stringify((await pool.query("SELECT * FROM rp_audit_events")).rows);
  assert.doesNotMatch(dump, /sk-ant-api03/);
  assert.equal((await call("DELETE", "/repopilot/credentials/anthropic")).status, 200);
  assert.equal((await call("GET", "/repopilot/credentials")).json.credentials.length, 0);
});

test("bad credential requests fail safely and never echo the submitted value", { skip: skipPg }, async () => {
  const bogus = "sk-ant-this-is-too-short";

  for (const [path, body] of [["/repopilot/credentials/anthropic", { apiKey: bogus }], ["/repopilot/credentials/anthropic", { apiKey: AI_KEY, extra: 1 }], ["/repopilot/credentials/anthropic", {}], ["/repopilot/credentials/openai", { apiKey: AI_KEY }], ["/repopilot/credentials/ANTHROPIC", { apiKey: AI_KEY }]]) {
    const res = await call("PUT", path, { body });
    assert.equal(res.status, 400, path);
    assert.doesNotMatch(res.text, new RegExp(`${bogus}|${AI_KEY}`));
  }
});

test("without a configured public key credentials cannot be stored, with an actionable error", { skip: skipPg }, async () => {
  const bare = await startServer({ config: loadRepoPilotConfig({ REPOPILOT: "enabled" }) });

  try {
    const res = await call("PUT", "/repopilot/credentials/anthropic", { url: bare.base, body: { apiKey: AI_KEY } });

    assert.equal(res.status, 503);
    assert.equal(res.json.code, "credential_encryption_not_configured");
    assert.equal((await store.listCredentials("instance")).length, 0);
  } finally {
    bare.server.close();
  }
});

test("credential changes are rate limited harder than reads", { skip: skipPg }, async () => {
  const statuses = [];

  for (let i = 0; i < 7; i += 1) statuses.push((await call("PUT", "/repopilot/credentials/anthropic", { body: { apiKey: AI_KEY } })).status);

  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);

  const limited = await call("PUT", "/repopilot/credentials/anthropic", { body: { apiKey: AI_KEY } });
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(limited.json.code, "rate_limited");
});

test("write endpoints are rate limited per configuration", { skip: skipPg }, async () => {
  const tight = await startServer({ config: configWith({ REPOPILOT_RATE_WRITE_PER_MIN: "2" }) });

  try {
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await call("POST", "/repopilot/repositories", { url: tight.base, body: { repoUrl: REPO.url } })).status);
    assert.deepEqual(codes, [201, 201, 429, 429]);
  } finally {
    tight.server.close();
  }
});

// ------------------------------------------------------------------ patching

test("requesting a patch needs awaiting_patch, the user's own AI key, and remaining attempts", { skip: skipPg }, async () => {
  const run = (await store.createRun({ owner: "instance", actor: "user:operator", repo: REPO })).run;
  const path = (findingId) => `/repopilot/runs/${run.id}/findings/${findingId}/patch`;

  assert.equal((await call("POST", path(1), { body: {} })).json.code, "invalid_state");

  const o = createOrchestrator({ store, enqueue: queue.enqueue, workerId: "t", handlers: { ingest: async () => ({ persist: (tx) => tx.setRunFacts({ commitSha: SHA, defaultBranch: "main" }) }), manifest: async () => {}, analyze: async () => ({ persist: (tx) => tx.insertFindings([finding()]) }) } });
  for (const stage of ["ingest", "manifest", "analyze"]) await o.processJob({ runId: run.id, stage, attempt: 1 });
  const [found] = await store.listFindings("instance", run.id);
  queue.jobs.length = 0;

  assert.equal((await call("POST", path(found.id + 50), { body: {} })).status, 404);
  const noKey = await call("POST", path(found.id), { body: {} });
  assert.equal(noKey.status, 409);
  assert.equal(noKey.json.code, "ai_credentials_missing");
  assert.equal(queue.jobs.length, 0, "no job is queued without the customer's own key");

  await call("PUT", "/repopilot/credentials/anthropic", { body: { apiKey: AI_KEY } });
  const ok = await call("POST", path(found.id), { body: {} });

  assert.equal(ok.status, 202);
  assert.deepEqual(queue.jobs.map((j) => j.job), [{ runId: run.id, stage: "patch", attempt: 1, findingId: found.id }]);
  assert.ok((await store.listAudit("instance", run.id)).some((e) => e.event === "patch_requested" && e.actor === "user:operator"));
});

// ------------------------------------------------------------ pull requests

const prBody = (patchId, overrides = {}) => ({ patchId, diffSha256: patchDigest(modifyDiff(), addTestDiff()), baseCommitSha: SHA, outcome: "improved", confirm: true, ...overrides });

test("authorising a PR binds the exact reviewed patch and queues the PR stage", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();
  queue.jobs.length = 0;

  const res = await call("POST", `/repopilot/runs/${run.id}/pull-request`, { body: prBody(patchId) });

  assert.equal(res.status, 202);
  assert.equal(res.json.run.state, "pr_authorized");
  assert.equal(res.json.pullRequest.authorizedBy, "user:operator");
  assert.equal(res.json.pullRequest.authorizedDiffSha256, patchDigest(modifyDiff(), addTestDiff()));
  assert.deepEqual(queue.jobs.map((j) => j.job), [{ runId: run.id, stage: "pr", attempt: 1 }]);
  assert.equal((await call("GET", `/repopilot/runs/${run.id}/pull-request`)).json.pullRequest.state, "authorized");

  // A second authorisation is a conflict and queues nothing more.
  assert.equal((await call("POST", `/repopilot/runs/${run.id}/pull-request`, { body: prBody(patchId) })).status, 409);
  assert.equal(queue.jobs.length, 1);
});

test("PR authorisation rejects stale, forged, or loosely-shaped requests", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();
  const path = `/repopilot/runs/${run.id}/pull-request`;

  for (const [body, status, code] of [
    [prBody(patchId, { diffSha256: "0".repeat(64) }), 409, "authorization_mismatch"],
    [prBody(patchId, { baseCommitSha: "b".repeat(40) }), 409, "authorization_mismatch"],
    [prBody(patchId, { outcome: "unchanged" }), 409, "authorization_mismatch"],
    [prBody(patchId, { confirm: false }), 400, "invalid_request"],
    [prBody(patchId, { confirm: undefined }), 400, "invalid_request"],
    [prBody(patchId, { merge: true }), 400, "invalid_request"],
    [prBody(patchId, { authorized: true, approvedBy: "model" }), 400, "invalid_request"],
    [{}, 400, "invalid_request"],
    [prBody(patchId + 99), 404, "not_found"],
  ]) {
    const res = await call("POST", path, { body });
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(res.json.code, code, JSON.stringify(body));
  }

  assert.equal((await store.getRun("instance", run.id)).state, "ready_for_review");
  assert.equal(queue.jobs.filter((j) => j.job.stage === "pr").length, 0);
});

// ----------------------------------------------------------------- artifacts

test("artifact downloads are owner-scoped, bounded and served as attachments", { skip: skipPg }, async () => {
  const { run, patchId } = await reviewableRun();
  const stored = new Map([["repopilot/1/report.json", Buffer.from('{"ok":true}')]]);
  const reads = [];
  const reader = { read: async (key) => { reads.push(key); const body = stored.get(key); return body ? { body, contentType: "application/json" } : null; } };
  const withReader = await startServer({ router: createRepoPilotRouter({ store, enqueue: queue.enqueue, config: configWith(), capabilities: caps, artifacts: reader }) });

  try {
    await pool.query("INSERT INTO rp_artifacts (run_id, patch_id, kind, object_key, bytes, sha256) VALUES ($1, $2, 'report', 'repopilot/1/report.json', 11, repeat('a', 64))", [run.id, patchId]);
    await pool.query("INSERT INTO rp_artifacts (run_id, kind, object_key, bytes, sha256) VALUES ($1, 'big', 'repopilot/1/big.bin', 99999999, repeat('b', 64))", [run.id]);
    await pool.query("INSERT INTO rp_artifacts (run_id, kind, object_key, bytes, sha256) VALUES ($1, 'gone', 'repopilot/1/gone.bin', 5, repeat('c', 64))", [run.id]);

    const list = await call("GET", `/repopilot/runs/${run.id}/artifacts`, { url: withReader.base });
    assert.deepEqual(list.json.artifacts.map((a) => a.kind), ["report", "big", "gone"]);
    assert.ok(list.json.artifacts.every((a) => !("objectKey" in a) && !("object_key" in a)), "object keys are not exposed");

    const [report, big, gone] = list.json.artifacts;
    const ok = await call("GET", `/repopilot/runs/${run.id}/artifacts/${report.id}`, { url: withReader.base });

    assert.equal(ok.status, 200);
    assert.equal(ok.text, '{"ok":true}');
    assert.equal(ok.headers.get("content-type"), "application/octet-stream");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.match(ok.headers.get("content-disposition"), /^attachment; filename="repopilot-report-\d+\.txt"$/);
    assert.equal(ok.headers.get("cache-control"), "private, no-store");
    assert.equal((await call("GET", `/repopilot/runs/${run.id}/artifacts/${big.id}`, { url: withReader.base })).status, 413);
    assert.equal((await call("GET", `/repopilot/runs/${run.id}/artifacts/${gone.id}`, { url: withReader.base })).status, 404);
    assert.deepEqual(reads, ["repopilot/1/report.json", "repopilot/1/gone.bin"], "keys come from the database, never the request");
    assert.equal((await call("GET", `/repopilot/runs/${run.id}/artifacts/${report.id + 500}`, { url: withReader.base })).status, 404);
  } finally {
    withReader.server.close();
  }
});

// ------------------------------------------------------------------- errors

test("internal failures return a generic 500 without SQL, paths or secrets", { skip: skipPg }, async () => {
  const sick = createRepoPilotStore({
    query: async () => { throw new Error('relation "rp_runs" does not exist at /srv/shipflow/dist/src/db.js password=hunter2 ghp_abcdefghijklmnopqrstuvwxyz123456'); },
    connect: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:5432"); },
  });
  const broken = await startServer({ router: createRepoPilotRouter({ store: sick, enqueue: queue.enqueue, config: configWith(), capabilities: caps }) });
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));

  try {
    for (const [method, path, body] of [["GET", "/repopilot/runs"], ["GET", "/repopilot/runs/1"], ["POST", "/repopilot/repositories", { repoUrl: REPO.url }], ["POST", "/repopilot/runs/1/cancel", {}]]) {
      const res = await call(method, path, { url: broken.base, body });
      assert.equal(res.status, 500, path);
      assert.deepEqual(res.json, { success: false, code: "internal_error", message: "Internal server error" });
    }

    assert.ok(logged.length > 0);
    assert.doesNotMatch(logged.join("\n"), /ghp_|hunter2/, "server logs are redacted too");
  } finally {
    console.error = original;
    broken.server.close();
  }
});

test("cancelling through the API ends an idle run and records the actor", { skip: skipPg }, async () => {
  await authorizeRepo();
  const run = await createRun();
  const res = await call("POST", `/repopilot/runs/${run.id}/cancel`, { body: {} });

  assert.equal(res.status, 202);
  assert.equal(res.json.cancelledNow, true);
  assert.equal(res.json.run.state, "cancelled");
  assert.equal((await call("POST", `/repopilot/runs/${run.id}/cancel`, { body: {} })).status, 409);

  const audit = await call("GET", `/repopilot/runs/${run.id}/audit`);
  assert.deepEqual(audit.json.events.map((e) => e.event), ["run_created", "run_cancelled"]);
  assert.equal(audit.json.chain.ok, true);
});

test("metrics expose counts and codes only, never content", { skip: skipPg }, async () => {
  const { run } = await reviewableRun();
  await pool.query("INSERT INTO rp_stages (run_id, stage, attempt, state, idempotency_key, error_code, finished_at) VALUES ($1, 'ingest', 9, 'failed', 'k-metrics', 'github_rate_limited', now())", [run.id]);

  const res = await call("GET", "/repopilot/metrics");

  assert.equal(res.status, 200);
  assert.equal(res.json.runsByState.ready_for_review, 1);
  assert.equal(res.json.activeRuns, 1);
  assert.ok(res.json.oldestActiveRunAgeSec >= 0);
  assert.deepEqual(res.json.stageFailures24h, [{ stage: "ingest", code: "github_rate_limited", count: 1 }]);
  assert.equal(res.json.queue, null, "no queue counter was configured in this test server");
  assert.doesNotMatch(res.text, /acme|widgets|Unchecked|src\/config/);
});

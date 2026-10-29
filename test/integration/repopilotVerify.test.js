// Verify stage through the real orchestrator + PostgreSQL with a SCRIPTED
// sandbox double. This tests orchestration and classification only: no
// repository code runs anywhere in this suite, and the double is NOT an
// isolation boundary.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createRepoPilotStore } from "../../dist/src/repopilot/store.js";
import { createVerifyHandler } from "../../dist/src/repopilot/stagesVerify.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { createDisabledSandbox, createSandboxRunner } from "../../dist/src/repopilot/verifySandbox.js";
import { patchDigest } from "../../dist/src/repopilot/patch.js";
import { openDatabase, resetDatabase, skipPg } from "./helpers.js";
import { GH_TOKEN, GOOD_DIFF, GOOD_TEST, OWNER, PKG, exited, fakeSandbox, makeEvidence, verifyingRun } from "./pipeline.js";

let pool;
let store;
let ev;

before(async () => {
  if (skipPg) return;
  pool = await openDatabase();
  ev = makeEvidence();
});

after(async () => {
  await pool?.end();
  ev?.cleanup();
});

beforeEach(async () => {
  if (skipPg) return;
  await resetDatabase(pool);
  store = createRepoPilotStore(pool, { retryBaseMs: 5 });
});

async function run(sandboxRunner, { files, config } = {}) {
  const cfg = config ?? loadRepoPilotConfig({});
  const fx = await verifyingRun({ store, evidence: ev.evidence, files, config: cfg, extraHandlers: () => ({ verify: createVerifyHandler({ store, evidence: ev.evidence, config: cfg, sandbox: sandboxRunner }) }) });
  const result = await fx.orchestrator.processJob({ runId: fx.run.id, stage: "verify", attempt: 1 });

  return { ...fx, result, outcome: (await store.listOutcomes(OWNER, fx.run.id))[0], verifications: await store.listVerifications(OWNER, fx.run.id) };
}

const byArm = (calls, arm) => calls.filter((c) => c.arm === arm).length;

test("improved: baseline passes, the new test fails on the original code, the patched run passes", { skip: skipPg }, async () => {
  const { runner, calls } = fakeSandbox({ script: (i) => exited(i.arm === "control" ? 1 : 0, `${i.arm} ran`) });
  const { result, outcome, verifications, run: r } = await run(runner);

  assert.deepEqual(result, { status: "completed", runState: "ready_for_review" });
  assert.equal(outcome.outcome, "improved");
  assert.equal(verifications.length, 6);
  assert.deepEqual([byArm(calls, "baseline"), byArm(calls, "control"), byArm(calls, "patched")], [2, 2, 2]);
  assert.equal((await store.getRun(OWNER, r.id)).state, "ready_for_review");
});

test("every attempt records commit, patch digest, fixed command and environment profile", { skip: skipPg }, async () => {
  const { runner } = fakeSandbox({ script: () => exited(0) });
  const { verifications, patch } = await run(runner);

  for (const v of verifications) {
    assert.equal(v.commitSha, patch.baseCommit);
    assert.equal(v.diffSha256, patchDigest(GOOD_DIFF, GOOD_TEST));
    assert.equal(v.testCommand, "npm test");
    assert.equal(v.environmentProfile.mode, "off");
    assert.equal(v.environmentProfile.network, "none during tests");
    assert.equal(v.environmentProfile.installScripts, "disabled");
    assert.equal(v.environmentProfile.runner, "fake");
    assert.ok(v.logKey);
  }
});

test("the runner is only ever asked for the fixed command, with arms that match their semantics", { skip: skipPg }, async () => {
  const { runner, calls } = fakeSandbox({ script: () => exited(0) });
  const { patch } = await run(runner);

  assert.ok(calls.every((c) => c.testCommand === "npm test"));
  assert.deepEqual([...new Set(calls.map((c) => `${c.arm}:${c.apply}:${c.patch === null}`))].sort(), ["baseline:none:true", "control:tests_only:false", "patched:full:false"]);
  assert.ok(calls.every((c) => c.commitSha === patch.baseCommit && c.repo.owner === "acme"));
  assert.ok(calls.every((c) => c.timeoutMs === 300_000 && c.limits.memoryMb === 1024));
});

test("a regression is classified from the observed runs, not assumed", { skip: skipPg }, async () => {
  const { runner } = fakeSandbox({ script: (i) => exited(i.arm === "patched" || i.arm === "control" ? 1 : 0) });

  assert.equal((await run(runner)).outcome.outcome, "regressed");
});

test("flaky, timed-out and failing-baseline results are inconclusive, with reasons", { skip: skipPg }, async () => {
  let n = 0;
  const flaky = fakeSandbox({ script: (i) => (i.arm === "patched" ? exited(++n % 2) : exited(i.arm === "control" ? 1 : 0)) });
  const a = await run(flaky.runner);
  assert.equal(a.outcome.outcome, "inconclusive");
  assert.deepEqual(a.outcome.reasons, ["flaky_patched"]);

  await resetDatabase(pool);
  const slow = fakeSandbox({ script: (i) => (i.arm === "baseline" ? { run: { kind: "timeout", durationMs: 300000 }, log: "killed" } : exited(0)) });
  const b = await run(slow.runner);
  assert.deepEqual(b.outcome.reasons, ["timeout"]);

  await resetDatabase(pool);
  const broken = fakeSandbox({ script: () => exited(1) });
  const c = await run(broken.runner);
  assert.deepEqual(c.outcome.reasons, ["baseline_failing"]);
});

test("a runner that throws or returns garbage records infrastructure errors, never a pass or fail", { skip: skipPg }, async () => {
  const crash = fakeSandbox({ script: () => { throw new Error(`docker daemon unreachable; token=${GH_TOKEN}`); } });
  const a = await run(crash.runner);

  assert.equal(a.outcome.outcome, "inconclusive");
  assert.deepEqual(a.outcome.reasons, ["infra_error"]);
  assert.ok(a.verifications.every((v) => v.kind === "infra_error"));
  assert.ok(a.verifications.every((v) => !String(v.detail).includes(GH_TOKEN)), "error detail is redacted");

  await resetDatabase(pool);
  const garbage = fakeSandbox({ script: () => ({ run: { kind: "exited", exitCode: 0, durationMs: 1, verified: true }, log: "" }) });
  const b = await run(garbage.runner);

  assert.ok(b.verifications.every((v) => v.kind === "infra_error"), "a result with an extra 'verified' field is rejected as an infra error");
  assert.deepEqual(b.outcome.reasons, ["infra_error"]);
});

test("logs are stored redacted, bounded, indexed, and owner-readable", { skip: skipPg }, async () => {
  const { runner } = fakeSandbox({ script: (i) => exited(0, `PASS ${i.arm}\nAuthorization: Bearer abcdefghijklmnop1234\nGITHUB_TOKEN=${GH_TOKEN}\n`) });
  const { run: r, verifications } = await run(runner);
  const logs = (await store.listArtifacts(OWNER, r.id)).filter((a) => a.kind === "verification_log");

  assert.equal(logs.length, 6);

  const text = (await ev.evidence.get(verifications[0].logKey, 1_000_000)).toString();
  assert.match(text, /PASS/);
  assert.ok(!text.includes("abcdefghijklmnop1234") && !text.includes(GH_TOKEN));
});

test("with the sandbox off nothing runs and the outcome says verification was unavailable", { skip: skipPg }, async () => {
  const off = createSandboxRunner("off");
  const { result, outcome, verifications, run: r } = await run(off);

  assert.deepEqual(result, { status: "completed", runState: "ready_for_review" });
  assert.equal(outcome.outcome, "inconclusive");
  assert.deepEqual(outcome.reasons, ["verification_unavailable"]);
  assert.equal(verifications.length, 0);
  assert.ok((await store.listLogs(OWNER, r.id)).some((l) => /Verification unavailable/.test(l.message)));
});

test("a 'remote' sandbox without an installed runner is reported as unavailable", { skip: skipPg }, async () => {
  const { outcome, run: r } = await run(createSandboxRunner("remote"));

  assert.deepEqual(outcome.reasons, ["verification_unavailable"]);
  assert.ok((await store.listLogs(OWNER, r.id)).some((l) => /no remote runner implementation/.test(l.message)));
});

test("projects that cannot be verified are labelled as such even when a sandbox is ready", { skip: skipPg }, async () => {
  for (const [files, label] of [
    [{ "package.json": PKG, "yarn.lock": "", "src/index.js": "const a = JSON.parse(x);\nexport default a;\nfunction f() {}\n" }, "yarn"],
    [{ "package.json": JSON.stringify({ name: "x" }), "package-lock.json": "{}", "src/index.js": "const a = JSON.parse(x);\nexport default a;\nfunction f() {}\n" }, "no test script"],
  ]) {
    await resetDatabase(pool);
    const { runner, calls } = fakeSandbox({ script: () => exited(0) });
    const out = await run(runner, { files });

    assert.deepEqual(out.outcome.reasons, ["unsupported_project"], label);
    assert.equal(calls.length, 0, label);
  }
});

test("a runner without a control arm gets only baseline and patched, and the outcome says so", { skip: skipPg }, async () => {
  const { runner, calls } = fakeSandbox({ supportsControlArm: false, script: () => exited(0) });
  const { outcome } = await run(runner);

  assert.deepEqual([byArm(calls, "baseline"), byArm(calls, "control"), byArm(calls, "patched")], [2, 0, 2]);
  assert.equal(outcome.outcome, "unchanged", "without a control, passing both can never be called an improvement");
});

test("a retried verify stage resumes: attempts already recorded are not run again", { skip: skipPg }, async () => {
  const cfg = loadRepoPilotConfig({});
  const { runner, calls } = fakeSandbox({ script: (i) => exited(i.arm === "control" ? 1 : 0) });
  const fx = await verifyingRun({ store, evidence: ev.evidence, config: cfg, extraHandlers: () => ({ verify: createVerifyHandler({ store, evidence: ev.evidence, config: cfg, sandbox: runner }) }) });

  // A previous (crashed) attempt already recorded both baseline runs.
  for (const attempt of [1, 2]) {
    await store.recordVerification({ runId: fx.run.id, patchId: fx.patch.id, arm: "baseline", attempt, run: { kind: "exited", exitCode: 0, durationMs: 3 }, testCommand: "npm test", environmentProfile: { earlier: true } });
  }

  await fx.orchestrator.processJob({ runId: fx.run.id, stage: "verify", attempt: 1 });

  assert.equal(byArm(calls, "baseline"), 0, "recorded baseline attempts were not re-run");
  assert.deepEqual([byArm(calls, "control"), byArm(calls, "patched")], [2, 2]);

  const rows = await store.listVerifications(OWNER, fx.run.id);
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.arm === "baseline").every((r) => r.environmentProfile.earlier === true), true, "the original records are untouched");
  assert.equal((await store.listOutcomes(OWNER, fx.run.id))[0].outcome, "improved");

  // Running the whole stage again is a no-op for recorded attempts too.
  const before = calls.length;
  await store.withTx(async (tx) => { await tx.query("UPDATE rp_stages SET state = 'failed', finished_at = now() WHERE stage = 'verify'"); await tx.query("UPDATE rp_runs SET state = 'verifying', finished_at = NULL WHERE id = $1", [fx.run.id]); });
  await fx.orchestrator.processJob({ runId: fx.run.id, stage: "verify", attempt: 2 });
  assert.equal(calls.length, before, "nothing was re-executed");
});

test("cancelling during verification aborts the runner and cancels the run", { skip: skipPg }, async () => {
  const { runner } = fakeSandbox({ script: (i, _n, signal) => new Promise((resolve, reject) => { const t = setTimeout(() => resolve(exited(0)), 5000); signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }); }) });
  const cfg = loadRepoPilotConfig({});
  const fx = await verifyingRun({ store, evidence: ev.evidence, config: cfg, extraHandlers: () => ({ verify: createVerifyHandler({ store, evidence: ev.evidence, config: cfg, sandbox: runner }) }) });
  const job = fx.orchestrator.processJob({ runId: fx.run.id, stage: "verify", attempt: 1 });

  await new Promise((resolve) => setTimeout(resolve, 80));
  await store.requestCancel(OWNER, fx.run.id, "user:operator");

  assert.equal((await job).status, "cancelled");
  assert.equal((await store.getRun(OWNER, fx.run.id)).state, "cancelled");
  assert.equal((await store.listOutcomes(OWNER, fx.run.id)).length, 0, "no outcome from an aborted verification");
});

test("the default disabled runner is what ships", () => {
  assert.equal(createDisabledSandbox().status, "off");
});

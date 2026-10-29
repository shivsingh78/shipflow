import { test } from "node:test";
import assert from "node:assert/strict";

import { createDisabledSandbox, createSandboxRunner, parseSandboxResult } from "../../dist/src/repopilot/verifySandbox.js";

test("the shipped sandbox runner executes nothing, ever", async () => {
  const runner = createSandboxRunner("off");

  assert.equal(runner.status, "off");
  assert.equal(runner.supportsControlArm, false);
  await assert.rejects(() => runner.run({}, new AbortController().signal), /no repository code is ever executed/);
});

test("asking for a remote sandbox without an implementation reports 'unavailable', not 'ready'", async () => {
  const runner = createSandboxRunner("remote");

  assert.equal(runner.status, "unavailable");
  assert.match(runner.reason, /no remote runner implementation is installed/);
  assert.match(runner.reason, /Provision and validate an isolated runner/);
  await assert.rejects(() => runner.run({}, new AbortController().signal));
});

test("a custom disabled reason is preserved", () => {
  assert.equal(createDisabledSandbox("because").reason, "because");
});

test("runner output must be a strictly valid SandboxRun", () => {
  assert.deepEqual(parseSandboxResult({ run: { kind: "exited", exitCode: 0, durationMs: 5 }, log: "ok" }, 1000), { run: { kind: "exited", exitCode: 0, durationMs: 5 }, log: "ok" });
  assert.deepEqual(parseSandboxResult({ run: { kind: "no_test_script" } }, 1000), { run: { kind: "no_test_script" }, log: "" });

  for (const bad of [null, {}, { run: null }, { run: { kind: "exited", exitCode: 0 } }, { run: { kind: "exited", exitCode: 0, durationMs: 1, verified: true } }, { run: { kind: "passed" } }, { run: "pass" }, { run: { kind: "exited", exitCode: 999, durationMs: 1 } }]) {
    assert.throws(() => parseSandboxResult(bad, 1000), undefined, JSON.stringify(bad));
  }
});

test("oversized logs are truncated with a marker", () => {
  const out = parseSandboxResult({ run: { kind: "timeout", durationMs: 9 }, log: "x".repeat(5000) }, 100);

  assert.ok(out.log.startsWith("x".repeat(100)));
  assert.match(out.log, /\[log truncated\]$/);
  assert.ok(out.log.length < 130);
});

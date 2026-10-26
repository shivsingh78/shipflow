import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEvidence, diagnose, advise } from "../../dist/src/evidence.js";

const release = (overrides = {}) => ({
  release_id: "AbCd1234",
  project: "api",
  mode: "deploy",
  status: "FAILED",
  current_stage: "BUILD",
  commit_sha: "a".repeat(40),
  ref: "main",
  trigger: "cli",
  target: "docker",
  build_strategy: "node",
  test_status: "PASSED",
  created_at: new Date("2026-10-01T10:00:00Z"),
  updated_at: new Date("2026-10-01T10:05:00Z"),
  error_message: null,
  artifact_path: null,
  artifact: null,
  artifact_type: "static",
  ...overrides,
});

const log = (stage, level, message, at = "2026-10-01T10:01:00Z") => ({ stage, level, message, created_at: new Date(at) });

test("diagnosis is deterministic and matches the most specific rule", () => {
  assert.equal(diagnose("Container image builds are disabled: set SHIPFLOW_IMAGE_BUILDS=enabled").category, "image-builds-disabled");
  assert.equal(diagnose("Host key verification failed.").category, "ssh-host-key");
  assert.equal(diagnose("pod x: ImagePullBackOff").category, "image-pull");
  assert.equal(diagnose("Live check failed after activation (expected status 200); restored previous release R1").category, "live-check-failed");
  assert.equal(diagnose('No "build" script found in package.json').category, "build-failed");
  assert.equal(diagnose("something odd").category, "unknown");
  assert.deepEqual(diagnose("something odd"), diagnose("something odd"));
});

test("evidence summarises the timeline, artifact and failure", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  const evidence = buildEvidence(
    release({
      status: "FAILED",
      error_message: "Live check failed after activation (expected status 200)",
      current_stage: "ACTIVATE",
      artifact_type: "image",
      artifact: { type: "image", key: "releases/AbCd1234/image/image.tar", digest, sizeBytes: 5, port: 3000 },
    }),
    [log("BUILD", "INFO", "ok"), log("ACTIVATE", "ERROR", "boom", "2026-10-01T10:04:00Z"), log("ACTIVATE", "WARN", "hmm")]
  );

  assert.deepEqual(evidence.artifact, { type: "image", digest, sizeBytes: 5, port: 3000 });
  assert.deepEqual(evidence.timeline.map((s) => [s.stage, s.errors, s.warnings]), [["BUILD", 0, 0], ["ACTIVATE", 1, 1]]);
  assert.equal(evidence.failure.stage, "ACTIVATE");
  assert.equal(evidence.diagnosis.category, "live-check-failed");
  assert.equal(evidence.buildStrategy, "node");
});

test("successful releases have no failure; legacy releases are static", () => {
  const evidence = buildEvidence(release({ status: "SUCCESS", artifact_path: "releases/AbCd1234/build", build_strategy: null }), []);

  assert.equal(evidence.failure, null);
  assert.equal(evidence.diagnosis, null);
  assert.deepEqual(evidence.artifact, { type: "static", path: "releases/AbCd1234/build" });
});

test("advisory analyzers are optional, labelled, and never throw", async () => {
  const evidence = buildEvidence(release(), []);

  assert.equal(await advise(evidence, undefined), null);
  assert.deepEqual(await advise(evidence, { analyze: async () => "try X" }), { advisory: true, text: "try X", error: null });

  const failed = await advise(evidence, { analyze: async () => { throw new Error("provider down"); } });
  assert.deepEqual(failed, { advisory: true, text: null, error: "provider down" });
});

// Pure decision logic for activation, retention, reconciliation, refs and
// the SSH target's verification helpers.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isStaleCandidate } from "../../dist/src/activation.js";
import { selectPrunable } from "../../dist/src/retention.js";
import { isOrphaned, orphanMessage } from "../../dist/src/reconcile.js";
import { classifyRef } from "../../dist/src/prepare.js";
import { parseRemoteManifest, compareManifests, explainSshFailure } from "../../dist/src/targets/ssh.js";
import { redactAll, releaseSettings } from "../../dist/src/pipeline.js";
import { proxyEnvironment } from "../../dist/src/sandbox.js";

test("an older DEPLOY candidate never replaces a newer live release", () => {
  assert.equal(isStaleCandidate({ action: "DEPLOY", candidateSeq: 5, activeSeq: 7 }), true);
  assert.equal(isStaleCandidate({ action: "DEPLOY", candidateSeq: 8, activeSeq: 7 }), false);
  assert.equal(isStaleCandidate({ action: "DEPLOY", candidateSeq: 5, activeSeq: null }), false);
  assert.equal(isStaleCandidate({ action: "ROLLBACK", candidateSeq: 5, activeSeq: 7 }), false);
  assert.equal(isStaleCandidate({ action: "REVERT", candidateSeq: 5, activeSeq: 7 }), false);
});

test("retention keeps the newest successes and whatever is live", () => {
  const releases = [
    { release_id: "R6", status: "RUNNING" },
    { release_id: "R5", status: "SUCCESS" },
    { release_id: "R4", status: "FAILED" },
    { release_id: "R3", status: "SUCCESS" },
    { release_id: "R2", status: "SUCCESS" },
    { release_id: "R1", status: "SUCCESS" },
  ];

  assert.deepEqual(selectPrunable(releases, { keep: 2, activeReleaseId: "R1" }), ["R4", "R2"]);
  assert.deepEqual(selectPrunable(releases, { keep: 0, activeReleaseId: "R1" }), [], "0 disables pruning");
});

test("reconciliation only fails releases whose job is gone", () => {
  assert.equal(isOrphaned({ status: "RUNNING" }, "active"), false);
  assert.equal(isOrphaned({ status: "RUNNING" }, "failed"), true);
  assert.equal(isOrphaned({ status: "RUNNING" }, "missing"), true);
  assert.equal(isOrphaned({ status: "QUEUED" }, "waiting"), false);
  assert.equal(isOrphaned({ status: "QUEUED" }, "missing"), true);

  assert.match(orphanMessage({ status: "RUNNING", current_stage: "ACTIVATE" }, "failed"), /may already be live/);
  assert.match(orphanMessage({ status: "RUNNING", current_stage: "BUILD" }, "failed"), /not retried/);
});

test("git refs are classified and anything odd is rejected", () => {
  assert.deepEqual(classifyRef(null), { kind: "default" });
  assert.equal(classifyRef("main").kind, "branch");
  assert.equal(classifyRef("feature/x-1").kind, "branch");
  assert.equal(classifyRef("refs/pull/42/head").kind, "fetch");
  assert.equal(classifyRef("a".repeat(40)).kind, "fetch");

  for (const ref of ["--upload-pack=x", "a..b", "main;rm", "refs/pull/x/head", "has space"]) {
    assert.throws(() => classifyRef(ref), /Invalid git ref/, ref);
  }
});

test("ssh manifests are compared file by file", () => {
  const remote = parseRemoteManifest(
    `${"a".repeat(64)}  ./index.html\n${"b".repeat(64)}  ./assets/app.js\ngarbage line\n`
  );

  assert.deepEqual(remote, { "index.html": "a".repeat(64), "assets/app.js": "b".repeat(64) });
  assert.deepEqual(compareManifests({ "index.html": "a".repeat(64), "assets/app.js": "b".repeat(64) }, remote), []);
  assert.deepEqual(
    compareManifests({ "index.html": "c".repeat(64), "x.css": "d".repeat(64) }, remote).sort(),
    ["checksum mismatch index.html", "missing x.css", "unexpected assets/app.js"]
  );
});

test("ssh failures are explained without hiding the cause", () => {
  const target = { host: "vps", port: 22, user: "deploy", privateKeySecret: "SSH_KEY" };
  assert.match(explainSshFailure("Host key verification failed.", target), /does not match deployment.ssh.hostKey/);
  assert.match(explainSshFailure("deploy@vps: Permission denied (publickey).", target), /rejected the key/);
  assert.match(explainSshFailure("ssh: connect to host vps port 22: Connection refused", target), /Cannot connect/);
});

test("redaction removes project secrets, including each line of a key", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----";
  const text = `error near b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ and ${key}`;
  const redacted = redactAll(text, [key]);

  assert.doesNotMatch(redacted, /b3BlbnNzaC1rZXkt/);
});

test("legacy releases without a config use the original defaults", () => {
  const settings = releaseSettings({ config: null });
  assert.equal(settings.target, "shipflow");
  assert.equal(settings.build.command, "auto");
});

test("sandbox proxy variables are only set when a proxy is configured", () => {
  assert.deepEqual(proxyEnvironment(""), []);
  const env = proxyEnvironment("http://egress-proxy:3128");
  assert.ok(env.includes("HTTPS_PROXY=http://egress-proxy:3128"));
  assert.ok(env.includes("npm_config_https_proxy=http://egress-proxy:3128"));
  assert.ok(env.includes("YARN_HTTPS_PROXY=http://egress-proxy:3128"));
});

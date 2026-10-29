import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPullRequestBody, commitMessage, neutralize, pullRequestTitle } from "../../dist/src/repopilot/prBody.js";

const finding = { id: 1, title: "Unchecked JSON.parse", category: "error-handling", severity: "high", evidenceKind: "observed", file: "src/index.js", lineStart: 1, lineEnd: 2, evidence: "JSON.parse can throw.", impact: "Crash.", remediation: "Catch it.", confidence: 0.7 };
const patch = { id: 3, diffSha256: "a".repeat(64), baseCommit: "b".repeat(40), explanation: "Wrap it." };
const verification = (arm, exitCode, kind = "exited") => ({ arm, kind, exitCode: kind === "exited" ? exitCode : null });
const body = (over = {}) => buildPullRequestBody({
  run: { id: 9, commitSha: "b".repeat(40), defaultBranch: "main" }, finding, patch,
  changedFiles: { source: ["src/index.js"], tests: ["test/new.test.js"] },
  outcome: { outcome: "improved", reasons: [] },
  verifications: [verification("baseline", 0), verification("baseline", 0), verification("control", 1), verification("control", 1), verification("patched", 0), verification("patched", 0)],
  authorizedBy: "user:alice", authorizedAt: new Date("2026-10-28T12:00:00Z"), baseMoved: null, ...over,
});

test("untrusted text cannot mention people, link, inject HTML or reference issues", () => {
  const out = neutralize("Ping @octocat! <img src=x onerror=alert(1)> see #123 [click](http://evil.example) `rm -rf` \n next");

  assert.ok(!out.includes("@octocat"), "mentions are broken");
  assert.ok(!/<img/.test(out) && out.includes("&lt;img"));
  assert.ok(!/#123/.test(out));
  assert.ok(!out.includes("[click]("));
  assert.ok(!out.includes("`") && !out.includes("\n"));
  assert.equal(neutralize("x".repeat(1000), 50).length, 51);
});

test("the body says what was proposed, what evidence exists, and what it does not show", () => {
  const text = body();

  assert.match(text, /human review required/);
  assert.match(text, /RepoPilot never merges/);
  assert.match(text, /an AI suggestion, not a confirmed defect/);
  assert.match(text, /rated its own confidence 70%\. That is its estimate, not a measurement/);
  assert.match(text, /\*\*Outcome: improved\*\*/);
  assert.match(text, /\| baseline \| 2 \| 2 \| 0 \| 0 \|/);
  assert.match(text, /\| control \| 2 \| 0 \| 2 \| 0 \|/);
  assert.match(text, /Passing tests are evidence, not proof/);
  assert.match(text, /all produced by an AI model/);
  assert.match(text, /Patch digest: `sha256:a{64}`/);
  assert.match(text, /Analysed commit: `b{40}`/);
  assert.match(text, /Authorised by `user:alice` at 2026-10-28T12:00:00.000Z/);
  // Outside the explicit disclaimer section, nothing may claim correctness.
  const withoutDisclaimer = text.replace(/### What this does not show[\s\S]*?(?=### Provenance)/, "");
  assert.doesNotMatch(withoutDisclaimer, /\b(verified|is correct|fully tested|safe to merge|bug[- ]free)\b/i);
});

test("with no sandbox evidence the body says so instead of showing results", () => {
  const text = body({ verifications: [], outcome: { outcome: "inconclusive", reasons: ["verification_unavailable"] } });

  assert.match(text, /No sandbox verification was run for this patch, so there are no test results/);
  assert.match(text, /Reasons: verification unavailable/);
  assert.doesNotMatch(text, /\| baseline/);
});

test("timeouts and errors are counted separately from passes and failures", () => {
  const text = body({ verifications: [verification("baseline", 0), verification("baseline", null, "timeout"), verification("patched", 0), verification("patched", null, "infra_error")], outcome: { outcome: "inconclusive", reasons: ["timeout", "infra_error"] } });

  assert.match(text, /\| baseline \| 2 \| 1 \| 0 \| 1 \|/);
  assert.match(text, /\| patched \| 2 \| 1 \| 0 \| 1 \|/);
});

test("a moved base branch is disclosed", () => {
  assert.match(body({ baseMoved: { aheadBy: 4 } }), /`main` has moved 4 commit\(s\) since analysis/);
  assert.doesNotMatch(body(), /has moved/);
});

test("hostile finding text is neutralised in the body", () => {
  const text = body({ finding: { ...finding, title: "Fix @maintainer #1 <script>", evidence: "[x](http://evil.example)", impact: "@everyone" } });

  assert.ok(!text.includes("@maintainer") && !text.includes("@everyone") && !text.includes("<script>"));
  assert.doesNotMatch(text, /(?<!\\)\]\(/, "no unescaped markdown link syntax survives");
});

test("titles and commit messages are bounded and neutralised", () => {
  assert.equal(pullRequestTitle({ title: "x".repeat(500) }).length <= 120, true);
  assert.match(pullRequestTitle({ title: "Fix @bob" }), /^RepoPilot: Fix @\u200bbob$/);

  const message = commitMessage({ title: "Fix thing" }, { diffSha256: "c".repeat(64) });
  assert.match(message, /^Fix thing\n\nProposed by ShipFlow RepoPilot \(AI-assisted\)/);
  assert.match(message, /Patch digest: sha256:c{64}/);
});

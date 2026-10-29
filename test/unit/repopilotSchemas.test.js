import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AnalysisOutputSchema,
  AuthorizePrRequestSchema,
  CreateRunRequestSchema,
  MAX_FINDINGS,
  MAX_MODEL_OUTPUT_BYTES,
  PatchProposalSchema,
  SandboxRunSchema,
  parseGithubRepoUrl,
  parseModelOutput,
} from "../../dist/src/repopilot/schemas.js";

const finding = (overrides = {}) => ({
  title: "Unchecked JSON.parse",
  category: "error-handling",
  severity: "medium",
  evidenceKind: "observed",
  impact: "A malformed config crashes the process at startup.",
  remediation: "Catch the error and report a clear message.",
  file: "src/config.js",
  lineStart: 10,
  lineEnd: 12,
  evidence: "JSON.parse(input) can throw on malformed input.",
  confidence: 0.7,
  ...overrides,
});

const proposal = (overrides = {}) => ({
  title: "Guard JSON.parse",
  explanation: "Wrap the parse call.",
  diff: "diff --git a/src/a.js b/src/a.js\n",
  testDiff: "diff --git a/test/a.test.js b/test/a.test.js\n",
  ...overrides,
});

// ------------------------------------------------------------ repository URL

test("repo URL accepts only github.com owner/repo and canonicalises it", () => {
  const cases = [
    ["https://github.com/shiv/site", "shiv", "site"],
    ["https://github.com/shiv/site.git", "shiv", "site"],
    ["https://github.com/shiv/site/", "shiv", "site"],
    ["  https://github.com/Some-Org/repo.name_1  ", "Some-Org", "repo.name_1"],
  ];

  for (const [input, owner, name] of cases) {
    const parsed = parseGithubRepoUrl(input);
    assert.ok(parsed.ok, input);
    assert.deepEqual(parsed.value, { owner, name, url: `https://github.com/${owner}/${name}` });
  }
});

test("repo URL rejects other hosts, schemes, credentials and tricks", () => {
  const bad = [
    "http://github.com/a/b",
    "git@github.com:a/b.git",
    "ssh://git@github.com/a/b",
    "file:///etc/passwd",
    "https://gitlab.com/a/b",
    "https://github.com.evil.example/a/b",
    "https://evil.example/github.com/a/b",
    "https://user:pass@github.com/a/b",
    "https://github.com:8443/a/b",
    "https://github.com/a/b?x=1",
    "https://github.com/a/b#frag",
    "https://github.com/a",
    "https://github.com/a/b/c",
    "https://github.com/a/../b",
    "https://github.com/./a/b",
    "https://github.com/a/..",
    "https://github.com/a/.",
    "https://github.com/-a/b",
    "https://github.com/a/b%2Fc",
    "https://github.com/a/b c",
    "https://github.com/a\\b/c",
    "https://GITHUB.com/a/b",
    "",
    "https://github.com/" + "a".repeat(40) + "/b",
    "-https://github.com/a/b",
    null,
    42,
    {},
  ];

  for (const value of bad) {
    assert.equal(parseGithubRepoUrl(value).ok, false, JSON.stringify(value));
  }
});

test("create-run request is strict and returns the canonical repo", () => {
  const parsed = CreateRunRequestSchema.parse({ repoUrl: "https://github.com/a/b.git" });
  assert.equal(parsed.repoUrl.url, "https://github.com/a/b");
  assert.throws(() => CreateRunRequestSchema.parse({ repoUrl: "https://github.com/a/b", commitSha: "x" }));
  assert.throws(() => CreateRunRequestSchema.parse({}));
  assert.throws(() => CreateRunRequestSchema.parse({ repoUrl: "https://example.com/a/b" }));
});

// ------------------------------------------------------ PR authorization

test("PR authorization names the patch and the exact diff digest and is strict", () => {
  const digest = "a".repeat(64);
  const base = { patchId: 3, diffSha256: digest, baseCommitSha: "b".repeat(40), outcome: "improved", confirm: true };
  assert.deepEqual(AuthorizePrRequestSchema.parse(base), base);

  for (const bad of [
    { ...base, confirm: undefined },
    { ...base, confirm: false },
    { ...base, confirm: "true" },
    { ...base, patchId: 0 },
    { ...base, diffSha256: "abc" },
    { ...base, diffSha256: digest.toUpperCase() },
    { ...base, baseCommitSha: "main" },
    { ...base, outcome: "verified" },
    { ...base, outcome: undefined },
    { ...base, merge: true },
  ]) {
    assert.throws(() => AuthorizePrRequestSchema.parse(bad), undefined, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------ model output

test("valid analysis output parses from JSON text or a decoded value", () => {
  const value = { findings: [finding(), finding({ title: "Second", file: "lib/x.ts" })] };

  for (const raw of [JSON.stringify(value), value]) {
    const result = parseModelOutput(AnalysisOutputSchema, raw);
    assert.ok(result.ok);
    assert.equal(result.value.findings.length, 2);
  }

  assert.ok(parseModelOutput(AnalysisOutputSchema, { findings: [] }).ok);
});

test("model output with unknown fields is rejected (strict objects)", () => {
  const result = parseModelOutput(AnalysisOutputSchema, {
    findings: [finding({ priority: "high" })],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "schema");
});

test("model output can never carry verification results, outcomes or authorization", () => {
  const smuggled = [
    { verified: true },
    { testsPassed: true },
    { test_results: { exitCode: 0 } },
    { outcome: "improved" },
    { sandbox: { ok: true } },
    { status: "verified" },
    { authorized: true },
    { approved: true },
    { merge: true },
    { autoMerge: true },
    { "Verification-Status": "passed" },
    { baseline: "fail", patched: "pass" },
  ];

  for (const extra of smuggled) {
    // Top level of a patch proposal.
    let result = parseModelOutput(PatchProposalSchema, proposal(extra));
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.code, "authoritative_field", JSON.stringify(extra));

    // Nested inside a finding.
    result = parseModelOutput(AnalysisOutputSchema, { findings: [finding(extra)] });
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.code, "authoritative_field", JSON.stringify(extra));

    // Next to the findings array.
    result = parseModelOutput(AnalysisOutputSchema, { findings: [], ...extra });
    assert.equal(result.ok, false, JSON.stringify(extra));
  }
});

test("a smuggled key is caught even buried in arrays and deep objects", () => {
  const deep = { findings: [finding()], meta: { a: [{ b: { c: { verified: true } } }] } };
  const result = parseModelOutput(AnalysisOutputSchema, deep);
  assert.equal(result.ok, false);
  assert.equal(result.code, "authoritative_field");
});

test("a __proto__ key in JSON text is rejected rather than ignored", () => {
  const raw = '{"findings": [], "__proto__": {"verified": true}}';
  const result = parseModelOutput(AnalysisOutputSchema, raw);
  assert.equal(result.ok, false);
  assert.equal(Object.prototype.verified, undefined);
});

test("the model schemas contain no field that could hold a verification result", () => {
  const forbidden = /verif|outcome|passed|sandbox|status|authoriz|approv|exit|result|merge|baseline|patched/i;

  for (const schema of [AnalysisOutputSchema, PatchProposalSchema]) {
    const walk = (node) => {
      const shape = node.shape ?? node.element?.shape ?? node.def?.element?.shape;
      if (!shape) return;
      for (const [key, child] of Object.entries(shape)) {
        assert.doesNotMatch(key, forbidden, key);
        walk(child);
      }
    };
    walk(schema);
  }

  assert.deepEqual(Object.keys(PatchProposalSchema.shape).sort(), ["diff", "explanation", "testDiff", "title"]);
});

test("model output failures are typed results, never exceptions", () => {
  assert.equal(parseModelOutput(AnalysisOutputSchema, "not json").code, "not_json");
  assert.equal(parseModelOutput(AnalysisOutputSchema, "").code, "not_json");
  assert.equal(parseModelOutput(AnalysisOutputSchema, "[1,2").code, "not_json");
  assert.equal(parseModelOutput(AnalysisOutputSchema, "x".repeat(MAX_MODEL_OUTPUT_BYTES + 1)).code, "too_large");
  assert.equal(parseModelOutput(AnalysisOutputSchema, null).code, "schema");
  assert.equal(parseModelOutput(AnalysisOutputSchema, []).code, "schema");
  assert.equal(parseModelOutput(AnalysisOutputSchema, "```json\n{}\n```").code, "not_json");
});

test("findings validate paths, line ranges, confidence and category", () => {
  const bad = [
    finding({ file: "../../etc/passwd" }),
    finding({ file: "/etc/passwd" }),
    finding({ file: "src\\a.js" }),
    finding({ file: ".git/config" }),
    finding({ file: "" }),
    finding({ lineStart: 0 }),
    finding({ lineStart: 1.5 }),
    finding({ lineStart: 20, lineEnd: 10 }),
    finding({ confidence: 1.2 }),
    finding({ confidence: -0.1 }),
    finding({ category: "style" }),
    finding({ severity: "urgent" }),
    finding({ evidenceKind: "proven" }),
    finding({ impact: "" }),
    finding({ remediation: "x".repeat(1001) }),
    finding({ title: "   " }),
    finding({ evidence: "x".repeat(2001) }),
  ];

  for (const item of bad) {
    const result = parseModelOutput(AnalysisOutputSchema, { findings: [item] });
    assert.equal(result.ok, false, JSON.stringify(item));
  }

  const tooMany = { findings: Array.from({ length: MAX_FINDINGS + 1 }, () => finding()) };
  assert.equal(parseModelOutput(AnalysisOutputSchema, tooMany).ok, false);
});

test("patch proposals require both diffs and bound their size", () => {
  assert.ok(parseModelOutput(PatchProposalSchema, proposal()).ok);
  assert.equal(parseModelOutput(PatchProposalSchema, proposal({ testDiff: "" })).ok, false);
  assert.equal(parseModelOutput(PatchProposalSchema, proposal({ diff: "" })).ok, false);
  assert.equal(parseModelOutput(PatchProposalSchema, proposal({ diff: "x".repeat(200_001) })).ok, false);
  assert.equal(parseModelOutput(PatchProposalSchema, { title: "t", explanation: "e", diff: "d" }).ok, false);
});

// ---------------------------------------------------------- sandbox records

test("sandbox run records are strict and typed", () => {
  const valid = [
    { kind: "exited", exitCode: 0, durationMs: 10 },
    { kind: "exited", exitCode: 255, durationMs: 0 },
    { kind: "timeout", durationMs: 300000 },
    { kind: "infra_error" },
    { kind: "infra_error", detail: "no daemon" },
    { kind: "resource_limit", detail: "oom" },
    { kind: "no_test_script" },
  ];

  for (const record of valid) {
    assert.deepEqual(SandboxRunSchema.parse(record), record);
  }

  const invalid = [
    { kind: "exited", exitCode: 0, durationMs: 10, verified: true },
    { kind: "exited", exitCode: 256, durationMs: 10 },
    { kind: "exited", durationMs: 10 },
    { kind: "timeout" },
    { kind: "no_test_script", extra: 1 },
    { kind: "unknown" },
  ];

  for (const record of invalid) {
    assert.equal(SandboxRunSchema.safeParse(record).success, false, JSON.stringify(record));
  }
});

test("model-output parsing never accepts a sandbox record shape as a proposal", () => {
  const result = parseModelOutput(PatchProposalSchema, { kind: "exited", exitCode: 0, durationMs: 1 });
  assert.equal(result.ok, false);
});

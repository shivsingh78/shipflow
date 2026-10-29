import { test } from "node:test";
import assert from "node:assert/strict";

import { applyProposal, MAX_RESULT_FILE_BYTES } from "../../dist/src/repopilot/apply.js";

const files = (entries) => new Map(Object.entries(entries));
const TEST_ADD = ["diff --git a/test/x.test.js b/test/x.test.js", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/test/x.test.js", "@@ -0,0 +1,2 @@", "+import test from 'node:test';", "+test('x', () => {});", ""].join("\n");
const mod = (path, body) => [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644", `--- a/${path}`, `+++ b/${path}`, ...body, ""].join("\n");
const apply = (fileMap, diff, testDiff = TEST_ADD) => applyProposal(files(fileMap), { diff, testDiff });
const codes = (r) => (r.ok ? [] : r.issues.map((i) => i.code));

const ORIGINAL = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";

test("a modification and an added test file apply exactly", () => {
  const result = apply({ "src/a.js": ORIGINAL }, mod("src/a.js", ["@@ -1,3 +1,3 @@", " const a = 1;", "-const b = 2;", "+const b = 20;", " const c = 3;"]));

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.changed.get("src/a.js"), "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n");
  assert.equal(result.changed.get("test/x.test.js"), "import test from 'node:test';\ntest('x', () => {});\n");
  assert.deepEqual([...result.testPaths], ["test/x.test.js"]);
});

test("the input file map is never mutated", () => {
  const input = files({ "src/a.js": ORIGINAL });
  applyProposal(input, { diff: mod("src/a.js", ["@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 9;"]), testDiff: TEST_ADD });

  assert.equal(input.get("src/a.js"), ORIGINAL);
  assert.equal(input.size, 1);
});

test("multiple hunks, insertions and deletions", () => {
  const original = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
  const diff = mod("src/a.js", [
    "@@ -2,2 +2,3 @@", " line2", "+inserted", " line3",
    "@@ -9,3 +10,1 @@", " line9", "-line10", "-line11",
  ]);
  const result = apply({ "src/a.js": original }, diff);

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.changed.get("src/a.js"), "line1\nline2\ninserted\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline12\n");
});

test("pure insertion after a line (zero old lines)", () => {
  const result = apply({ "src/a.js": "a\nb\n" }, mod("src/a.js", ["@@ -1,0 +2 @@", "+between"]));

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.changed.get("src/a.js"), "a\nbetween\nb\n");
});

test("context that does not match is a failure, never a fuzzy match", () => {
  const diff = mod("src/a.js", ["@@ -1,3 +1,3 @@", " const a = 1;", "-const b = TWO;", "+const b = 20;", " const c = 3;"]);
  const result = apply({ "src/a.js": ORIGINAL }, diff);

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["context_mismatch"]);
});

test("a hunk at the wrong line number does not apply (no offset search)", () => {
  const diff = mod("src/a.js", ["@@ -2,2 +2,2 @@", " const a = 1;", "-const b = 2;", "+const b = 20;"]);

  assert.deepEqual(codes(apply({ "src/a.js": ORIGINAL }, diff)), ["context_mismatch"]);
  assert.deepEqual(codes(apply({ "src/a.js": ORIGINAL }, mod("src/a.js", ["@@ -90,1 +90,1 @@", "-x", "+y"]))), ["out_of_range"]);
});

test("modifying a missing file and adding an existing one both fail", () => {
  assert.deepEqual(codes(apply({}, mod("src/a.js", ["@@ -1 +1 @@", "-a", "+b"]))), ["file_missing"]);
  assert.deepEqual(codes(apply({ "src/a.js": ORIGINAL, "test/x.test.js": "// existing\n" }, mod("src/a.js", ["@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 3;"]))), ["file_exists"]);
});

test("a file whose current content is binary is refused", () => {
  // The diff itself is clean text; the file in the snapshot contains a NUL.
  assert.deepEqual(codes(apply({ "src/a.js": "a\0b\n" }, mod("src/a.js", ["@@ -1 +1 @@", "-a", "+c"]))), ["binary_content"]);
});

test("a NUL byte inside the diff is a policy rejection", () => {
  assert.deepEqual(codes(apply({ "src/a.js": "ab\n" }, mod("src/a.js", ["@@ -1 +1 @@", "-a\0b", "+c"]))), ["policy_rejected"]);
});

test("end-of-file newline handling follows the no-newline markers", () => {
  // File without a trailing newline; patch keeps it that way.
  const noEol = apply({ "src/a.js": "a\nb" }, mod("src/a.js", ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"]));
  assert.ok(noEol.ok, JSON.stringify(noEol));
  assert.equal(noEol.changed.get("src/a.js"), "a\nc");

  // Patch ADDS the trailing newline.
  const adds = apply({ "src/a.js": "a\nb" }, mod("src/a.js", ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+b"]));
  assert.ok(adds.ok, JSON.stringify(adds));
  assert.equal(adds.changed.get("src/a.js"), "a\nb\n");

  // Patch claims no trailing newline but the file has one.
  assert.deepEqual(codes(apply({ "src/a.js": "a\nb\n" }, mod("src/a.js", ["@@ -1,2 +1,2 @@", " a", "-b", "\\ No newline at end of file", "+c", "\\ No newline at end of file"]))), ["context_mismatch"]);

  // Editing the middle leaves the final newline state alone.
  assert.equal(apply({ "src/a.js": "a\nb\nc" }, mod("src/a.js", ["@@ -1,2 +1,2 @@", " a", "-b", "+B"])).changed.get("src/a.js"), "a\nB\nc");
});

test("an added file without a trailing newline keeps that", () => {
  const add = ["diff --git a/test/y.test.js b/test/y.test.js", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/test/y.test.js", "@@ -0,0 +1 @@", "+x", "\\ No newline at end of file", ""].join("\n");
  const result = apply({ "src/a.js": ORIGINAL }, mod("src/a.js", ["@@ -1,2 +1,2 @@", " const a = 1;", "-const b = 2;", "+const b = 3;"]), add);

  assert.equal(result.changed.get("test/y.test.js"), "x");
});

test("a proposal that breaks policy is rejected before anything is applied", () => {
  const result = apply({ "package.json": "{}\n" }, mod("package.json", ["@@ -1 +1 @@", "-{}", "+{\"scripts\":{}}"]));

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["policy_rejected"]);
  assert.ok(result.policyIssues.some((i) => i.code === "forbidden_path"));
});

test("oversized results are refused", () => {
  const huge = "x".repeat(MAX_RESULT_FILE_BYTES);
  const result = apply({ "src/a.js": `${huge}\nz\n` }, mod("src/a.js", ["@@ -2 +2,2 @@", " z", "+".concat("y".repeat(900))]), TEST_ADD);

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["result_too_large"]);
});

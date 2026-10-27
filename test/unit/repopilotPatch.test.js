import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PATCH_LIMITS,
  patchDigest,
  validatePatchProposal,
  validateUnifiedDiff,
} from "../../dist/src/repopilot/patch.js";
import { checkRepoPath, forbiddenPathReason } from "../../dist/src/repopilot/paths.js";

/** git-style modification of `path` replacing line 2. */
const modify = (path = "src/util.js") =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
    "",
  ].join("\n");

/** git-style new file. */
const add = (path = "test/util.test.js", lines = ["import test from 'node:test';", "test('x', () => {});"]) =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");

const codes = (result) => (result.ok ? [] : result.issues.map((issue) => issue.code));

// -------------------------------------------------------------- happy path

test("a well-formed source diff and added regression test validate", () => {
  const result = validatePatchProposal({ diff: modify(), testDiff: add() });
  assert.ok(result.ok, JSON.stringify(result.issues));
  assert.deepEqual(result.source.files, [
    { path: "src/util.js", kind: "modify", added: 1, removed: 1, hunks: 1 },
  ]);
  assert.deepEqual(result.test.files, [
    { path: "test/util.test.js", kind: "add", added: 2, removed: 0, hunks: 1 },
  ]);
  assert.equal(result.digest, patchDigest(modify(), add()));
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test("diffs without 'diff --git' headers and with multiple files/hunks validate", () => {
  const diff = [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@ function f()",
    "-x",
    "+y",
    " z",
    "@@ -10 +10,2 @@",
    " q",
    "+r",
    "\\ No newline at end of file",
    "--- a/src/b.mjs",
    "+++ b/src/b.mjs",
    "@@ -1 +1 @@",
    "-1",
    "+2",
    "",
  ].join("\n");

  const result = validateUnifiedDiff(diff, "source");
  assert.ok(result.ok, JSON.stringify(result.issues));
  assert.equal(result.patch.files.length, 2);
  assert.equal(result.patch.files[0].hunks, 2);
});

test("the digest changes if either diff changes", () => {
  assert.notEqual(patchDigest("a", "b"), patchDigest("a", "c"));
  assert.notEqual(patchDigest("a", "b"), patchDigest("ab", ""));
  assert.equal(patchDigest("a", "b"), patchDigest("a", "b"));
});

// ------------------------------------------------------- path traversal etc

test("path traversal in a diff is rejected", () => {
  for (const path of ["../outside.js", "src/../../etc/x.js", "a/../../b.js", "..", "src/.."]) {
    const result = validateUnifiedDiff(modify(path), "source");
    assert.equal(result.ok, false, path);
    assert.deepEqual(codes(result), ["path_traversal"], path);
  }
});

test("absolute and drive paths are rejected", () => {
  const cases = [
    // b/ prefix leaves a leading "/" when the path itself is absolute.
    ["/etc/passwd.js", "absolute_path"],
    ["C:/Windows/x.js", "absolute_path"],
    ["~/x.js", "absolute_path"],
  ];

  for (const [path, code] of cases) {
    const result = validateUnifiedDiff(modify(path), "source");
    assert.deepEqual(codes(result), [code], path);
  }
});

test("empty segments, dot segments, backslashes, .git and control characters are rejected", () => {
  for (const path of ["src//a.js", "src/./a.js", "src\\a.js", ".git/hooks/pre-commit.js", "src/.git/x.js", "src/a\u202e.js", "src/a\u200b.js"]) {
    const result = validateUnifiedDiff(modify(path), "source");
    assert.equal(result.ok, false, JSON.stringify(path));
    assert.deepEqual(codes(result), ["invalid_path"], JSON.stringify(path));
  }

  // A tab (diff -u timestamp suffix) ends up in the path and is rejected.
  const tabbed = modify("src/a.js").replace("--- a/src/a.js", "--- a/src/a.js\t2024-01-01");
  assert.equal(validateUnifiedDiff(tabbed, "source").ok, false);
});

test("checkRepoPath is strict on its own", () => {
  assert.ok(checkRepoPath("src/index.ts").ok);
  assert.ok(checkRepoPath("a").ok);

  for (const value of ["", "/", "..", "a/..", "a/./b", "a//b", "a/", "x\0y", 7, null, undefined, "a".repeat(301)]) {
    assert.equal(checkRepoPath(value).ok, false, JSON.stringify(value));
  }
});

// --------------------------------------------------------- forbidden paths

test("CI, Docker, env, lockfile, manifest and runner-config paths are forbidden", () => {
  const forbidden = [
    ".github/workflows/ci.js",
    ".github/scripts/deploy.js",
    ".circleci/config.js",
    ".husky/pre-commit.js",
    "Dockerfile",
    "docker/Dockerfile.js",
    "app.dockerfile",
    "docker-compose.yml",
    "compose.yaml",
    ".dockerignore",
    ".env",
    ".env.production",
    "config/.env.js",
    "prod.env",
    ".envrc",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "package.json",
    "packages/a/package.json",
    ".npmrc",
    ".yarnrc.yml",
    ".pnpmfile.cjs",
    "pnpm-workspace.yaml",
    ".gitignore",
    ".gitattributes",
    ".gitmodules",
    ".gitlab-ci.yml",
    "Jenkinsfile",
    ".travis.yml",
    "node_modules/pkg/index.js",
    "sub/node_modules/pkg/index.js",
    "jest.config.js",
    "vitest.config.ts",
    "babel.config.js",
    ".mocharc.js",
    ".babelrc",
    "certs/server.pem",
    "id_rsa",
  ];

  for (const path of forbidden) {
    assert.notEqual(forbiddenPathReason(path), null, path);
  }

  for (const path of ["src/index.js", "lib/envelope.js", "src/dockerfile-parser.js", "test/a.test.js", "src/package-utils.js", "src/github.js"]) {
    assert.equal(forbiddenPathReason(path), null, path);
  }
});

test("a diff touching a forbidden path is rejected even if the rest is fine", () => {
  for (const path of [".github/workflows/ci.js", "package.json", "pnpm-lock.yaml", ".env", "Dockerfile"]) {
    const result = validateUnifiedDiff(modify(path), "source");
    assert.equal(result.ok, false, path);
    assert.ok(codes(result).includes("forbidden_path"), path);
  }
});

test("only JavaScript and TypeScript files may be changed", () => {
  for (const path of ["README.md", "src/data.json", "scripts/run.sh", "src/style.css", "src/a.py", "src/noext"]) {
    assert.ok(codes(validateUnifiedDiff(modify(path), "source")).includes("unexpected_file_type"), path);
  }

  for (const path of ["a.js", "a.jsx", "a.mjs", "a.cjs", "a.ts", "a.tsx", "a.mts", "a.cts", "a.d.ts"]) {
    assert.ok(validateUnifiedDiff(modify(`src/${path}`), "source").ok, path);
  }
});

// ---------------------------------------------------------------- symlinks

test("symlink modes in diff headers are rejected", () => {
  const symlinkAdd = [
    "diff --git a/src/link.js b/src/link.js",
    "new file mode 120000",
    "index 0000000..4444444",
    "--- /dev/null",
    "+++ b/src/link.js",
    "@@ -0,0 +1 @@",
    "+../../etc/passwd",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  assert.deepEqual(codes(validateUnifiedDiff(symlinkAdd, "source")), ["symlink"]);

  const symlinkIndex = modify().replace("index 1111111..2222222 100644", "index 1111111..2222222 120000");
  assert.deepEqual(codes(validateUnifiedDiff(symlinkIndex, "source")), ["symlink"]);

  const submodule = modify().replace("index 1111111..2222222 100644", "index 1111111..2222222 160000");
  assert.deepEqual(codes(validateUnifiedDiff(submodule, "source")), ["submodule"]);
});

test("paths that are, or sit under, a symlink in the snapshot are rejected", () => {
  const symlinkPaths = new Set(["src/linked"]);

  assert.ok(codes(validateUnifiedDiff(modify("src/linked"), "source", { symlinkPaths })).includes("symlink"));
  assert.ok(codes(validateUnifiedDiff(modify("src/linked/a.js"), "source", { symlinkPaths })).includes("symlink"));
  assert.ok(validateUnifiedDiff(modify("src/linked-not.js"), "source", { symlinkPaths }).ok);
});

// ------------------------------------------------------- unsupported changes

test("renames, copies, deletions, mode changes and binary patches are rejected", () => {
  const rename = [
    "diff --git a/src/a.js b/src/b.js",
    "similarity index 100%",
    "rename from src/a.js",
    "rename to src/b.js",
    "",
  ].join("\n");
  assert.deepEqual(codes(validateUnifiedDiff(rename, "source")), ["rename_or_copy"]);

  const copy = ["diff --git a/src/a.js b/src/b.js", "copy from src/a.js", "copy to src/b.js", ""].join("\n");
  assert.deepEqual(codes(validateUnifiedDiff(copy, "source")), ["rename_or_copy"]);

  const renamedViaHeaders = modify().replace("+++ b/src/util.js", "+++ b/src/other.js");
  assert.ok(["rename_or_copy", "malformed"].includes(codes(validateUnifiedDiff(renamedViaHeaders, "source"))[0]));

  const deleted = [
    "diff --git a/src/a.js b/src/a.js",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/src/a.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
    "",
  ].join("\n");
  assert.deepEqual(codes(validateUnifiedDiff(deleted, "source")), ["delete_file"]);

  const deletedNoHeader = ["--- a/src/a.js", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", ""].join("\n");
  assert.deepEqual(codes(validateUnifiedDiff(deletedNoHeader, "source")), ["delete_file"]);

  const modeChange = ["diff --git a/src/a.js b/src/a.js", "old mode 100644", "new mode 100755", ""].join("\n");
  assert.deepEqual(codes(validateUnifiedDiff(modeChange, "source")), ["mode_change"]);

  const executable = add("src/run.js").replace("new file mode 100644", "new file mode 100755");
  assert.deepEqual(codes(validateUnifiedDiff(executable, "source")), ["mode_change"]);

  const binary = ["diff --git a/src/a.js b/src/a.js", "index 1111111..2222222 100644", "GIT binary patch", "literal 0", ""].join("\n");
  assert.deepEqual(codes(validateUnifiedDiff(binary, "source")), ["binary_patch"]);

  const binaryFiles = ["diff --git a/src/a.js b/src/a.js", "Binary files a/src/a.js and b/src/a.js differ", ""].join("\n");
  assert.deepEqual(codes(validateUnifiedDiff(binaryFiles, "source")), ["binary_patch"]);
});

// ------------------------------------------------------------- malformed

test("malformed diffs are rejected with a specific reason", () => {
  const cases = {
    "prose before the diff": "Here is the fix:\n" + modify(),
    "markdown fence": "```diff\n" + modify() + "```\n",
    "missing +++ line": ["--- a/src/a.js", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    "missing a/ prefix": ["--- src/a.js", "+++ src/a.js", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    "hunk shorter than header": ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1,3 +1,3 @@", " a", "-b", "+c", ""].join("\n"),
    "hunk longer than header": ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1 +1 @@", "-a", "+b", "+c", ""].join("\n"),
    "bad hunk header": ["--- a/src/a.js", "+++ b/src/a.js", "@@ -x +y @@", "-a", ""].join("\n"),
    "no hunks": ["--- a/src/a.js", "+++ b/src/a.js", ""].join("\n"),
    "blank line in a hunk": ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1,2 +1,2 @@", " a", "", "-b", "+c", ""].join("\n"),
    "invalid marker": ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1 +1 @@", "*a", ""].join("\n"),
    "garbage after a hunk": [...modify().split("\n").slice(0, -1), "trailing junk", ""].join("\n"),
    "bad diff --git header": ["diff --git src/a.js src/a.js", "--- a/src/a.js", "+++ b/src/a.js", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    "git header path mismatch": modify().replace("diff --git a/src/util.js b/src/util.js", "diff --git a/src/other.js b/src/other.js"),
    "unknown extended header": modify().replace("index 1111111..2222222 100644", "mystery header"),
    "new file mode without /dev/null": modify().replace("index 1111111..2222222 100644", "new file mode 100644"),
    "/dev/null on both sides": ["--- /dev/null", "+++ /dev/null", ""].join("\n"),
    "overlapping hunks": ["--- a/src/a.js", "+++ b/src/a.js", "@@ -5,2 +5,2 @@", " a", "-b", "+c", "@@ -4,2 +4,2 @@", " a", "-b", "+c", ""].join("\n"),
    "new file with several hunks": ["--- /dev/null", "+++ b/test/a.test.js", "@@ -0,0 +1 @@", "+a", "@@ -0,0 +2 @@", "+b", ""].join("\n"),
    "new file with deletions": ["--- /dev/null", "+++ b/test/a.test.js", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"),
    "stray no-newline marker": ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1 +1 @@", "\\ No newline at end of file", "-a", "+b", ""].join("\n"),
    "custom backslash line": ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1 +1 @@", "-a", "\\ whatever", "+b", ""].join("\n"),
  };

  for (const [name, diff] of Object.entries(cases)) {
    const result = validateUnifiedDiff(diff, "source");
    assert.equal(result.ok, false, name);
    assert.ok(codes(result).includes("malformed"), `${name}: ${JSON.stringify(codes(result))}`);
  }
});

test("empty, non-string and NUL-containing diffs are rejected", () => {
  assert.deepEqual(codes(validateUnifiedDiff("", "source")), ["empty_diff"]);
  assert.deepEqual(codes(validateUnifiedDiff("\n", "source")), ["empty_diff"]);
  assert.deepEqual(codes(validateUnifiedDiff("   \n\t\n", "source")), ["empty_diff"]);
  assert.deepEqual(codes(validateUnifiedDiff(undefined, "source")), ["not_text"]);
  assert.deepEqual(codes(validateUnifiedDiff(42, "source")), ["not_text"]);
  assert.deepEqual(codes(validateUnifiedDiff(modify().replace("const c", "const\0c"), "source")), ["nul_byte"]);
});

test("a diff without a trailing newline is accepted", () => {
  assert.ok(validateUnifiedDiff(modify().trimEnd(), "source").ok);
});

// ------------------------------------------------------------- size limits

test("size limits are enforced for bytes, files, changed lines and line length", () => {
  const limits = { ...DEFAULT_PATCH_LIMITS };

  // Bytes (measured in UTF-8, not characters).
  const bigBytes = validateUnifiedDiff(modify(), "source", { limits: { maxSourceBytes: 50 } });
  assert.deepEqual(codes(bigBytes), ["too_large"]);

  const multibyte = add("test/x.test.js", ["é".repeat(20)]);
  assert.equal(Buffer.byteLength(multibyte) > multibyte.length, true);
  assert.deepEqual(codes(validateUnifiedDiff(multibyte, "test", { limits: { maxTestBytes: multibyte.length } })), ["too_large"]);

  // Files.
  const files = Array.from({ length: limits.maxSourceFiles + 1 }, (_, i) => modify(`src/f${i}.js`)).join("");
  assert.deepEqual(codes(validateUnifiedDiff(files, "source", { limits: { maxSourceBytes: 1_000_000 } })), ["too_many_files"]);
  assert.ok(validateUnifiedDiff(files, "source", { limits: { maxSourceFiles: 6 } }).ok);

  const manyTests = Array.from({ length: limits.maxTestFiles + 1 }, (_, i) => add(`test/t${i}.test.js`)).join("");
  assert.deepEqual(codes(validateUnifiedDiff(manyTests, "test")), ["too_many_files"]);

  // Changed lines.
  const lines = Array.from({ length: 11 }, (_, i) => `const v${i} = ${i};`);
  assert.deepEqual(
    codes(validateUnifiedDiff(add("test/big.test.js", lines), "test", { limits: { maxTestChangedLines: 10 } })),
    ["too_many_changed_lines"]
  );
  assert.ok(validateUnifiedDiff(add("test/big.test.js", lines), "test", { limits: { maxTestChangedLines: 11 } }).ok);

  // Changed lines are counted across files, not per file.
  const two = modify("src/a.js") + modify("src/b.js");
  assert.deepEqual(codes(validateUnifiedDiff(two, "source", { limits: { maxSourceChangedLines: 3 } })), ["too_many_changed_lines"]);

  // Line length.
  const long = add("test/long.test.js", ["x".repeat(1001)]);
  assert.deepEqual(codes(validateUnifiedDiff(long, "test", { limits: { maxTestBytes: 10_000 } })), ["line_too_long"]);
});

test("a huge declared hunk length cannot hang or over-allocate the parser", () => {
  const diff = ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1,999999999 +1,999999999 @@", " a", ""].join("\n");
  assert.deepEqual(codes(validateUnifiedDiff(diff, "source")), ["malformed"]);
});

// ----------------------------------------------- source/test separation rules

test("the source patch may not change test files", () => {
  for (const path of ["test/a.test.js", "src/__tests__/a.js", "src/a.spec.ts", "tests/helper.js"]) {
    assert.ok(codes(validateUnifiedDiff(modify(path), "source")).includes("test_file_in_source_patch"), path);
  }
});

test("the test patch may only ADD files, and only test files", () => {
  const modifyTest = validateUnifiedDiff(modify("test/existing.test.js"), "test");
  assert.deepEqual(codes(modifyTest), ["test_modifies_existing_file"]);

  const addSource = validateUnifiedDiff(add("src/helper.js"), "test");
  assert.deepEqual(codes(addSource), ["non_test_file_in_test_patch"]);

  assert.ok(validateUnifiedDiff(add("test/new.test.js"), "test").ok);
  assert.ok(validateUnifiedDiff(add("src/new.spec.ts"), "test").ok);
});

test("a regression test is mandatory", () => {
  for (const testDiff of ["", "  \n", undefined]) {
    const result = validatePatchProposal({ diff: modify(), testDiff });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("missing_test_patch") || codes(result).includes("not_text"));
  }
});

test("the same path may not appear in both diffs or twice in one diff", () => {
  const sameFile = validatePatchProposal({
    diff: modify("src/a.js"),
    testDiff: add("src/a.js"),
  });
  assert.equal(sameFile.ok, false);

  const twice = modify("src/a.js") + modify("src/A.js");
  assert.ok(codes(validateUnifiedDiff(twice, "source")).includes("duplicate_path"));
});

test("a proposal reports issues from both diffs together", () => {
  const result = validatePatchProposal({ diff: modify("package.json"), testDiff: add("src/x.js") });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("forbidden_path"));
  assert.ok(codes(result).includes("non_test_file_in_test_patch"));
  assert.ok(result.issues.every((issue) => issue.role === "source" || issue.role === "test"));
});

// ------------------------------------------------------ snapshot awareness

test("when a snapshot file list is given, adds and modifies are checked against it", () => {
  const existingFiles = new Set(["src/util.js", "test/old.test.js"]);

  assert.ok(validatePatchProposal({ diff: modify("src/util.js"), testDiff: add("test/new.test.js") }, { existingFiles }).ok);

  const missing = validatePatchProposal({ diff: modify("src/nope.js"), testDiff: add("test/new.test.js") }, { existingFiles });
  assert.deepEqual(codes(missing), ["modify_missing_file"]);

  const clobber = validatePatchProposal({ diff: modify("src/util.js"), testDiff: add("test/old.test.js") }, { existingFiles });
  assert.deepEqual(codes(clobber), ["add_existing_file"]);

  // Without a file list those checks are skipped.
  assert.ok(validatePatchProposal({ diff: modify("src/nope.js"), testDiff: add("test/old.test.js") }).ok);
});

test("validation is deterministic and has no side effects on its input", () => {
  const input = { diff: modify(), testDiff: add() };
  const snapshot = JSON.stringify(input);
  const first = validatePatchProposal(input);
  const second = validatePatchProposal(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isValidReleaseId,
  validateRepoUrl,
  safeRelativePath,
} from "../../dist/src/validation.js";
import { genrate } from "../../dist/src/genrate.js";

const ALLOWED = ["https://github.com/shiv/"];

test("generated release IDs are valid", () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(isValidReleaseId(genrate()));
  }
});

test("release ID validation rejects unsafe values", () => {
  for (const value of ["", "abc", "../../etc", "abcdefg!", "abcdefghi", null, 12345678]) {
    assert.equal(isValidReleaseId(value), false, String(value));
  }
});

test("repo URL accepts allowed GitHub repositories and normalizes them", () => {
  assert.equal(
    validateRepoUrl(" https://github.com/shiv/site.git ", ALLOWED),
    "https://github.com/shiv/site.git"
  );
  assert.equal(
    validateRepoUrl("https://github.com/shiv/site/", ALLOWED),
    "https://github.com/shiv/site"
  );
});

test("repo URL rejects disallowed or malformed URLs", () => {
  const bad = [
    undefined,
    "",
    "not a url",
    "file:///etc/passwd",
    "ssh://git@github.com/shiv/site.git",
    "git@github.com:shiv/site.git",
    "https://user:pass@github.com/shiv/site.git",
    "https://github.com/other/site.git",
    "https://github.com.evil.com/shiv/site.git",
    "https://github.com/shiv/site.git?x=1",
    "https://github.com/shiv/../other/site",
    "https://github.com/shiv/site/extra",
    "--upload-pack=touch /tmp/x",
    "https://github.com/shiv/si te",
  ];

  for (const url of bad) {
    assert.throws(() => validateRepoUrl(url, ALLOWED), Error, String(url));
  }
});

test("safeRelativePath resolves index files and blocks traversal", () => {
  assert.equal(safeRelativePath("/"), "index.html");
  assert.equal(safeRelativePath(""), "index.html");
  assert.equal(safeRelativePath("/assets/app.js"), "assets/app.js");
  assert.equal(safeRelativePath("/docs/"), "docs/index.html");
  assert.equal(safeRelativePath("/a/./b.css"), "a/b.css");
  assert.equal(safeRelativePath("/../secret"), null);
  assert.equal(safeRelativePath("/assets/%2e%2e/%2e%2e/x"), null);
  assert.equal(safeRelativePath("/a%5cb"), null);
  assert.equal(safeRelativePath("/%E0%A4%A"), null);
});

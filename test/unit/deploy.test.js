import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  localAssetReferences,
  validateArtifact,
} from "../../src/deploy.js";

async function artifact(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-artifact-"));

  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }

  return dir;
}

test("finds local asset references and ignores external ones", () => {
  const html = `
    <link rel="stylesheet" href="/assets/style.css?v=1">
    <script src="./assets/app.js"></script>
    <script src="https://cdn.example.com/lib.js"></script>
    <a href="/about">About</a>
    <a href="#top">Top</a>
    <img src="data:image/png;base64,xx">
    <link rel="icon" href="//example.com/favicon.ico">`;

  assert.deepEqual(localAssetReferences(html).sort(), [
    "assets/app.js",
    "assets/style.css",
  ]);
});

test("accepts a complete artifact", async () => {
  const dir = await artifact({
    "index.html": '<script src="/assets/app.js"></script>',
    "assets/app.js": "console.log(1)",
  });

  const result = await validateArtifact(dir);

  assert.equal(result.files.length, 2);
  assert.ok(result.totalBytes > 0);
});

test("rejects artifacts without index.html", async () => {
  const dir = await artifact({ "app.js": "x" });

  await assert.rejects(validateArtifact(dir), /no index.html/);
});

test("rejects artifacts whose index.html references missing files", async () => {
  const dir = await artifact({
    "index.html": '<script src="/assets/missing.js"></script>',
  });

  await assert.rejects(validateArtifact(dir), /assets\/missing.js/);
});

test("skips symlinks so worker files cannot be uploaded", async () => {
  const dir = await artifact({ "index.html": "<h1>hi</h1>" });
  await fs.symlink("/etc/passwd", path.join(dir, "passwd"));

  const result = await validateArtifact(dir);

  assert.equal(result.files.length, 1);
  assert.equal(result.skippedSymlinks, 1);
});

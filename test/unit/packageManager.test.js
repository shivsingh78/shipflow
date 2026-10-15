import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  detectPackageManager,
  installCommand,
  runScriptCommand,
  classifyTestScript,
  readPackageJson,
} from "../../src/packageManager.js";

async function project(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sf-pm-"));

  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }

  return dir;
}

test("detects package manager from lockfiles", async () => {
  const cases = [
    [{ "package-lock.json": "{}" }, "npm", true],
    [{ "pnpm-lock.yaml": "" }, "pnpm", true],
    [{ "yarn.lock": "" }, "yarn", true],
    [{}, "npm", false],
  ];

  for (const [files, name, hasLockfile] of cases) {
    const dir = await project(files);
    const pm = await detectPackageManager(dir, {});

    assert.equal(pm.name, name);
    assert.equal(pm.hasLockfile, hasLockfile);
  }
});

test("packageManager field wins over lockfiles", async () => {
  const dir = await project({ "package-lock.json": "{}", "yarn.lock": "" });
  const pm = await detectPackageManager(dir, { packageManager: "yarn@4.1.0" });

  assert.equal(pm.name, "yarn");
  assert.equal(pm.hasLockfile, true);
  assert.equal(pm.yarnBerry, true);
});

test("uses reproducible installs when a lockfile exists", () => {
  assert.deepEqual(installCommand({ name: "npm", hasLockfile: true }).slice(0, 2), ["npm", "ci"]);
  assert.deepEqual(installCommand({ name: "npm", hasLockfile: false }).slice(0, 2), ["npm", "install"]);
  assert.deepEqual(installCommand({ name: "pnpm", hasLockfile: true }), [
    "corepack", "pnpm", "install", "--frozen-lockfile",
  ]);
  assert.deepEqual(installCommand({ name: "pnpm", hasLockfile: false }), [
    "corepack", "pnpm", "install", "--no-frozen-lockfile",
  ]);
  assert.deepEqual(installCommand({ name: "yarn", hasLockfile: true, yarnBerry: false }), [
    "corepack", "yarn", "install", "--frozen-lockfile",
  ]);
  assert.deepEqual(installCommand({ name: "yarn", hasLockfile: true, yarnBerry: true }), [
    "corepack", "yarn", "install", "--immutable",
  ]);
});

test("script commands are argv arrays", () => {
  assert.deepEqual(runScriptCommand({ name: "npm" }, "build"), ["npm", "run", "build"]);
  assert.deepEqual(runScriptCommand({ name: "pnpm" }, "test"), ["corepack", "pnpm", "run", "test"]);
});

test("classifies missing and placeholder test scripts", () => {
  assert.equal(classifyTestScript({}), "MISSING");
  assert.equal(classifyTestScript({ scripts: { test: " " } }), "MISSING");
  assert.equal(
    classifyTestScript({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    "PLACEHOLDER"
  );
  assert.equal(classifyTestScript({ scripts: { test: "vitest run" } }), "PRESENT");
});

test("readPackageJson gives clear errors", async () => {
  await assert.rejects(readPackageJson(await project({})), /No package.json/);
  await assert.rejects(
    readPackageJson(await project({ "package.json": "{nope" })),
    /not valid JSON/
  );
});

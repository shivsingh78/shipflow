import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(projectPath) {
  const packageJsonPath = path.join(
    projectPath,
    "package.json"
  );

  const content = await fs.readFile(
    packageJsonPath,
    "utf-8"
  );

  return JSON.parse(content);
}

async function detectPackageManager(projectPath, packageJson) {
  // 1. Explicit packageManager field
  if (packageJson.packageManager) {
    if (packageJson.packageManager.startsWith("pnpm@")) {
      return "pnpm";
    }

    if (packageJson.packageManager.startsWith("npm@")) {
      return "npm";
    }

    if (packageJson.packageManager.startsWith("yarn@")) {
      return "yarn";
    }
  }

  // 2. Lockfile detection
  if (
    await fileExists(
      path.join(projectPath, "pnpm-lock.yaml")
    )
  ) {
    return "pnpm";
  }

  if (
    await fileExists(
      path.join(projectPath, "package-lock.json")
    )
  ) {
    return "npm";
  }

  if (
    await fileExists(
      path.join(projectPath, "yarn.lock")
    )
  ) {
    return "yarn";
  }

  throw new Error(
    "Unable to detect package manager"
  );
}

export async function testRelease({
  releaseId,
  workspacePath,
}) {
  console.log(`Testing release ${releaseId}`);
  console.log(`Workspace: ${workspacePath}`);

  const packageJson =
    await readPackageJson(workspacePath);

  const testScript = packageJson.scripts?.test;

  if (!testScript) {
    throw new Error(
      "No test script found in package.json"
    );
  }

  const packageManager =
    await detectPackageManager(
      workspacePath,
      packageJson
    );

  console.log(
    `Package manager: ${packageManager}`
  );

  console.log(
    `Test script: ${testScript}`
  );

  const env = {
    ...process.env,
    CI: "true",
  };

  if (packageManager === "pnpm") {
    await execFileAsync(
      "pnpm",
      ["test"],
      {
        cwd: workspacePath,
        env,
      }
    );
  }

  if (packageManager === "npm") {
    await execFileAsync(
      "npm",
      ["test"],
      {
        cwd: workspacePath,
        env,
      }
    );
  }

  if (packageManager === "yarn") {
    await execFileAsync(
      "yarn",
      ["test"],
      {
        cwd: workspacePath,
        env,
      }
    );
  }

  console.log(
    `Tests completed for ${releaseId}`
  );

  return {
    releaseId,
    workspacePath,
  };
}
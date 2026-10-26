import fs from "fs/promises";
import path from "path";

export interface PackageJson {
  packageManager?: string;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export type PackageManagerName = "npm" | "pnpm" | "yarn";

export interface PackageManagerInfo {
  name: PackageManagerName;
  hasLockfile: boolean;
  yarnBerry: boolean;
}

export type TestScriptStatus = "MISSING" | "PLACEHOLDER" | "PRESENT";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readPackageJson(projectPath: string): Promise<PackageJson> {
  const packageJsonPath = path.join(projectPath, "package.json");

  let content: string;

  try {
    content = await fs.readFile(packageJsonPath, "utf-8");
  } catch {
    throw new Error("No package.json found in repository root");
  }

  try {
    return JSON.parse(content) as PackageJson;
  } catch {
    throw new Error("package.json is not valid JSON");
  }
}

/**
 * Detect the package manager and whether a lockfile allows a
 * reproducible install.
 */
export async function detectPackageManager(
  projectPath: string,
  packageJson: PackageJson
): Promise<PackageManagerInfo> {
  const has = (file: string) => fileExists(path.join(projectPath, file));

  const declared = packageJson.packageManager?.split("@")[0];
  const lockfiles = {
    pnpm: await has("pnpm-lock.yaml"),
    npm: await has("package-lock.json"),
    yarn: await has("yarn.lock"),
  };

  let name: PackageManagerName;

  if (declared === "npm" || declared === "pnpm" || declared === "yarn") {
    name = declared;
  } else {
    name =
      (lockfiles.pnpm && "pnpm") ||
      (lockfiles.npm && "npm") ||
      (lockfiles.yarn && "yarn") ||
      "npm";
  }

  const yarnBerry =
    name === "yarn" &&
    (await has(".yarnrc.yml") ||
      /^yarn@[2-9]/.test(packageJson.packageManager || ""));

  return {
    name,
    hasLockfile: lockfiles[name],
    yarnBerry,
  };
}

/**
 * Commands are argv arrays (never shell strings). pnpm and yarn run
 * through corepack so the version pinned in package.json is honoured.
 */
export function installCommand({
  name,
  hasLockfile,
  yarnBerry,
}: PackageManagerInfo): string[] {
  // pnpm and Yarn Berry default to a frozen lockfile when CI=true,
  // so a missing lockfile has to be allowed explicitly.
  if (name === "pnpm") {
    return hasLockfile
      ? ["corepack", "pnpm", "install", "--frozen-lockfile"]
      : ["corepack", "pnpm", "install", "--no-frozen-lockfile"];
  }

  if (name === "yarn") {
    if (!hasLockfile) {
      return yarnBerry
        ? ["corepack", "yarn", "install", "--no-immutable"]
        : ["corepack", "yarn", "install"];
    }

    return yarnBerry
      ? ["corepack", "yarn", "install", "--immutable"]
      : ["corepack", "yarn", "install", "--frozen-lockfile"];
  }

  return hasLockfile
    ? ["npm", "ci", "--no-audit", "--no-fund"]
    : ["npm", "install", "--no-audit", "--no-fund"];
}

export function runScriptCommand(
  { name }: Pick<PackageManagerInfo, "name">,
  script: string
): string[] {
  if (name === "pnpm") {
    return ["corepack", "pnpm", "run", script];
  }

  if (name === "yarn") {
    return ["corepack", "yarn", "run", script];
  }

  return ["npm", "run", script];
}

const NPM_PLACEHOLDER_TEST = /no test specified/i;

/**
 * Classify the test script so a missing or placeholder test is never
 * reported as a passing test run.
 */
export function classifyTestScript(packageJson: PackageJson): TestScriptStatus {
  const script = packageJson.scripts?.test;

  if (!script || !script.trim()) {
    return "MISSING";
  }

  if (NPM_PLACEHOLDER_TEST.test(script)) {
    return "PLACEHOLDER";
  }

  return "PRESENT";
}

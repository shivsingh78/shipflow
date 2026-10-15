import { config } from "./config.js";
import {
  readPackageJson,
  detectPackageManager,
  installCommand,
  runScriptCommand,
} from "./packageManager.js";

export const DEFAULT_BUILD = {
  install: "auto",
  command: "auto",
  output: "auto",
  test: "auto",
  env: {},
};

/**
 * Install dependencies (registry access only, through the egress proxy when
 * configured) and run the build (no network) inside the release sandbox.
 *
 * buildConfig comes from the project's validated configuration:
 *   install: "auto" (detect npm/pnpm/yarn from the lockfile) | "none"
 *   command: "auto" (the package.json "build" script) | a shell command run
 *            inside the sandbox with `sh -c`
 */
export async function buildRelease({
  releaseId,
  workspacePath,
  sandbox,
  buildConfig = DEFAULT_BUILD,
  log = async () => {},
}) {
  const needsPackageJson = buildConfig.install !== "none" || buildConfig.command === "auto";
  const packageJson = needsPackageJson
    ? await readPackageJson(workspacePath)
    : await readPackageJson(workspacePath).catch(() => ({}));

  if (buildConfig.command === "auto" && !packageJson.scripts?.build) {
    throw new Error(
      'No "build" script found in package.json; add one or set build.command in shipflow.yml'
    );
  }

  const packageManager = await detectPackageManager(workspacePath, packageJson);

  await log(`Sandbox: ${sandbox.kind}`);

  if (buildConfig.install === "none") {
    await log("Dependency install skipped (build.install: none)");
  } else {
    await log(
      `Package manager: ${packageManager.name} ` +
        (packageManager.hasLockfile
          ? "(lockfile found, reproducible install)"
          : "(no lockfile, install is not reproducible)")
    );

    const install = await sandbox.exec(
      "Dependency install",
      installCommand(packageManager),
      { timeoutMs: config.installTimeoutMs }
    );

    await log(`Dependency install output:\n${install.output}`);
  }

  // Repository code gets no network access after dependencies are installed.
  await sandbox.disableNetwork();

  const command =
    buildConfig.command === "auto"
      ? runScriptCommand(packageManager, "build")
      : ["sh", "-c", buildConfig.command];

  await log(
    `Build command: ${buildConfig.command === "auto" ? packageJson.scripts.build : buildConfig.command}`
  );

  const build = await sandbox.exec("Build", command, {
    timeoutMs: config.buildTimeoutMs,
  });

  await log(`Build output:\n${build.output}`);

  return {
    releaseId,
    workspacePath,
    packageJson,
    packageManager,
  };
}

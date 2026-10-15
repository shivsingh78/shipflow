import { config } from "./config.js";
import {
  readPackageJson,
  detectPackageManager,
  installCommand,
  runScriptCommand,
} from "./packageManager.js";

/**
 * Install dependencies (with network) and run the build script (without
 * network) inside the release sandbox.
 */
export async function buildRelease({
  releaseId,
  workspacePath,
  sandbox,
  log = async () => {},
}) {
  const packageJson = await readPackageJson(workspacePath);

  if (!packageJson.scripts?.build) {
    throw new Error(
      'No "build" script found in package.json; ShipFlow needs one that writes the site to dist/'
    );
  }

  const packageManager = await detectPackageManager(
    workspacePath,
    packageJson
  );

  await log(
    `Package manager: ${packageManager.name} ` +
      (packageManager.hasLockfile
        ? "(lockfile found, reproducible install)"
        : "(no lockfile, install is not reproducible)")
  );

  await log(`Build script: ${packageJson.scripts.build}`);
  await log(`Sandbox: ${sandbox.kind}`);

  const install = await sandbox.exec(
    "Dependency install",
    installCommand(packageManager),
    { timeoutMs: config.installTimeoutMs }
  );

  await log(`Dependency install output:\n${install.output}`);

  // Repository code gets no network access after dependencies are installed.
  await sandbox.disableNetwork();

  const build = await sandbox.exec(
    "Build",
    runScriptCommand(packageManager, "build"),
    { timeoutMs: config.buildTimeoutMs }
  );

  await log(`Build output:\n${build.output}`);

  return {
    releaseId,
    workspacePath,
    packageJson,
    packageManager,
  };
}

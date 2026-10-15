import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Environment for repository-controlled commands when they run directly on
 * the worker (SHIPFLOW_SANDBOX=none). Never inherits all of process.env,
 * so AWS, database, Redis and API secrets are not passed to builds.
 */
export async function createBuildEnvironment(releaseId) {
  const safeId = String(releaseId).replace(
    /[^a-zA-Z0-9_-]/g,
    "_"
  );

  const buildRoot = path.join(
    os.tmpdir(),
    "shipflow-builds",
    safeId
  );

  // Start with a clean, per-release home and temp directory.
  await fs.rm(buildRoot, {
    recursive: true,
    force: true,
  });

  const homeDir = path.join(buildRoot, "home");
  const tempDir = path.join(buildRoot, "tmp");

  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  // Explicit allowlist: never inherit all of process.env.
  const env = {
    PATH:
      process.env.PATH ||
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: homeDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
    CI: "true",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    npm_config_update_notifier: "false",
  };

  // Keep harmless platform/locale settings when present.
  for (const key of [
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "ComSpec",
  ]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  return env;
}

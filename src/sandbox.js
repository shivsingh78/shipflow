import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

import { config } from "./config.js";
import { createBuildEnvironment } from "./buildEnv.js";
import { runCommand, runCommandOrThrow } from "./runCommand.js";

const DOCKER = process.env.SHIPFLOW_DOCKER_BIN || "docker";
// Scoped per ShipFlow instance so one stack never removes another's sandboxes.
const SANDBOX_LABEL = `shipflow.sandbox=${
  process.env.SHIPFLOW_INSTANCE || "shipflow"
}`;
const CONTAINER_APP_DIR = "/home/node/app";
const SANDBOX_UID = 1000;

/**
 * Repository-controlled commands (install, build, test) only ever run
 * through a sandbox.
 *
 * - "docker": a throwaway container with no ShipFlow environment variables,
 *   no host mounts, no Docker socket, dropped capabilities, resource limits,
 *   a non-root user, and network access only during dependency install.
 * - "none": runs on the worker with an allowlisted environment.
 *   Local development only: the code can still read worker files.
 */
export async function createSandbox({ releaseId, workspacePath, buildEnv = {} }) {
  if (config.sandbox === "docker") {
    return createDockerSandbox({ releaseId, workspacePath, buildEnv });
  }

  if (config.sandbox === "none") {
    return createLocalSandbox({ releaseId, workspacePath, buildEnv });
  }

  throw new Error(
    `Unknown SHIPFLOW_SANDBOX "${config.sandbox}" (use "docker" or "none")`
  );
}

async function chownRecursive(target, uid, gid) {
  await fs.lchown(target, uid, gid);

  const stat = await fs.lstat(target);

  if (!stat.isDirectory()) {
    return;
  }

  for (const entry of await fs.readdir(target)) {
    await chownRecursive(path.join(target, entry), uid, gid);
  }
}

async function docker(label, args, timeoutMs = 120_000) {
  return runCommandOrThrow(label, DOCKER, args, { timeoutMs });
}

/**
 * Variables that route package-manager traffic through the egress proxy.
 * They contain no secrets.
 */
export function proxyEnvironment(proxyUrl) {
  if (!proxyUrl) {
    return [];
  }

  return [
    ...[
      "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy",
      "npm_config_https_proxy", "npm_config_proxy",
      "YARN_HTTPS_PROXY", "YARN_HTTP_PROXY",
    ].map((name) => `${name}=${proxyUrl}`),
    // Node's built-in fetch (used by Corepack to download pnpm/yarn)
    // only honours the variables above when this is set (Node >= 22.21).
    "NODE_USE_ENV_PROXY=1",
  ];
}

async function createDockerSandbox({ releaseId, workspacePath, buildEnv = {} }) {
  const name = `shipflow-build-${releaseId.toLowerCase()}-${crypto
    .randomBytes(3)
    .toString("hex")}`;

  // Image pulls can take a while on the first build.
  await docker(
    "Creating build sandbox",
    [
      "create",
      "--name", name,
      "--label", SANDBOX_LABEL,
      "--label", `shipflow.release=${releaseId}`,
      "--user", `${SANDBOX_UID}:${SANDBOX_UID}`,
      "--workdir", "/home/node",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", config.sandboxMemory,
      "--memory-swap", config.sandboxMemory,
      "--cpus", config.sandboxCpus,
      "--pids-limit", String(config.sandboxPidsLimit),
      "--network", config.sandboxNetwork,
      "--add-host", "host.docker.internal:127.0.0.1",
      "--init",
      "-e", "CI=true",
      "-e", "HOME=/home/node",
      "-e", "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
      "-e", "npm_config_update_notifier=false",
      ...proxyEnvironment(config.egressProxy).flatMap((pair) => ["-e", pair]),
      ...Object.entries(buildEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      config.sandboxImage,
      "tail", "-f", "/dev/null",
    ],
    300_000
  );

  const destroy = async () => {
    await runCommand(DOCKER, ["rm", "-f", name], { timeoutMs: 60_000 });
  };

  try {
    // The sandbox user must own the files it builds.
    if (process.getuid?.() === 0) {
      await chownRecursive(workspacePath, SANDBOX_UID, SANDBOX_UID);
    }

    await docker("Copying source into sandbox", [
      "cp", "-a", `${workspacePath}/.`, `${name}:${CONTAINER_APP_DIR}`,
    ]);

    await docker("Starting build sandbox", ["start", name]);
  } catch (error) {
    await destroy();
    throw error;
  }

  return {
    kind: "docker",
    name,

    async exec(label, argv, { timeoutMs }) {
      return runCommandOrThrow(
        label,
        DOCKER,
        ["exec", "-w", CONTAINER_APP_DIR, name, ...argv],
        {
          timeoutMs,
          // A killed `docker exec` client does not stop the process
          // inside the container, so remove the whole sandbox.
          onTimeout: destroy,
        }
      );
    },

    async disableNetwork() {
      await docker("Disconnecting sandbox network", [
        "network", "disconnect", config.sandboxNetwork, name,
      ]);
    },

    /**
     * Copy a directory out of the sandbox. Returns false if it does not exist.
     * Everything copied comes from the container's own filesystem, so symlinks
     * cannot pull in worker files here; they are skipped at upload time.
     */
    async copyOut(relativeDir, destination) {
      const result = await runCommand(
        DOCKER,
        ["cp", `${name}:${CONTAINER_APP_DIR}/${relativeDir}/.`, destination],
        { timeoutMs: 300_000 }
      );

      return result.exitCode === 0;
    },

    destroy,
  };
}

async function createLocalSandbox({ releaseId, workspacePath, buildEnv = {} }) {
  console.warn(
    `[sandbox] SHIPFLOW_SANDBOX=none: release ${releaseId} runs WITHOUT isolation. ` +
      "Use only with trusted repositories in local development."
  );

  const env = { ...(await createBuildEnvironment(releaseId)), ...buildEnv };

  return {
    kind: "none",

    async exec(label, [command, ...args], { timeoutMs }) {
      return runCommandOrThrow(label, command, args, {
        cwd: workspacePath,
        env,
        timeoutMs,
      });
    },

    async disableNetwork() {
      // Not possible without a container; documented limitation.
    },

    async copyOut(relativeDir, destination) {
      const source = path.join(workspacePath, relativeDir);

      try {
        const stat = await fs.lstat(source);

        if (!stat.isDirectory()) {
          return false;
        }
      } catch {
        return false;
      }

      await fs.cp(source, destination, {
        recursive: true,
        verbatimSymlinks: true,
      });

      return true;
    },

    async destroy() {
      await fs.rm(path.dirname(env.HOME), { recursive: true, force: true });
    },
  };
}

/**
 * Remove sandboxes left behind by a worker that crashed mid-build.
 */
export async function removeOrphanedSandboxes() {
  if (config.sandbox !== "docker") {
    return;
  }

  const list = await runCommand(
    DOCKER,
    ["ps", "-aq", "--filter", `label=${SANDBOX_LABEL}`],
    { timeoutMs: 30_000 }
  );

  if (list.exitCode !== 0) {
    throw new Error(
      `Docker is not available to the worker: ${list.output.trim()}`
    );
  }

  const ids = list.output.split(/\s+/).filter(Boolean);

  if (ids.length > 0) {
    await runCommand(DOCKER, ["rm", "-f", ...ids], { timeoutMs: 60_000 });
    console.log(`Removed ${ids.length} orphaned build sandbox(es)`);
  }
}

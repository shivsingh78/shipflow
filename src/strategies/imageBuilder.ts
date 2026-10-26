// Builds a container image from a prepared repository and exports it as a
// `docker save` archive. Used by the node and dockerfile strategies.
//
// Security: this runs repository-controlled Dockerfile RUN steps through the
// worker's Docker daemon. BuildKit cannot attach to the build sandbox's
// restricted network, so this is weaker isolation than the sandbox. It is
// therefore opt-in (SHIPFLOW_IMAGE_BUILDS=enabled). No build args, environment
// or secrets are ever passed to `docker build`.
import fs from "fs/promises";
import path from "path";

import { config } from "../config.js";
import { archiveConfigDigest } from "./archive.js";
import { isImageDigest } from "../artifacts.js";
import { runCommandOrThrow } from "../runCommand.js";
import type { CommandResult, RunCommandOptions } from "../runCommand.js";
import type { ReleaseLog } from "../build.js";

const DOCKER = process.env.SHIPFLOW_DOCKER_BIN || "docker";

export type RunDocker = (
  label: string,
  command: string,
  args: string[],
  options?: RunCommandOptions
) => Promise<CommandResult>;

export interface BuildImageInput {
  releaseId: string;
  /** Docker build context directory. */
  contextDir: string;
  /** Absolute path of the Dockerfile. */
  dockerfilePath: string;
  port: number;
  scratchDir: string;
  log: ReleaseLog;
  /** Injectable for tests; defaults to runCommandOrThrow. */
  run?: RunDocker;
}

export interface BuiltImage {
  archivePath: string;
  digest: string;
  sizeBytes: number;
  port: number;
}

/** Error naming the opt-in flag and the isolation caveat. */
export function assertImageBuildsEnabled(enabled: boolean = config.imageBuilds): void {
  if (!enabled) {
    throw new Error(
      "Container image builds are disabled on this worker. Set SHIPFLOW_IMAGE_BUILDS=enabled to allow them. " +
        "Caveat: image builds run repository-controlled Dockerfile RUN steps through the host Docker daemon " +
        "(BuildKit cannot attach to the sandbox's restricted network), which isolates less than the build sandbox; " +
        "enable this only for repositories you trust."
    );
  }
}

/** Docker repository names must be lowercase [a-z0-9._-]. */
export function candidateTag(releaseId: string): string {
  const safe = releaseId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "") || "release";
  return `shipflow-build/${safe}:candidate`;
}

export async function buildImage(input: BuildImageInput): Promise<BuiltImage> {
  const { releaseId, contextDir, dockerfilePath, port, scratchDir, log } = input;
  const run = input.run ?? runCommandOrThrow;

  assertImageBuildsEnabled();

  const tag = candidateTag(releaseId);
  const archivePath = path.join(scratchDir, "image.tar");

  try {
    // Base images are pulled only when missing locally (no --pull), so builds
    // work offline once a base image is cached; --no-cache is not used so
    // dependency layers are reused between releases.
    const build = await run(
      "Image build",
      DOCKER,
      [
        "build",
        "--progress=plain",
        "--label", `shipflow.release=${releaseId}`,
        "-t", tag,
        "-f", dockerfilePath,
        contextDir,
      ],
      { timeoutMs: config.imageBuildTimeoutMs, maxOutputBytes: 256 * 1024 }
    );

    await log(`Image build output:\n${build.output}`);

    const inspect = await run(
      "Image inspect",
      DOCKER,
      ["image", "inspect", "--format", "{{.Id}}", tag],
      { timeoutMs: 60_000 }
    );
    const inspectedDigest = inspect.output.trim();

    if (!isImageDigest(inspectedDigest)) {
      throw new Error(`Image build produced an unexpected image ID: ${inspectedDigest.slice(0, 100)}`);
    }

    await run("Image export", DOCKER, ["save", "-o", archivePath, tag], {
      timeoutMs: config.imageBuildTimeoutMs,
    });

    const sizeBytes = (await fs.stat(archivePath)).size;

    if (sizeBytes > config.maxImageBytes) {
      throw new Error(`Image archive is ${sizeBytes} bytes; the limit is ${config.maxImageBytes} (SHIPFLOW_MAX_IMAGE_BYTES)`);
    }

    // Identity = digest of the image config inside the archive: the ID every
    // Docker host reports after `docker load`. `docker image inspect` on this
    // host can differ (containerd image store reports the index digest).
    const digest = (await archiveConfigDigest(archivePath)) ?? inspectedDigest;

    await log(`Image built: ${digest} (${sizeBytes} bytes)`);

    return { archivePath, digest, sizeBytes, port };
  } catch (error) {
    await fs.rm(archivePath, { force: true });
    throw error;
  } finally {
    // The image lives on only as the archive; never leave candidates behind.
    try {
      await run("Image cleanup", DOCKER, ["rmi", "--force", tag], { timeoutMs: 60_000 });
    } catch (cleanupError) {
      await log(
        `Could not remove local image ${tag}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        "WARN"
      );
    }
  }
}

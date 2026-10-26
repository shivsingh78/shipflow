import fs from "fs/promises";
import path from "path";

import { buildImage, assertImageBuildsEnabled } from "./imageBuilder.js";
import type { RunDocker } from "./imageBuilder.js";
import type { BuildStrategy, LocalArtifact, StrategyInput } from "./types.js";

export const DEFAULT_DOCKERFILE = "Dockerfile";

/**
 * Absolute, symlink-resolved path of the repository's Dockerfile. Rejects
 * absolute paths, `..` segments and anything resolving outside the workspace.
 */
export async function resolveDockerfile(workspacePath: string, relative: string = DEFAULT_DOCKERFILE): Promise<string> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error(`build.dockerfile "${relative}" must be a relative path inside the repository`);
  }

  const root = await fs.realpath(workspacePath);
  const candidate = path.join(root, relative);
  let resolved: string;

  try {
    resolved = await fs.realpath(candidate);
  } catch {
    throw new Error(`Dockerfile not found at "${relative}" in the repository`);
  }

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Dockerfile "${relative}" resolves outside the repository`);
  }

  if (!(await fs.stat(resolved)).isFile()) {
    throw new Error(`Dockerfile "${relative}" is not a file`);
  }

  return resolved;
}

/** For tests: swap the docker runner. Not part of the pipeline contract. */
export interface DockerfileStrategyOptions {
  run?: RunDocker;
}

export function createDockerfileStrategy(options: DockerfileStrategyOptions = {}): BuildStrategy {
  return {
    id: "dockerfile",
    artifactType: "image",
    usesSandbox: false,

    async build(input: StrategyInput) {
      const relative = input.build.dockerfile ?? DEFAULT_DOCKERFILE;
      const dockerfilePath = await resolveDockerfile(input.workspacePath, relative);

      await input.log(`Dockerfile: ${relative}`);
      return { dockerfilePath };
    },

    async test(input) {
      await input.log(
        "Tests SKIPPED: repository Dockerfiles are not executed in pull-request checks; " +
          "run tests in the repository's own CI job",
        "WARN"
      );

      return { testStatus: "SKIPPED" };
    },

    async produce(input, _sandbox, built): Promise<LocalArtifact> {
      assertImageBuildsEnabled();

      if (!input.runtime) {
        throw new Error("runtime.port is required to build a container image");
      }

      const { dockerfilePath } = built as { dockerfilePath: string };
      const image = await buildImage({
        releaseId: input.releaseId,
        contextDir: input.workspacePath,
        dockerfilePath,
        port: input.runtime.port,
        scratchDir: input.scratchDir,
        log: input.log,
        ...(options.run ? { run: options.run } : {}),
      });

      return { type: "image", ...image };
    },
  };
}

export const dockerfileStrategy: BuildStrategy = createDockerfileStrategy();

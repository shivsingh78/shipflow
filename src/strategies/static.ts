import path from "path";

import { buildRelease } from "../build.js";
import { testRelease } from "../test.js";
import { collectBuildOutput, validateArtifact } from "../deploy.js";
import type { BuildStrategy, LocalArtifact, StrategyInput } from "./types.js";
import type { SandboxHandle } from "../sandbox.js";

type Built = Awaited<ReturnType<typeof buildRelease>>;

function requireSandbox(sandbox: SandboxHandle | null): SandboxHandle {
  if (!sandbox) {
    throw new Error("The static strategy requires a build sandbox");
  }

  return sandbox;
}

/** Existing behaviour: build in the sandbox, deploy the output directory as files. */
export const staticStrategy: BuildStrategy = {
  id: "static",
  artifactType: "static",
  usesSandbox: true,

  build(input: StrategyInput, sandbox: SandboxHandle | null): Promise<Built> {
    return buildRelease({
      releaseId: input.releaseId,
      workspacePath: input.workspacePath,
      sandbox: requireSandbox(sandbox),
      buildConfig: input.build,
      log: input.log,
    });
  },

  async test(input, sandbox, built) {
    const { packageJson, packageManager } = built as Built;
    const result = await testRelease({
      releaseId: input.releaseId,
      workspacePath: input.workspacePath,
      sandbox: requireSandbox(sandbox),
      packageJson,
      packageManager,
      testConfig: input.build.test,
      log: input.log,
    });

    return { testStatus: result.testStatus };
  },

  async produce(input, sandbox): Promise<LocalArtifact> {
    const directory = path.join(input.scratchDir, "artifact");
    const outputDirectory = await collectBuildOutput({
      sandbox: requireSandbox(sandbox),
      destination: directory,
      output: input.build.output,
    });
    const validated = await validateArtifact(directory);

    return { type: "static", directory, outputDirectory, ...validated };
  },
};

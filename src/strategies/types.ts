// Build strategies turn a prepared repository into an artifact. A strategy
// only knows how to build; where the result runs is a deployment target's
// concern (see src/targets), and the pairing is checked by the pipeline
// through ArtifactType (src/artifacts.ts).
import type { BuildConfig, RuntimeConfig } from "../../cli/lib/projectConfig.js";
import type { ArtifactType, Artifact } from "../artifacts.js";
import type { ReleaseLog } from "../build.js";
import type { ArtifactStore } from "../artifactStore.js";

export type StrategyId = "static" | "node" | "dockerfile";

export interface StrategyInput {
  releaseId: string;
  /** Checked-out repository. */
  workspacePath: string;
  build: BuildConfig;
  runtime: RuntimeConfig | null;
  /** The release's scratch directory (removed after the pipeline). */
  scratchDir: string;
  store: ArtifactStore;
  log: ReleaseLog;
}

/** Result of detection: which strategy builds this repository, and why. */
import type { SandboxHandle } from "../sandbox.js";
import type { TestStatus } from "../test.js";

/** An artifact on the worker's disk, not yet stored. */
export type LocalArtifact =
  | {
      type: "static";
      /** Directory with the files. */
      directory: string;
      files: string[];
      totalBytes: number;
      skippedSymlinks: number;
      /** Where in the repository the output came from (for logs). */
      outputDirectory: string;
    }
  | {
      type: "image";
      /** `docker save` archive. */
      archivePath: string;
      /** Image ID: "sha256:" + 64 hex. */
      digest: string;
      sizeBytes: number;
      port: number;
    };

/**
 * One way of building a repository. The pipeline calls build → test (both
 * also run for pull-request checks), then, for deployments only, produce.
 * `produce` runs after the sandbox is destroyed and never receives secrets.
 */
export interface BuildStrategy {
  id: StrategyId;
  artifactType: ArtifactType;
  /** The pipeline creates the release sandbox and passes it to every step. */
  usesSandbox: boolean;
  build(input: StrategyInput, sandbox: SandboxHandle | null): Promise<unknown>;
  test(input: StrategyInput, sandbox: SandboxHandle | null, built: unknown): Promise<{ testStatus: TestStatus }>;
  produce(input: StrategyInput, sandbox: SandboxHandle | null, built: unknown): Promise<LocalArtifact>;
}

export interface Detection {
  strategy: StrategyId;
  /** Human-readable reason, logged and shown in evidence. */
  reason: string;
}

export class DetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetectionError";
  }
}

export type { ArtifactType, Artifact };

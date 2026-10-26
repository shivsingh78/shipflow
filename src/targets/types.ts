// Types shared by the deployment-target adapters (see ./index.ts for the
// description of the adapter interface) and the pipeline that drives them.
import type { Artifact, ArtifactType } from "../artifacts.js";
import type { DockerTarget, KubernetesTarget, RuntimeConfig } from "../../cli/lib/projectConfig.js";

export interface Verification {
  path: string;
  expectStatus: number;
}

/** Settings of the "shipflow" target (deployment.shipflow). */
export interface ShipflowTargetConfig {
  hostname?: string;
}

/** Settings of the "ssh" target (deployment.ssh). */
export interface SshTargetConfig {
  host: string;
  port: number;
  user: string;
  path: string;
  hostKey: string;
  privateKeySecret: string;
  url: string;
}

export type DockerTargetConfig = DockerTarget;
export type KubernetesTargetConfig = KubernetesTarget;

export type TargetConfig =
  | ShipflowTargetConfig
  | SshTargetConfig
  | DockerTargetConfig
  | KubernetesTargetConfig;

/** Secret values resolved for a deployment, keyed by secret name. */
export type TargetSecrets = Record<string, string>;

export type TargetLog = (message: string, level?: string) => unknown;

export interface TargetContext<C extends TargetConfig = TargetConfig> {
  project: string;
  releaseId: string;
  targetConfig: C;
  verification: Verification;
  secrets: TargetSecrets;
  /** What is being deployed; null only for diagnostics outside a release. */
  artifact: Artifact | null;
  /** Runtime settings of image artifacts (null for static artifacts). */
  runtime: RuntimeConfig | null;
  /** Local copy of a static artifact's files (downloaded again after a rollback). */
  ensureArtifactDir(): Promise<string>;
  /** Local path of an image artifact's `docker save` archive (downloaded again after a rollback). */
  ensureImageArchive(): Promise<string>;
  log: TargetLog;
}

export type CandidateVerification = "http" | "checksum" | "none";

export interface TargetCapabilities {
  /** Artifact types this target can run. */
  artifactTypes: ArtifactType[];
  candidateVerification: CandidateVerification;
  /** The switch is a single atomic operation. */
  atomicActivation: boolean;
  /** Can re-activate an earlier release. */
  rollback: boolean;
}

export interface TargetCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TargetDetail {
  detail: string;
}

export interface TargetLiveResult extends TargetDetail {
  url: string;
}

// Methods are declared with method syntax so that an adapter for one target
// configuration shape can be stored in a registry of all targets.
export interface DeploymentTarget<C extends TargetConfig = TargetConfig> {
  name: string;
  description: string;
  capabilities: TargetCapabilities;
  /** Names, never values. */
  requiredSecrets(targetConfig: C): string[];
  /** Diagnostics. */
  check(ctx: TargetContext<C>): Promise<TargetCheck[]>;
  /** Put the candidate in place, not live. */
  prepare(ctx: TargetContext<C>): Promise<TargetDetail>;
  /** Prove the candidate is intact. */
  verifyCandidate(ctx: TargetContext<C>): Promise<TargetDetail>;
  /** Make ctx.releaseId live (called while the project's activation lock is held). */
  activate(ctx: TargetContext<C>): Promise<void>;
  /** Stop serving ctx.releaseId when there is no earlier release to switch back to. */
  deactivate(ctx: TargetContext<C>): Promise<void>;
  verifyLive(ctx: TargetContext<C>): Promise<TargetLiveResult>;
  liveUrl(ctx: Pick<TargetContext<C>, "targetConfig">): string | null;
}

export interface TargetSummary {
  name: string;
  description: string;
  capabilities: TargetCapabilities;
}

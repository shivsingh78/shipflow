// Shapes returned by the ShipFlow API (see src/app.ts). Timestamps are ISO strings.
import type { ProjectConfig } from "@/lib/projectConfig";

export type ReleaseStatus = "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
export type ReleaseStage = "RELEASE" | "PREPARE" | "BUILD" | "TEST" | "DEPLOY" | "VERIFY" | "ACTIVATE";
export type ReleaseMode = "deploy" | "check";

/** Pipeline stages in the order they run (RELEASE is the queued placeholder). */
export const STAGES: ReleaseStage[] = ["PREPARE", "BUILD", "TEST", "DEPLOY", "VERIFY", "ACTIVATE"];

export interface StaticArtifact {
  type: "static";
  path: string;
  fileCount: number;
}

export interface ImageArtifact {
  type: "image";
  key: string;
  /** Image ID (sha256:...). The immutable identity of the built image. */
  digest: string;
  sizeBytes: number;
  port: number;
}

export type Artifact = StaticArtifact | ImageArtifact;

export interface Release {
  id: number;
  release_id: string;
  repo_url: string;
  status: ReleaseStatus;
  current_stage: ReleaseStage;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  deployment_url: string | null;
  artifact_path: string | null;
  public_deployment_url: string | null;
  commit_sha: string | null;
  test_status: "PASSED" | "SKIPPED" | null;
  project: string;
  mode: ReleaseMode;
  ref: string | null;
  trigger: string;
  target: string;
  config: ProjectConfig | null;
  cancel_requested: boolean;
  artifacts_pruned: boolean;
  artifact_type: "static" | "image";
  artifact: Artifact | null;
  build_strategy: string | null;
  deployment: Record<string, unknown> | null;
  /** Added by the API: this release is the project's live one. */
  is_active: boolean;
}

export interface ReleaseList {
  /** Only meaningful when filtering by project. */
  activeReleaseId: string | null;
  releases: Release[];
}

export interface ProjectSummary {
  name: string;
  repo_url: string;
  target: string;
  hostname: string | null;
  created_at: string;
  updated_at: string;
}

export interface Project extends ProjectSummary {
  config: ProjectConfig;
}

export interface SecretInfo {
  /** Names only: values are never returned by the API. */
  name: string;
  updated_at: string;
}

export interface ProjectDetail {
  project: Project;
  activeReleaseId: string | null;
  secrets: SecretInfo[];
}

export interface SaveProjectResult {
  project: Project;
  requiredSecrets: string[];
  missingSecrets: string[];
}

export interface TargetCapabilities {
  artifactTypes: Array<"static" | "image">;
  candidateVerification: string;
  atomicActivation: boolean;
  rollback: boolean;
  verifyAfterRevert?: boolean;
}

export interface TargetInfo {
  name: string;
  description: string;
  capabilities: TargetCapabilities;
}

export interface WhoAmI {
  instance: string;
  targets: TargetInfo[];
  artifactStore: string | null;
  secretsEnabled: boolean;
  githubWebhooks: boolean;
  allowedRepoPrefixes: string[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: unknown;
}

export interface Readiness {
  ok: boolean;
  checks: CheckResult[];
}

export interface ReleaseLogRow {
  id: number;
  release_id: string;
  stage: string;
  /** INFO, WARN or ERROR. */
  level: string;
  message: string;
  created_at: string;
}

export interface NotificationRow {
  id: number;
  release_id: string;
  type: string;
  message: string;
  created_at: string;
}

export interface ReleaseLogs {
  release: Pick<Release, "release_id" | "project" | "status" | "current_stage">;
  logs: ReleaseLogRow[];
  notifications: NotificationRow[];
}

export interface Evidence {
  releaseId: string;
  project: string;
  mode: string;
  status: string;
  stage: string;
  commitSha: string | null;
  ref: string | null;
  trigger: string;
  target: string;
  buildStrategy: string | null;
  artifact:
    | { type: "static"; path: string }
    | { type: "image"; digest: string; sizeBytes: number; port: number }
    | null;
  testStatus: string | null;
  createdAt: string;
  updatedAt: string;
  timeline: Array<{ stage: string; startedAt: string | null; lastAt: string | null; errors: number; warnings: number }>;
  failure: { stage: string; message: string } | null;
  diagnosis: { category: string; summary: string; suggestions: string[] } | null;
}

export interface CancelResult {
  status: "CANCELLED" | "CANCEL_REQUESTED";
  message?: string;
}

export interface RollbackResult {
  project: string;
  targetReleaseId: string;
  previousReleaseId: string | null;
  artifactPath: string;
  fileCount: number;
  target: string;
}

export interface DeployRequest {
  project: string;
  /** Branch, tag or commit; defaults to the project's configured branch. */
  ref?: string;
  /** "check" runs prepare/build/test only and never deploys. */
  mode?: ReleaseMode;
  /** Recorded on the release for display. The dashboard sends "dashboard". */
  trigger?: "dashboard" | "cli";
}

export interface ListReleasesOptions {
  project?: string;
  /** 1..200 (server-side cap). */
  limit?: number;
}

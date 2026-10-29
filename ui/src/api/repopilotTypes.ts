// Shapes returned by the RepoPilot API (see src/repopilot/routes.ts). Timestamps are ISO strings.

export type RunState =
  | "queued" | "ingesting" | "analyzing" | "awaiting_patch" | "patching" | "verifying"
  | "ready_for_review" | "pr_authorized" | "pr_opened" | "failed" | "cancelled";

export type Outcome = "improved" | "unchanged" | "regressed" | "inconclusive";

export interface RpRun {
  id: number;
  repo: { owner: string; name: string; url: string };
  requestedRef: string | null;
  commitSha: string | null;
  defaultBranch: string | null;
  state: RunState;
  failure: { code: string; detail: string | null } | null;
  cancelRequested: boolean;
  ai: { requests: number; inputTokens: number; outputTokens: number };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface RpStage {
  stage: "ingest" | "manifest" | "analyze" | "patch" | "verify" | "pr";
  attempt: number;
  state: "running" | "succeeded" | "failed" | "skipped";
  error: { code: string; detail: string | null } | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RpOutcome {
  patchId: number;
  outcome: Outcome;
  reasons: string[];
  details: unknown;
  computedAt: string;
}

export interface RpPullRequest {
  id: number;
  patchId: number;
  state: "authorized" | "creating" | "opened" | "failed";
  authorizedBy: string;
  authorizedAt: string;
  authorizedDiffSha256: string;
  authorizedOutcome: Outcome;
  baseBranch: string;
  baseSha: string;
  branch: string;
  number: number | null;
  url: string | null;
  headSha: string | null;
  error: { code: string; detail: string | null } | null;
  updatedAt: string;
}

export interface RunDetail {
  run: RpRun;
  stages: RpStage[];
  counts: { findings: number; patches: number };
  outcomes: RpOutcome[];
  pullRequest: RpPullRequest | null;
  limitations: string[];
}

export interface RpFinding {
  id: number;
  rank: number;
  title: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  evidenceKind: "observed" | "hypothesis";
  file: string;
  lineStart: number;
  lineEnd: number;
  evidence: string;
  impact: string;
  remediation: string;
  /** The model's own estimate (0-1): a suggestion, not a measurement. */
  modelConfidence: number;
}

export interface PatchIssue {
  code: string;
  message: string;
  role?: string;
  path?: string;
}

export interface RpPatch {
  id: number;
  findingId: number;
  baseCommit: string;
  title: string;
  explanation: string;
  diff: string;
  testDiff: string;
  diffSha256: string;
  policy: {
    /** Policy AND the dry-run against the pinned snapshot. Not "verified". */
    passed: boolean;
    details: { ok?: boolean; issues?: PatchIssue[]; apply?: { ok: boolean; issues: PatchIssue[] } | null };
  };
  createdAt: string;
}

export interface RpVerification {
  id: number;
  patchId: number;
  arm: "baseline" | "control" | "patched";
  attempt: number;
  kind: "exited" | "timeout" | "infra_error" | "resource_limit" | "no_test_script";
  exitCode: number | null;
  durationMs: number | null;
  detail: string | null;
  commitSha: string;
  diffSha256: string;
  testCommand: string;
  environment: unknown;
  hasLog: boolean;
  createdAt: string;
}

export interface RpLog {
  id: number;
  stage: string;
  level: string;
  message: string;
  at: string;
}

export interface RepoPilotStatus {
  enabled: boolean;
  message?: string;
  workers?: number;
  github?: { configured: boolean };
  ai?: { providers: string[]; configured: string[]; credentialEncryption: boolean; workerCanDecrypt: boolean };
  sandbox?: { mode: string; status: "off" | "ready" | "unavailable"; note: string };
  limits?: { maxActiveRuns: number; maxAiRequestsPerRun: number; maxSnapshotFiles: number };
  problems: string[];
  limitations: string[];
}

export interface RpRepository {
  owner: string;
  name: string;
  authorizedBy: string;
  authorizedAt: string;
}

export interface RpCredential {
  provider: string;
  fingerprint: string;
  updatedAt: string;
}

export interface AuthorizePullRequestInput {
  patchId: number;
  diffSha256: string;
  baseCommitSha: string;
  outcome: Outcome;
}

export interface RepoPilotApi {
  status(signal?: AbortSignal): Promise<RepoPilotStatus>;
  listRepositories(signal?: AbortSignal): Promise<RpRepository[]>;
  authorizeRepository(repoUrl: string): Promise<void>;
  revokeRepository(owner: string, name: string): Promise<void>;
  listCredentials(signal?: AbortSignal): Promise<RpCredential[]>;
  setCredential(provider: string, apiKey: string): Promise<void>;
  deleteCredential(provider: string): Promise<void>;
  listRuns(signal?: AbortSignal): Promise<RpRun[]>;
  createRun(input: { repoUrl: string; ref?: string }): Promise<RpRun>;
  getRun(runId: number, signal?: AbortSignal): Promise<RunDetail>;
  cancelRun(runId: number): Promise<void>;
  listFindings(runId: number, signal?: AbortSignal): Promise<RpFinding[]>;
  requestPatch(runId: number, findingId: number): Promise<void>;
  listPatches(runId: number, signal?: AbortSignal): Promise<RpPatch[]>;
  getVerifications(runId: number, signal?: AbortSignal): Promise<{ verifications: RpVerification[]; outcomes: RpOutcome[] }>;
  listLogs(runId: number, signal?: AbortSignal): Promise<RpLog[]>;
  authorizePullRequest(runId: number, input: AuthorizePullRequestInput): Promise<{ run: RpRun; pullRequest: RpPullRequest }>;
}

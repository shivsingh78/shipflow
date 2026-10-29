/**
 * PostgreSQL persistence for RepoPilot.
 *
 * Conventions:
 *  - Every mutation runs in one transaction that first takes a row lock on
 *    the run (`SELECT ... FOR UPDATE`), so concurrent workers serialise and
 *    "check state, then change state" cannot race.
 *  - Every meaningful mutation appends an audit event in the SAME
 *    transaction (actor + timestamp), hash-chained and append-only.
 *  - Reads are scoped by `owner`; a caller can never address another
 *    owner's run, even by guessing an id (the row simply "does not exist").
 *  - Nothing here accepts verification results from a model. Verification
 *    rows are built only from a parsed SandboxRun, and outcomes are derived
 *    from those rows by the classifier.
 *  - Secrets never enter this module: callers pass ciphertext only (see
 *    credentials), and audit/log text is scrubbed.
 */

import crypto from "crypto";
import type { Pool, PoolClient } from "pg";

import { classifyOutcome } from "./outcome.js";
import type { Outcome } from "./outcome.js";
import { STAGE_FLOW, latestAttempt, nextStageToQueue, retryDelayMs } from "./flow.js";
import type { StageRecord } from "./flow.js";
import { patchDigest, validatePatchProposal } from "./patch.js";
import type { PatchLimits, ProposalValidation } from "./patch.js";
import { redactSensitive, sanitizeForStorage } from "./redact.js";
import { AuthorizePrRequestSchema, SandboxRunSchema } from "./schemas.js";
import type { Finding, GithubRepo, PatchProposal, SandboxRun } from "./schemas.js";
import {
  MAX_STAGE_ATTEMPTS,
  assertRunTransition,
  canRetryStage,
  isTerminalRunState,
  stageIdempotencyKey,
} from "./states.js";
import type { RunState, StageName } from "./states.js";

export type Db = Pick<Pool, "query" | "connect">;
export type Tx = PoolClient;

export type RepoPilotErrorCode =
  | "not_found"
  | "conflict"
  | "quota"
  | "invalid_actor"
  | "invalid_input"
  | "authorization_mismatch";

export class RepoPilotError extends Error {
  constructor(
    readonly code: RepoPilotErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RepoPilotError";
  }
}

// ------------------------------------------------------------------- actors

/**
 * Who performed an action. "user:" principals come from the authenticated
 * API; "worker:" and "system" from ShipFlow itself. There is no model actor.
 */
const ACTOR_PATTERN = /^(?:system|user:[A-Za-z0-9._@-]{1,64}|worker:[A-Za-z0-9._:-]{1,64})$/;

export function assertActor(actor: string): void {
  if (!ACTOR_PATTERN.test(actor)) {
    throw new RepoPilotError("invalid_actor", "actor must be system, user:<id> or worker:<id>");
  }
}

const isUserActor = (actor: string): boolean => actor.startsWith("user:");

// -------------------------------------------------------------------- rows

export interface RunRow {
  id: number;
  owner: string;
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  requestedRef: string | null;
  commitSha: string | null;
  defaultBranch: string | null;
  state: RunState;
  failureCode: string | null;
  failureDetail: string | null;
  cancelRequested: boolean;
  aiRequests: number;
  aiInputTokens: number;
  aiOutputTokens: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface StageRow {
  runId: number;
  stage: StageName;
  attempt: number;
  state: "running" | "succeeded" | "failed" | "skipped";
  params: Record<string, unknown>;
  errorCode: string | null;
  errorDetail: string | null;
  startedAt: Date;
  heartbeatAt: Date;
  finishedAt: Date | null;
}

export interface FindingRow extends Finding {
  id: number;
  runId: number;
  rank: number;
  createdAt: Date;
}

export interface PatchRow {
  id: number;
  runId: number;
  findingId: number;
  baseCommit: string;
  title: string;
  explanation: string;
  diff: string;
  testDiff: string;
  diffSha256: string;
  validationOk: boolean;
  validation: unknown;
  createdAt: Date;
}

export interface VerificationRow {
  id: number;
  patchId: number;
  arm: "baseline" | "control" | "patched";
  attempt: number;
  kind: SandboxRun["kind"];
  exitCode: number | null;
  durationMs: number | null;
  detail: string | null;
  commitSha: string;
  diffSha256: string;
  testCommand: string;
  environmentProfile: unknown;
  logKey: string | null;
  createdAt: Date;
}

export interface OutcomeRow {
  patchId: number;
  outcome: Outcome;
  reasons: string[];
  arms: unknown;
  computedAt: Date;
}

export interface PullRequestRow {
  id: number;
  runId: number;
  patchId: number;
  authorizedBy: string;
  authorizedAt: Date;
  authorizedDiffSha256: string;
  authorizedOutcome: Outcome;
  baseBranch: string;
  baseSha: string;
  branchName: string;
  state: "authorized" | "creating" | "opened" | "failed";
  prNumber: number | null;
  prUrl: string | null;
  headSha: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  updatedAt: Date;
}

export interface ArtifactRow {
  id: number;
  runId: number;
  patchId: number | null;
  kind: string;
  objectKey: string;
  bytes: number;
  sha256: string;
  createdAt: Date;
}

export interface LogRow {
  id: number;
  runId: number;
  stage: string;
  level: string;
  message: string;
  createdAt: Date;
}

export interface AuditRow {
  id: number;
  runId: number | null;
  owner: string;
  actor: string;
  event: string;
  detail: unknown;
  hash: string;
  at: Date;
}

type Raw = Record<string, unknown>;

const mapRun = (r: Raw): RunRow => ({
  id: Number(r.id),
  owner: r.owner as string,
  repoOwner: r.repo_owner as string,
  repoName: r.repo_name as string,
  repoUrl: r.repo_url as string,
  requestedRef: (r.requested_ref as string | null) ?? null,
  commitSha: (r.commit_sha as string | null) ?? null,
  defaultBranch: (r.default_branch as string | null) ?? null,
  state: r.state as RunState,
  failureCode: (r.failure_code as string | null) ?? null,
  failureDetail: (r.failure_detail as string | null) ?? null,
  cancelRequested: r.cancel_requested as boolean,
  aiRequests: Number(r.ai_requests ?? 0),
  aiInputTokens: Number(r.ai_input_tokens ?? 0),
  aiOutputTokens: Number(r.ai_output_tokens ?? 0),
  createdBy: r.created_by as string,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
  finishedAt: (r.finished_at as Date | null) ?? null,
});

const mapStage = (r: Raw): StageRow => ({
  runId: Number(r.run_id),
  stage: r.stage as StageName,
  attempt: Number(r.attempt),
  state: r.state as StageRow["state"],
  params: (r.params as Record<string, unknown>) ?? {},
  errorCode: (r.error_code as string | null) ?? null,
  errorDetail: (r.error_detail as string | null) ?? null,
  startedAt: r.started_at as Date,
  heartbeatAt: r.heartbeat_at as Date,
  finishedAt: (r.finished_at as Date | null) ?? null,
});

const mapFinding = (r: Raw): FindingRow => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  rank: Number(r.rank),
  title: r.title as string,
  category: r.category as Finding["category"],
  severity: r.severity as Finding["severity"],
  evidenceKind: r.evidence_kind as Finding["evidenceKind"],
  file: r.file as string,
  lineStart: Number(r.line_start),
  lineEnd: Number(r.line_end),
  evidence: r.evidence as string,
  impact: r.impact as string,
  remediation: r.remediation as string,
  confidence: Number(r.model_confidence),
  createdAt: r.created_at as Date,
});

const mapPatch = (r: Raw): PatchRow => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  findingId: Number(r.finding_id),
  baseCommit: r.base_commit as string,
  title: r.title as string,
  explanation: r.explanation as string,
  diff: r.diff as string,
  testDiff: r.test_diff as string,
  diffSha256: r.diff_sha256 as string,
  validationOk: r.validation_ok as boolean,
  validation: r.validation,
  createdAt: r.created_at as Date,
});

const mapVerification = (r: Raw): VerificationRow => ({
  id: Number(r.id),
  patchId: Number(r.patch_id),
  arm: r.arm as VerificationRow["arm"],
  attempt: Number(r.attempt),
  kind: r.kind as VerificationRow["kind"],
  exitCode: r.exit_code === null ? null : Number(r.exit_code),
  durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
  detail: (r.detail as string | null) ?? null,
  commitSha: r.commit_sha as string,
  diffSha256: r.diff_sha256 as string,
  testCommand: r.test_command as string,
  environmentProfile: r.environment_profile,
  logKey: (r.log_key as string | null) ?? null,
  createdAt: r.created_at as Date,
});

const mapOutcome = (r: Raw): OutcomeRow => ({
  patchId: Number(r.patch_id),
  outcome: r.outcome as Outcome,
  reasons: r.reasons as string[],
  arms: r.arms,
  computedAt: r.computed_at as Date,
});

const mapPr = (r: Raw): PullRequestRow => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  patchId: Number(r.patch_id),
  authorizedBy: r.authorized_by as string,
  authorizedAt: r.authorized_at as Date,
  authorizedDiffSha256: r.authorized_diff_sha256 as string,
  authorizedOutcome: r.authorized_outcome as Outcome,
  baseBranch: r.base_branch as string,
  baseSha: r.base_sha as string,
  branchName: r.branch_name as string,
  state: r.state as PullRequestRow["state"],
  prNumber: r.pr_number === null ? null : Number(r.pr_number),
  prUrl: (r.pr_url as string | null) ?? null,
  headSha: (r.head_sha as string | null) ?? null,
  errorCode: (r.error_code as string | null) ?? null,
  errorDetail: (r.error_detail as string | null) ?? null,
  updatedAt: r.updated_at as Date,
});

const mapArtifact = (r: Raw): ArtifactRow => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  patchId: r.patch_id === null ? null : Number(r.patch_id),
  kind: r.kind as string,
  objectKey: r.object_key as string,
  bytes: Number(r.bytes),
  sha256: r.sha256 as string,
  createdAt: r.created_at as Date,
});

const mapLog = (r: Raw): LogRow => ({
  id: Number(r.id),
  runId: Number(r.run_id),
  stage: r.stage as string,
  level: r.level as string,
  message: r.message as string,
  createdAt: r.created_at as Date,
});

const mapAudit = (r: Raw): AuditRow => ({
  id: Number(r.id),
  runId: r.run_id === null ? null : Number(r.run_id),
  owner: r.owner as string,
  actor: r.actor as string,
  event: r.event as string,
  detail: r.detail,
  hash: r.hash as string,
  at: r.at as Date,
});

// ------------------------------------------------------------------ options

export interface StoreOptions {
  /** Maximum runs per owner that are not yet finished. */
  maxActiveRuns?: number;
  /** Maximum stored log rows per run. */
  maxLogRows?: number;
  patchLimits?: Partial<PatchLimits>;
  /** Backoff base for stage retries, in ms (doubles per attempt). */
  retryBaseMs?: number;
}

export const DEFAULT_MAX_ACTIVE_RUNS = 3;
export const DEFAULT_MAX_LOG_ROWS = 2000;
const MAX_LOG_MESSAGE = 2000;
const GENESIS_HASH = "0".repeat(64);

/** Facts a stage may attach to the run it belongs to. */
export interface RunFacts {
  commitSha?: string;
  defaultBranch?: string;
}

/** The write operations a stage handler may perform inside its own transaction. */
export interface StageTx {
  run: RunRow;
  setRunFacts(facts: RunFacts): Promise<void>;
  insertFindings(findings: readonly Finding[]): Promise<FindingRow[]>;
  insertPatch(findingId: number, proposal: PatchProposal, options?: InsertPatchOptions): Promise<{ patch: PatchRow; validation: ProposalValidation; usable: boolean }>;
  insertArtifact(input: ArtifactInput): Promise<ArtifactRow>;
  /** Record the opened pull request, atomically with the run's move to pr_opened. */
  openPullRequest(input: { prNumber: number; prUrl: string; headSha: string }): Promise<PullRequestRow>;
  computeOutcome(patchId: number): Promise<OutcomeRow>;
  recordUnverified(patchId: number, reason: UnverifiedReason): Promise<OutcomeRow>;
}

/** Why a patch has no sandbox evidence at all. */
export type UnverifiedReason = "verification_unavailable" | "unsupported_project";

export interface InsertPatchOptions {
  existingFiles?: ReadonlySet<string>;
  symlinkPaths?: ReadonlySet<string>;
  /** Result of dry-running the diff against the pinned snapshot (apply.ts). */
  apply?: { ok: boolean; issues: ReadonlyArray<{ code: string; message: string; path?: string | undefined }> };
}

export interface ArtifactInput {
  kind: string;
  objectKey: string;
  bytes: number;
  sha256: string;
  patchId?: number | null;
}

export interface StagePersistResult {
  /** The proposed change was rejected by policy: return to patch selection. */
  rejected?: boolean;
}

export type BeginStageResult =
  | { kind: "run"; run: RunRow; stage: StageRow }
  | { kind: "skip"; reason: "run_finished" | "cancelled" | "wrong_state" | "duplicate" | "out_of_order" | "attempts_exhausted" };

export type CompleteStageResult =
  | { kind: "completed"; run: RunRow; next: { stage: StageName; attempt: number } | null }
  | { kind: "cancelled"; run: RunRow }
  | { kind: "ignored"; reason: "not_running" };

export type FailStageResult =
  | { kind: "retry"; run: RunRow; stage: StageName; attempt: number; delayMs: number }
  | { kind: "failed"; run: RunRow }
  | { kind: "ignored"; reason: "not_running" };

// -------------------------------------------------------------------- store

export function createRepoPilotStore(db: Db, options: StoreOptions = {}) {
  const maxActiveRuns = options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS;
  const maxLogRows = options.maxLogRows ?? DEFAULT_MAX_LOG_ROWS;

  async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = await db.connect();

    try {
      await tx.query("BEGIN");
      const result = await fn(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      tx.release();
    }
  }

  async function lockRun(tx: Tx, runId: number, owner?: string): Promise<RunRow> {
    const result = owner === undefined
      ? await tx.query("SELECT * FROM rp_runs WHERE id = $1 FOR UPDATE", [runId])
      : await tx.query("SELECT * FROM rp_runs WHERE id = $1 AND owner = $2 FOR UPDATE", [runId, owner]);
    const row = result.rows[0] as Raw | undefined;

    if (!row) {
      throw new RepoPilotError("not_found", "run not found");
    }

    return mapRun(row);
  }

  // ------------------------------------------------------------------ audit

  async function appendAudit(
    tx: Tx,
    entry: { runId: number | null; owner: string; actor: string; event: string; detail?: Record<string, unknown> }
  ): Promise<void> {
    assertActor(entry.actor);

    const chainKey = entry.runId === null ? `owner:${entry.owner}` : `run:${entry.runId}`;
    const detail = sanitizeForStorage(entry.detail ?? {}) as Record<string, unknown>;
    const at = new Date();

    // Serialise appends to one chain so prev_hash is always the true tail.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [chainKey]);

    const last = await tx.query("SELECT hash FROM rp_audit_events WHERE chain_key = $1 ORDER BY id DESC LIMIT 1", [chainKey]);
    const prevHash = ((last.rows[0] as Raw | undefined)?.hash as string | undefined) ?? GENESIS_HASH;

    const hash = auditHash(prevHash, chainKey, entry.actor, entry.event, detail, at);

    await tx.query(
      `INSERT INTO rp_audit_events (chain_key, run_id, owner, actor, event, detail, prev_hash, hash, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [chainKey, entry.runId, entry.owner, entry.actor, entry.event, JSON.stringify(detail), prevHash, hash, at]
    );
  }

  /** Recompute a chain. `ok: false` means a row was altered or removed. */
  async function verifyAuditChain(chainKey: string): Promise<{ ok: boolean; events: number; brokenAtId: number | null }> {
    const result = await db.query("SELECT * FROM rp_audit_events WHERE chain_key = $1 ORDER BY id", [chainKey]);
    let prev = GENESIS_HASH;

    for (const row of result.rows as Raw[]) {
      const expected = auditHash(
        prev,
        chainKey,
        row.actor as string,
        row.event as string,
        row.detail as Record<string, unknown>,
        row.at as Date
      );

      if (row.prev_hash !== prev || row.hash !== expected) {
        return { ok: false, events: result.rows.length, brokenAtId: Number(row.id) };
      }

      prev = row.hash;
    }

    return { ok: true, events: result.rows.length, brokenAtId: null };
  }

  async function listAudit(owner: string, runId: number, limit = 200): Promise<AuditRow[]> {
    const result = await db.query(
      "SELECT * FROM rp_audit_events WHERE owner = $1 AND run_id = $2 ORDER BY id LIMIT $3",
      [owner, runId, Math.min(Math.max(limit, 1), 1000)]
    );

    return (result.rows as Raw[]).map(mapAudit);
  }

  /** Audit event on a run the owner can see (e.g. a patch was requested). */
  async function recordRunEvent(owner: string, runId: number, actor: string, event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await withTx(async (tx) => {
      const run = await lockRun(tx, runId, owner);

      await appendAudit(tx, { runId: run.id, owner, actor, event, detail });
    });
  }

  /** Audit event not tied to a run (credentials, repository grants). */
  async function recordOwnerEvent(owner: string, actor: string, event: string, detail: Record<string, unknown> = {}): Promise<void> {
    await withTx((tx) => appendAudit(tx, { runId: null, owner, actor, event, detail }));
  }

  // ------------------------------------------------------------ repositories

  async function authorizeRepository(owner: string, actor: string, repo: GithubRepo): Promise<void> {
    assertActor(actor);

    if (!isUserActor(actor)) {
      throw new RepoPilotError("invalid_actor", "only a user can authorise a repository");
    }

    await withTx(async (tx) => {
      await tx.query(
        `INSERT INTO rp_repositories (owner, repo_owner, repo_name, authorized_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [owner, repo.owner, repo.name, actor]
      );
      await appendAudit(tx, { runId: null, owner, actor, event: "repository_authorized", detail: { repo: `${repo.owner}/${repo.name}` } });
    });
  }

  async function revokeRepository(owner: string, actor: string, repo: GithubRepo): Promise<boolean> {
    assertActor(actor);

    return withTx(async (tx) => {
      const result = await tx.query(
        "DELETE FROM rp_repositories WHERE owner = $1 AND repo_owner = $2 AND repo_name = $3",
        [owner, repo.owner, repo.name]
      );

      if ((result.rowCount ?? 0) > 0) {
        await appendAudit(tx, { runId: null, owner, actor, event: "repository_revoked", detail: { repo: `${repo.owner}/${repo.name}` } });
      }

      return (result.rowCount ?? 0) > 0;
    });
  }

  async function isRepositoryAuthorized(owner: string, repo: { owner: string; name: string }): Promise<boolean> {
    const result = await db.query(
      "SELECT 1 FROM rp_repositories WHERE owner = $1 AND lower(repo_owner) = lower($2) AND lower(repo_name) = lower($3)",
      [owner, repo.owner, repo.name]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async function listRepositories(owner: string): Promise<{ owner: string; name: string; authorizedBy: string; authorizedAt: Date }[]> {
    const result = await db.query("SELECT * FROM rp_repositories WHERE owner = $1 ORDER BY repo_owner, repo_name", [owner]);

    return (result.rows as Raw[]).map((r) => ({
      owner: r.repo_owner as string,
      name: r.repo_name as string,
      authorizedBy: r.authorized_by as string,
      authorizedAt: r.authorized_at as Date,
    }));
  }

  // ------------------------------------------------------------------- runs

  async function createRun(input: {
    owner: string;
    actor: string;
    repo: GithubRepo;
    requestedRef?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ run: RunRow; created: boolean }> {
    assertActor(input.actor);

    if (!isUserActor(input.actor)) {
      throw new RepoPilotError("invalid_actor", "runs are started by a user");
    }

    return withTx(async (tx) => {
      // Serialise per owner so the quota check cannot be raced.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`rp-quota:${input.owner}`]);

      if (input.idempotencyKey) {
        const existing = await tx.query("SELECT * FROM rp_runs WHERE owner = $1 AND idempotency_key = $2", [input.owner, input.idempotencyKey]);
        const row = existing.rows[0] as Raw | undefined;

        if (row) {
          return { run: mapRun(row), created: false };
        }
      }

      const active = await tx.query(
        "SELECT count(*)::int AS n FROM rp_runs WHERE owner = $1 AND state NOT IN ('pr_opened','failed','cancelled')",
        [input.owner]
      );

      if (Number((active.rows[0] as Raw).n) >= maxActiveRuns) {
        throw new RepoPilotError("quota", `at most ${maxActiveRuns} runs may be active at once`);
      }

      const inserted = await tx.query(
        `INSERT INTO rp_runs (owner, repo_owner, repo_name, repo_url, requested_ref, idempotency_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [input.owner, input.repo.owner, input.repo.name, input.repo.url, input.requestedRef ?? null, input.idempotencyKey ?? null, input.actor]
      );
      const run = mapRun(inserted.rows[0] as Raw);

      await appendAudit(tx, {
        runId: run.id,
        owner: run.owner,
        actor: input.actor,
        event: "run_created",
        detail: { repo: `${run.repoOwner}/${run.repoName}`, ref: run.requestedRef },
      });

      return { run, created: true };
    });
  }

  async function getRun(owner: string, runId: number): Promise<RunRow | null> {
    const result = await db.query("SELECT * FROM rp_runs WHERE id = $1 AND owner = $2", [runId, owner]);
    const row = result.rows[0] as Raw | undefined;

    return row ? mapRun(row) : null;
  }

  async function listRuns(owner: string, { limit = 50, beforeId }: { limit?: number; beforeId?: number } = {}): Promise<RunRow[]> {
    const result = await db.query(
      "SELECT * FROM rp_runs WHERE owner = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3",
      [owner, beforeId ?? null, Math.min(Math.max(limit, 1), 200)]
    );

    return (result.rows as Raw[]).map(mapRun);
  }

  /** Move a run to `to`, validating against the state machine, with audit. */
  async function transitionLocked(
    tx: Tx,
    run: RunRow,
    to: RunState,
    actor: string,
    extra: { failureCode?: string; failureDetail?: string; event?: string; detail?: Record<string, unknown> } = {}
  ): Promise<RunRow> {
    assertRunTransition(run.state, to, isUserActor(actor) ? "user" : "system");

    const finished = isTerminalRunState(to);
    const result = await tx.query(
      `UPDATE rp_runs
       SET state = $2, updated_at = now(),
           finished_at = CASE WHEN $3 THEN now() ELSE NULL END,
           failure_code = $4, failure_detail = $5
       WHERE id = $1 RETURNING *`,
      [
        run.id,
        to,
        finished,
        extra.failureCode ?? null,
        extra.failureDetail === undefined ? null : redactSensitive(extra.failureDetail).slice(0, 1000),
      ]
    );

    await appendAudit(tx, {
      runId: run.id,
      owner: run.owner,
      actor,
      event: extra.event ?? "run_state_changed",
      detail: { from: run.state, to, ...(extra.failureCode ? { failureCode: extra.failureCode } : {}), ...extra.detail },
    });

    return mapRun(result.rows[0] as Raw);
  }

  /** Ask for a run to stop. Idle runs end at once; working runs stop at the next checkpoint. */
  async function requestCancel(owner: string, runId: number, actor: string): Promise<{ run: RunRow; cancelledNow: boolean }> {
    assertActor(actor);

    return withTx(async (tx) => {
      const run = await lockRun(tx, runId, owner);

      if (isTerminalRunState(run.state)) {
        throw new RepoPilotError("conflict", `run is already ${run.state}`);
      }

      const working = new Set<RunState>(["ingesting", "analyzing", "patching", "verifying", "pr_authorized"]);

      if (!working.has(run.state)) {
        const next = await transitionLocked(tx, run, "cancelled", actor, { event: "run_cancelled" });

        return { run: next, cancelledNow: true };
      }

      if (run.cancelRequested) {
        return { run, cancelledNow: false };
      }

      const updated = await tx.query("UPDATE rp_runs SET cancel_requested = TRUE, updated_at = now() WHERE id = $1 RETURNING *", [runId]);

      await appendAudit(tx, { runId, owner, actor, event: "cancel_requested", detail: { state: run.state } });

      return { run: mapRun(updated.rows[0] as Raw), cancelledNow: false };
    });
  }

  async function isCancelRequested(runId: number): Promise<boolean> {
    const result = await db.query("SELECT cancel_requested, state FROM rp_runs WHERE id = $1", [runId]);
    const row = result.rows[0] as Raw | undefined;

    return !row || row.cancel_requested === true || isTerminalRunState(row.state as RunState);
  }

  // ----------------------------------------------------------------- stages

  async function listStages(owner: string, runId: number): Promise<StageRow[]> {
    const result = await db.query(
      `SELECT s.* FROM rp_stages s JOIN rp_runs r ON r.id = s.run_id
       WHERE s.run_id = $1 AND r.owner = $2 ORDER BY s.started_at, s.stage, s.attempt`,
      [runId, owner]
    );

    return (result.rows as Raw[]).map(mapStage);
  }

  async function stageRecords(tx: Tx, runId: number): Promise<StageRecord[]> {
    const result = await tx.query("SELECT stage, attempt, state FROM rp_stages WHERE run_id = $1", [runId]);

    return (result.rows as Raw[]).map((r) => ({ stage: r.stage as StageName, attempt: Number(r.attempt), state: r.state as StageRecord["state"] }));
  }

  /**
   * Start a stage attempt. Idempotent: a redelivered job for an attempt that
   * already exists is skipped, and nothing runs for a finished or cancelled
   * run.
   */
  async function beginStage(input: {
    runId: number;
    stage: StageName;
    attempt: number;
    worker: string;
    params?: Record<string, unknown>;
  }): Promise<BeginStageResult> {
    assertActor(input.worker);

    return withTx(async (tx): Promise<BeginStageResult> => {
      const run = await lockRun(tx, input.runId);
      const flow = STAGE_FLOW[input.stage];

      if (isTerminalRunState(run.state)) {
        return { kind: "skip", reason: "run_finished" };
      }

      if (run.cancelRequested) {
        await transitionLocked(tx, run, "cancelled", input.worker, { event: "run_cancelled", detail: { at: "stage_start", stage: input.stage } });
        return { kind: "skip", reason: "cancelled" };
      }

      const key = stageIdempotencyKey(run.id, input.stage, input.attempt);
      const existing = await tx.query("SELECT 1 FROM rp_stages WHERE idempotency_key = $1", [key]);

      if ((existing.rowCount ?? 0) > 0) {
        return { kind: "skip", reason: "duplicate" };
      }

      if (run.state !== flow.from && run.state !== flow.working) {
        return { kind: "skip", reason: "wrong_state" };
      }

      const records = await stageRecords(tx, run.id);

      if (records.some((r) => r.state === "running")) {
        return { kind: "skip", reason: "out_of_order" };
      }

      const previous = latestAttempt(records, input.stage);

      if (input.attempt !== (previous?.attempt ?? 0) + 1) {
        return { kind: "skip", reason: "out_of_order" };
      }

      if (input.attempt > MAX_STAGE_ATTEMPTS[input.stage]) {
        return { kind: "skip", reason: "attempts_exhausted" };
      }

      if (run.state !== flow.working) {
        const moved = await transitionLocked(tx, run, flow.working, input.worker, { detail: { stage: input.stage } });
        Object.assign(run, moved);
      }

      const params = sanitizeForStorage(input.params ?? {}) as Record<string, unknown>;
      const inserted = await tx.query(
        `INSERT INTO rp_stages (run_id, stage, attempt, idempotency_key, worker, params)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [run.id, input.stage, input.attempt, key, input.worker, JSON.stringify(params)]
      );

      await appendAudit(tx, { runId: run.id, owner: run.owner, actor: input.worker, event: "stage_started", detail: { stage: input.stage, attempt: input.attempt } });

      return { kind: "run", run, stage: mapStage(inserted.rows[0] as Raw) };
    });
  }

  async function touchStage(runId: number, stage: StageName, attempt: number): Promise<void> {
    await db.query(
      "UPDATE rp_stages SET heartbeat_at = now() WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND state = 'running'",
      [runId, stage, attempt]
    );
  }

  function makeStageTx(tx: Tx, run: RunRow): StageTx {
    return {
      run,

      async setRunFacts(facts) {
        if (facts.commitSha !== undefined && !/^[0-9a-f]{40}$/.test(facts.commitSha)) {
          throw new RepoPilotError("invalid_input", "commitSha must be a 40-character lowercase hex SHA");
        }

        if (facts.commitSha !== undefined && run.commitSha !== null && run.commitSha !== facts.commitSha) {
          throw new RepoPilotError("conflict", "the analysed commit of a run cannot change");
        }

        await tx.query(
          "UPDATE rp_runs SET commit_sha = COALESCE($2, commit_sha), default_branch = COALESCE($3, default_branch), updated_at = now() WHERE id = $1",
          [run.id, facts.commitSha ?? null, facts.defaultBranch ?? null]
        );
        run.commitSha = facts.commitSha ?? run.commitSha;
        run.defaultBranch = facts.defaultBranch ?? run.defaultBranch;
      },

      async insertFindings(findings) {
        const rows: FindingRow[] = [];
        const rankResult = await tx.query("SELECT COALESCE(MAX(rank), 0)::int AS r FROM rp_findings WHERE run_id = $1", [run.id]);
        let rank = Number((rankResult.rows[0] as Raw).r);

        for (const finding of findings) {
          const inserted = await tx.query(
            `INSERT INTO rp_findings
               (run_id, rank, fingerprint, title, category, severity, evidence_kind, file, line_start, line_end, evidence, impact, remediation, model_confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (run_id, fingerprint) DO NOTHING RETURNING *`,
            [
              run.id, rank + 1, findingFingerprint(finding), finding.title, finding.category, finding.severity, finding.evidenceKind,
              finding.file, finding.lineStart, finding.lineEnd, redactSensitive(finding.evidence), redactSensitive(finding.impact),
              redactSensitive(finding.remediation), finding.confidence,
            ]
          );

          const row = inserted.rows[0] as Raw | undefined;

          if (row) {
            rank += 1;
            rows.push(mapFinding(row));
          }
        }

        return rows;
      },

      async insertPatch(findingId, proposal, patchOptions = {}) {
        const { apply, ...policyOptions } = patchOptions;
        if (run.commitSha === null) {
          throw new RepoPilotError("conflict", "a patch needs the run's analysed commit");
        }

        const finding = await tx.query("SELECT 1 FROM rp_findings WHERE id = $1 AND run_id = $2", [findingId, run.id]);

        if ((finding.rowCount ?? 0) === 0) {
          throw new RepoPilotError("not_found", "finding not found for this run");
        }

        const validation = validatePatchProposal(
          { diff: proposal.diff, testDiff: proposal.testDiff },
          { ...(options.patchLimits ? { limits: options.patchLimits } : {}), ...policyOptions }
        );
        // Usable = passes policy AND applies cleanly to the pinned snapshot.
        const usable = validation.ok && (apply?.ok ?? true);
        const verdict = { ...validation, apply: apply ?? null };
        const digest = patchDigest(proposal.diff, proposal.testDiff);

        // The original bytes are kept even when validation fails, so a
        // reviewer can see exactly what was rejected and why.
        const inserted = await tx.query(
          `INSERT INTO rp_patches (run_id, finding_id, base_commit, title, explanation, diff, test_diff, diff_sha256, validation_ok, validation)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (finding_id, diff_sha256) DO NOTHING RETURNING *`,
          [run.id, findingId, run.commitSha, proposal.title, redactSensitive(proposal.explanation), proposal.diff, proposal.testDiff, digest, usable, JSON.stringify(verdict)]
        );

        const row = (inserted.rows[0] as Raw | undefined) ?? ((await tx.query("SELECT * FROM rp_patches WHERE finding_id = $1 AND diff_sha256 = $2", [findingId, digest])).rows[0] as Raw);

        return { patch: mapPatch(row), validation, usable };
      },

      async insertArtifact(input) {
        const inserted = await tx.query(
          `INSERT INTO rp_artifacts (run_id, patch_id, kind, object_key, bytes, sha256) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (object_key) DO UPDATE SET object_key = EXCLUDED.object_key RETURNING *`,
          [run.id, input.patchId ?? null, input.kind, input.objectKey, input.bytes, input.sha256]
        );

        return mapArtifact(inserted.rows[0] as Raw);
      },

      async openPullRequest(input) {
        if (!Number.isInteger(input.prNumber) || input.prNumber < 1 || !/^https:\/\/github\.com\/[^\s]+$/.test(input.prUrl) || !/^[0-9a-f]{40}$/.test(input.headSha)) {
          throw new RepoPilotError("invalid_input", "invalid pull request record");
        }

        const result = await tx.query(
          `UPDATE rp_pull_requests SET state = 'opened', pr_number = $2, pr_url = $3, head_sha = $4, error_code = NULL, error_detail = NULL, updated_at = now()
           WHERE run_id = $1 AND state IN ('authorized', 'creating') RETURNING *`,
          [run.id, input.prNumber, input.prUrl, input.headSha]
        );
        const row = result.rows[0] as Raw | undefined;

        if (!row) {
          throw new RepoPilotError("conflict", "the pull request is not awaiting creation");
        }

        await appendAudit(tx, { runId: run.id, owner: run.owner, actor: "system", event: "pr_opened", detail: { prNumber: input.prNumber, prUrl: input.prUrl, headSha: input.headSha } });

        return mapPr(row);
      },

      computeOutcome: (patchId) => computeOutcomeIn(tx, run.id, patchId),
      recordUnverified: (patchId, reason) => recordUnverifiedIn(tx, run.id, patchId, reason),
    };
  }

  /**
   * Finish a stage attempt. `persist` writes the stage's results in the SAME
   * transaction as the state change, so results and progress commit
   * together or not at all.
   */
  async function completeStage(input: {
    runId: number;
    stage: StageName;
    attempt: number;
    worker: string;
    persist?: (tx: StageTx) => Promise<StagePersistResult | void>;
  }): Promise<CompleteStageResult> {
    assertActor(input.worker);

    return withTx(async (tx): Promise<CompleteStageResult> => {
      const run = await lockRun(tx, input.runId);
      const stage = await tx.query(
        "SELECT * FROM rp_stages WHERE run_id = $1 AND stage = $2 AND attempt = $3 FOR UPDATE",
        [input.runId, input.stage, input.attempt]
      );
      const stageRow = stage.rows[0] as Raw | undefined;

      if (!stageRow || stageRow.state !== "running") {
        return { kind: "ignored", reason: "not_running" };
      }

      const result = (await input.persist?.(makeStageTx(tx, run))) ?? {};

      await tx.query(
        "UPDATE rp_stages SET state = 'succeeded', finished_at = now(), heartbeat_at = now() WHERE run_id = $1 AND stage = $2 AND attempt = $3",
        [input.runId, input.stage, input.attempt]
      );

      const flow = STAGE_FLOW[input.stage];
      await appendAudit(tx, { runId: run.id, owner: run.owner, actor: input.worker, event: "stage_succeeded", detail: { stage: input.stage, attempt: input.attempt, rejected: result.rejected === true } });

      const fresh = mapRun(((await tx.query("SELECT * FROM rp_runs WHERE id = $1", [run.id])).rows[0]) as Raw);

      if (fresh.cancelRequested) {
        return { kind: "cancelled", run: await transitionLocked(tx, fresh, "cancelled", input.worker, { event: "run_cancelled", detail: { at: "stage_end", stage: input.stage } }) };
      }

      if (result.rejected) {
        if (flow.rejected === undefined) {
          throw new RepoPilotError("invalid_input", `stage ${input.stage} cannot reject a result`);
        }

        const next = await transitionLocked(tx, fresh, flow.rejected, input.worker, { event: "patch_rejected", detail: { stage: input.stage } });

        return { kind: "completed", run: next, next: null };
      }

      const next = fresh.state === flow.success ? fresh : await transitionLocked(tx, fresh, flow.success, input.worker, { detail: { stage: input.stage } });

      return { kind: "completed", run: next, next: flow.next ? { stage: flow.next, attempt: 1 + (latestAttempt(await stageRecords(tx, run.id), flow.next)?.attempt ?? 0) } : null };
    });
  }

  /**
   * Record a failed attempt. If the failure is retryable and attempts remain
   * the caller gets the next attempt and a backoff delay; otherwise the run
   * fails with a stable code.
   */
  async function failStage(input: {
    runId: number;
    stage: StageName;
    attempt: number;
    worker: string;
    code: string;
    detail: string;
    retryable: boolean;
  }): Promise<FailStageResult> {
    assertActor(input.worker);

    return withTx(async (tx): Promise<FailStageResult> => {
      const run = await lockRun(tx, input.runId);
      const updated = await tx.query(
        `UPDATE rp_stages SET state = 'failed', finished_at = now(), error_code = $4, error_detail = $5
         WHERE run_id = $1 AND stage = $2 AND attempt = $3 AND state = 'running' RETURNING attempt`,
        [input.runId, input.stage, input.attempt, input.code.slice(0, 40), redactSensitive(input.detail).slice(0, 1000)]
      );

      if ((updated.rowCount ?? 0) === 0) {
        return { kind: "ignored", reason: "not_running" };
      }

      await appendAudit(tx, { runId: run.id, owner: run.owner, actor: input.worker, event: "stage_failed", detail: { stage: input.stage, attempt: input.attempt, code: input.code, retryable: input.retryable } });

      if (!isTerminalRunState(run.state) && !run.cancelRequested && input.retryable && canRetryStage(input.stage, input.attempt)) {
        return { kind: "retry", run, stage: input.stage, attempt: input.attempt + 1, delayMs: retryDelayMs(input.attempt, options.retryBaseMs) };
      }

      if (isTerminalRunState(run.state)) {
        return { kind: "failed", run };
      }

      const next = run.cancelRequested
        ? await transitionLocked(tx, run, "cancelled", input.worker, { event: "run_cancelled", detail: { at: "stage_failure", stage: input.stage } })
        : await transitionLocked(tx, run, "failed", input.worker, { failureCode: input.code, failureDetail: input.detail, event: "run_failed", detail: { stage: input.stage } });

      return { kind: "failed", run: next };
    });
  }

  /** Parameters recorded for the most recent attempt of a stage (retries reuse them). */
  async function latestStageParams(runId: number, stage: StageName): Promise<Record<string, unknown>> {
    const result = await db.query("SELECT params FROM rp_stages WHERE run_id = $1 AND stage = $2 ORDER BY attempt DESC LIMIT 1", [runId, stage]);

    return ((result.rows[0] as Raw | undefined)?.params as Record<string, unknown> | undefined) ?? {};
  }

  /**
   * Stages marked running whose worker stopped heart-beating. They are
   * failed as "interrupted" (retryable) so ordinary retry accounting applies.
   */
  async function recoverStaleStages(staleAfterMs: number): Promise<Array<{ runId: number; stage: StageName; result: FailStageResult }>> {
    const stale = await db.query(
      "SELECT run_id, stage, attempt FROM rp_stages WHERE state = 'running' AND heartbeat_at < now() - ($1::int * interval '1 millisecond')",
      [staleAfterMs]
    );
    const recovered: Array<{ runId: number; stage: StageName; result: FailStageResult }> = [];

    for (const row of stale.rows as Raw[]) {
      const result = await failStage({
        runId: Number(row.run_id),
        stage: row.stage as StageName,
        attempt: Number(row.attempt),
        worker: "system",
        code: "interrupted",
        detail: "The worker stopped before finishing this stage",
        retryable: true,
      });

      recovered.push({ runId: Number(row.run_id), stage: row.stage as StageName, result });
    }

    return recovered;
  }

  /** Runs whose next automatic step was never queued (e.g. a crash after commit). */
  async function findIdleRuns(idleForMs: number): Promise<Array<{ runId: number; stage: StageName; attempt: number }>> {
    const idle = await db.query(
      `SELECT r.id, r.state FROM rp_runs r
       WHERE r.state IN ('queued','ingesting','analyzing','patching','verifying','pr_authorized')
         AND r.updated_at < now() - ($1::int * interval '1 millisecond')
         AND NOT EXISTS (SELECT 1 FROM rp_stages s WHERE s.run_id = r.id AND s.state = 'running')
       ORDER BY r.id LIMIT 100`,
      [idleForMs]
    );
    const work: Array<{ runId: number; stage: StageName; attempt: number }> = [];

    for (const row of idle.rows as Raw[]) {
      const stages = await db.query("SELECT stage, attempt, state FROM rp_stages WHERE run_id = $1", [row.id]);
      const next = nextStageToQueue(
        row.state as RunState,
        (stages.rows as Raw[]).map((s) => ({ stage: s.stage as StageName, attempt: Number(s.attempt), state: s.state as StageRecord["state"] }))
      );

      if (next) {
        work.push({ runId: Number(row.id), ...next });
      }
    }

    return work;
  }

  /** Fail a run outright (e.g. a retry could not be queued). */
  async function failRun(runId: number, actor: string, code: string, detail: string): Promise<RunRow> {
    assertActor(actor);

    return withTx(async (tx) => {
      const run = await lockRun(tx, runId);

      if (isTerminalRunState(run.state)) {
        return run;
      }

      return transitionLocked(tx, run, "failed", actor, { failureCode: code, failureDetail: detail, event: "run_failed" });
    });
  }

  // ------------------------------------------------------------ AI budget

  /**
   * Reserve one provider request against the run's limits, atomically. The
   * limits are checked in the UPDATE itself, so concurrent workers cannot
   * both pass a check made before either increments. A single in-flight
   * request can still overshoot the token caps by its own size, which
   * maxOutputTokens and the context budget bound.
   */
  async function reserveAiRequest(runId: number, limits: { maxRequests: number; maxInputTokens: number; maxOutputTokens: number }): Promise<boolean> {
    const result = await db.query(
      `UPDATE rp_runs SET ai_requests = ai_requests + 1
       WHERE id = $1 AND ai_requests < $2 AND ai_input_tokens < $3 AND ai_output_tokens < $4`,
      [runId, limits.maxRequests, limits.maxInputTokens, limits.maxOutputTokens]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async function recordAiUsage(runId: number, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
    if (!Number.isInteger(usage.inputTokens) || !Number.isInteger(usage.outputTokens) || usage.inputTokens < 0 || usage.outputTokens < 0) {
      throw new RepoPilotError("invalid_input", "token counts must be non-negative integers");
    }

    await db.query("UPDATE rp_runs SET ai_input_tokens = ai_input_tokens + $2, ai_output_tokens = ai_output_tokens + $3 WHERE id = $1", [runId, usage.inputTokens, usage.outputTokens]);
  }

  // ------------------------------------------------------------------ logs

  async function appendLog(runId: number, stage: StageName, level: "INFO" | "WARN" | "ERROR", message: string): Promise<void> {
    const text = redactSensitive(message).slice(0, MAX_LOG_MESSAGE);

    // Bounded per run: once the cap is hit further lines are dropped.
    await db.query(
      `INSERT INTO rp_logs (run_id, stage, level, message)
       SELECT $1, $2, $3, $4 WHERE (SELECT count(*) FROM rp_logs WHERE run_id = $1) < $5`,
      [runId, stage, level, text, maxLogRows]
    );
  }

  async function listLogs(owner: string, runId: number, { afterId = 0, limit = 500 }: { afterId?: number; limit?: number } = {}): Promise<LogRow[]> {
    const result = await db.query(
      `SELECT l.* FROM rp_logs l JOIN rp_runs r ON r.id = l.run_id
       WHERE l.run_id = $1 AND r.owner = $2 AND l.id > $3 ORDER BY l.id LIMIT $4`,
      [runId, owner, afterId, Math.min(Math.max(limit, 1), 1000)]
    );

    return (result.rows as Raw[]).map(mapLog);
  }

  // ----------------------------------------------------- findings / patches

  async function listFindings(owner: string, runId: number): Promise<FindingRow[]> {
    const result = await db.query(
      `SELECT f.* FROM rp_findings f JOIN rp_runs r ON r.id = f.run_id WHERE f.run_id = $1 AND r.owner = $2 ORDER BY f.rank`,
      [runId, owner]
    );

    return (result.rows as Raw[]).map(mapFinding);
  }

  async function getFinding(owner: string, runId: number, findingId: number): Promise<FindingRow | null> {
    const result = await db.query(
      `SELECT f.* FROM rp_findings f JOIN rp_runs r ON r.id = f.run_id WHERE f.id = $1 AND f.run_id = $2 AND r.owner = $3`,
      [findingId, runId, owner]
    );
    const row = result.rows[0] as Raw | undefined;

    return row ? mapFinding(row) : null;
  }

  async function listPatches(owner: string, runId: number): Promise<PatchRow[]> {
    const result = await db.query(
      `SELECT p.* FROM rp_patches p JOIN rp_runs r ON r.id = p.run_id WHERE p.run_id = $1 AND r.owner = $2 ORDER BY p.id`,
      [runId, owner]
    );

    return (result.rows as Raw[]).map(mapPatch);
  }

  async function getPatch(owner: string, runId: number, patchId: number): Promise<PatchRow | null> {
    const result = await db.query(
      `SELECT p.* FROM rp_patches p JOIN rp_runs r ON r.id = p.run_id WHERE p.id = $1 AND p.run_id = $2 AND r.owner = $3`,
      [patchId, runId, owner]
    );
    const row = result.rows[0] as Raw | undefined;

    return row ? mapPatch(row) : null;
  }

  /** The newest policy-valid patch of a run (what the verify stage works on). */
  async function latestValidPatch(runId: number): Promise<PatchRow | null> {
    const result = await db.query("SELECT * FROM rp_patches WHERE run_id = $1 AND validation_ok ORDER BY id DESC LIMIT 1", [runId]);
    const row = result.rows[0] as Raw | undefined;

    return row ? mapPatch(row) : null;
  }

  // ---------------------------------------------------------- verification

  /**
   * Record one sandbox execution. `run` must parse as a SandboxRun, the only
   * shape the sandbox result path produces; anything else throws.
   */
  async function recordVerification(input: {
    runId: number;
    patchId: number;
    arm: VerificationRow["arm"];
    attempt: number;
    run: unknown;
    testCommand: string;
    environmentProfile: Record<string, unknown>;
    logKey?: string | null;
  }): Promise<VerificationRow> {
    const record = SandboxRunSchema.parse(input.run);

    return withTx(async (tx) => {
      const run = await lockRun(tx, input.runId);

      if (run.state !== "verifying") {
        throw new RepoPilotError("conflict", "verification results can only be recorded while the run is verifying");
      }

      const patch = await tx.query("SELECT * FROM rp_patches WHERE id = $1 AND run_id = $2", [input.patchId, input.runId]);
      const patchRow = patch.rows[0] as Raw | undefined;

      if (!patchRow) {
        throw new RepoPilotError("not_found", "patch not found for this run");
      }

      const detail = "detail" in record ? record.detail ?? null : null;
      const inserted = await tx.query(
        `INSERT INTO rp_verifications
           (patch_id, arm, attempt, kind, exit_code, duration_ms, detail, commit_sha, diff_sha256, test_command, environment_profile, log_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (patch_id, arm, attempt) DO NOTHING RETURNING *`,
        [
          input.patchId, input.arm, input.attempt, record.kind,
          record.kind === "exited" ? record.exitCode : null,
          "durationMs" in record ? record.durationMs : null,
          detail === null ? null : redactSensitive(detail),
          patchRow.base_commit, patchRow.diff_sha256, redactSensitive(input.testCommand).slice(0, 300),
          JSON.stringify(sanitizeForStorage(input.environmentProfile)), input.logKey ?? null,
        ]
      );

      const row = (inserted.rows[0] as Raw | undefined)
        ?? ((await tx.query("SELECT * FROM rp_verifications WHERE patch_id = $1 AND arm = $2 AND attempt = $3", [input.patchId, input.arm, input.attempt])).rows[0] as Raw);

      return mapVerification(row);
    });
  }

  async function listVerifications(owner: string, runId: number): Promise<VerificationRow[]> {
    const result = await db.query(
      `SELECT v.* FROM rp_verifications v JOIN rp_patches p ON p.id = v.patch_id JOIN rp_runs r ON r.id = p.run_id
       WHERE p.run_id = $1 AND r.owner = $2 ORDER BY v.patch_id, v.arm, v.attempt`,
      [runId, owner]
    );

    return (result.rows as Raw[]).map(mapVerification);
  }

  async function computeOutcomeIn(q: Pick<Tx, "query">, runId: number, patchId: number): Promise<OutcomeRow> {
    const patch = await q.query("SELECT 1 FROM rp_patches WHERE id = $1 AND run_id = $2", [patchId, runId]);

    if ((patch.rowCount ?? 0) === 0) {
      throw new RepoPilotError("not_found", "patch not found for this run");
    }

    const rows = await q.query("SELECT * FROM rp_verifications WHERE patch_id = $1 ORDER BY arm, attempt", [patchId]);
    const arms: Record<"baseline" | "control" | "patched", SandboxRun[]> = { baseline: [], control: [], patched: [] };

    for (const raw of rows.rows as Raw[]) {
      const row = mapVerification(raw);
      const record = row.kind === "exited"
        ? { kind: row.kind, exitCode: row.exitCode, durationMs: row.durationMs }
        : row.kind === "timeout"
          ? { kind: row.kind, durationMs: row.durationMs }
          : row.kind === "no_test_script"
            ? { kind: row.kind }
            : { kind: row.kind, ...(row.detail ? { detail: row.detail } : {}) };

      arms[row.arm].push(SandboxRunSchema.parse(record));
    }

    const result = classifyOutcome({
      baseline: arms.baseline,
      patched: arms.patched,
      ...(arms.control.length > 0 ? { control: arms.control } : {}),
    });

    const saved = await q.query(
      `INSERT INTO rp_outcomes (patch_id, outcome, reasons, arms, computed_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (patch_id) DO UPDATE SET outcome = EXCLUDED.outcome, reasons = EXCLUDED.reasons, arms = EXCLUDED.arms, computed_at = now()
       RETURNING *`,
      [patchId, result.outcome, result.reasons, JSON.stringify({ arms: result.arms, caveats: result.caveats })]
    );

    return mapOutcome(saved.rows[0] as Raw);
  }

  async function recordUnverifiedIn(q: Pick<Tx, "query">, runId: number, patchId: number, reason: UnverifiedReason): Promise<OutcomeRow> {
    const patch = await q.query("SELECT 1 FROM rp_patches WHERE id = $1 AND run_id = $2", [patchId, runId]);

    if ((patch.rowCount ?? 0) === 0) {
      throw new RepoPilotError("not_found", "patch not found for this run");
    }

    const saved = await q.query(
      `INSERT INTO rp_outcomes (patch_id, outcome, reasons, arms, computed_at) VALUES ($1, 'inconclusive', $2, $3, now())
       ON CONFLICT (patch_id) DO UPDATE SET outcome = 'inconclusive', reasons = EXCLUDED.reasons, arms = EXCLUDED.arms, computed_at = now()
       RETURNING *`,
      [patchId, [reason], JSON.stringify({ arms: {}, caveats: ["No sandbox verification was run."] })]
    );

    return mapOutcome(saved.rows[0] as Raw);
  }

  async function listOutcomes(owner: string, runId: number): Promise<OutcomeRow[]> {
    const result = await db.query(
      `SELECT o.* FROM rp_outcomes o JOIN rp_patches p ON p.id = o.patch_id JOIN rp_runs r ON r.id = p.run_id
       WHERE p.run_id = $1 AND r.owner = $2 ORDER BY o.patch_id`,
      [runId, owner]
    );

    return (result.rows as Raw[]).map(mapOutcome);
  }

  // -------------------------------------------------------- PR authorization

  /**
   * A human approves opening a pull request for ONE reviewed patch. Every
   * field the reviewer saw is compared with what is stored right now; any
   * difference (the patch changed, the base moved, the outcome changed)
   * rejects the approval.
   */
  async function authorizePullRequest(input: {
    owner: string;
    runId: number;
    actor: string;
    request: unknown;
  }): Promise<{ run: RunRow; pullRequest: PullRequestRow }> {
    assertActor(input.actor);

    if (!isUserActor(input.actor)) {
      throw new RepoPilotError("invalid_actor", "only a user can authorise a pull request");
    }

    const request = AuthorizePrRequestSchema.parse(input.request);

    return withTx(async (tx) => {
      const run = await lockRun(tx, input.runId, input.owner);

      if (run.state !== "ready_for_review") {
        throw new RepoPilotError("conflict", `a pull request can only be authorised in ready_for_review (run is ${run.state})`);
      }

      const patchResult = await tx.query("SELECT * FROM rp_patches WHERE id = $1 AND run_id = $2", [request.patchId, run.id]);
      const patchRow = patchResult.rows[0] as Raw | undefined;

      if (!patchRow) {
        throw new RepoPilotError("not_found", "patch not found for this run");
      }

      const patch = mapPatch(patchRow);
      const mismatch = (what: string): RepoPilotError => new RepoPilotError("authorization_mismatch", `${what} no longer matches what was reviewed`);

      if (!patch.validationOk) {
        throw new RepoPilotError("conflict", "a patch that failed policy validation cannot be proposed");
      }

      const digest = patchDigest(patch.diff, patch.testDiff);

      if (digest !== request.diffSha256 || digest !== patch.diffSha256) {
        throw mismatch("The patch digest");
      }

      if (run.commitSha === null || patch.baseCommit !== request.baseCommitSha || run.commitSha !== request.baseCommitSha) {
        throw mismatch("The base commit");
      }

      if (run.defaultBranch === null) {
        throw new RepoPilotError("conflict", "the repository's default branch is unknown");
      }

      const outcomeResult = await tx.query("SELECT * FROM rp_outcomes WHERE patch_id = $1", [patch.id]);
      const outcomeRow = outcomeResult.rows[0] as Raw | undefined;

      if (!outcomeRow) {
        throw new RepoPilotError("conflict", "the patch has no verification outcome yet");
      }

      const outcome = mapOutcome(outcomeRow);

      if (outcome.outcome !== request.outcome) {
        throw mismatch("The verification outcome");
      }

      if (outcome.outcome === "regressed") {
        throw new RepoPilotError("conflict", "a patch that regressed the baseline cannot be proposed");
      }

      const branchName = `repopilot/run-${run.id}-patch-${patch.id}-${digest.slice(0, 8)}`;
      const inserted = await tx.query(
        `INSERT INTO rp_pull_requests (run_id, patch_id, authorized_by, authorized_diff_sha256, authorized_outcome, base_branch, base_sha, branch_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (patch_id) DO NOTHING RETURNING *`,
        [run.id, patch.id, input.actor, digest, outcome.outcome, run.defaultBranch, run.commitSha, branchName]
      );
      const prRow = inserted.rows[0] as Raw | undefined;

      if (!prRow) {
        throw new RepoPilotError("conflict", "a pull request was already authorised for this patch");
      }

      const next = await transitionLocked(tx, run, "pr_authorized", input.actor, {
        event: "pr_authorized",
        detail: { patchId: patch.id, diffSha256: digest, baseCommitSha: run.commitSha, outcome: outcome.outcome, branch: branchName },
      });

      return { run: next, pullRequest: mapPr(prRow) };
    });
  }

  async function getPullRequest(owner: string, runId: number): Promise<PullRequestRow | null> {
    const result = await db.query(
      `SELECT p.* FROM rp_pull_requests p JOIN rp_runs r ON r.id = p.run_id WHERE p.run_id = $1 AND r.owner = $2`,
      [runId, owner]
    );
    const row = result.rows[0] as Raw | undefined;

    return row ? mapPr(row) : null;
  }

  /** Worker-side read (no owner scope) for the pull-request stage. */
  async function getPullRequestForRun(runId: number): Promise<PullRequestRow | null> {
    const result = await db.query("SELECT * FROM rp_pull_requests WHERE run_id = $1", [runId]);
    const row = result.rows[0] as Raw | undefined;

    return row ? mapPr(row) : null;
  }

  async function getPatchById(patchId: number): Promise<PatchRow | null> {
    const result = await db.query("SELECT * FROM rp_patches WHERE id = $1", [patchId]);
    const row = result.rows[0] as Raw | undefined;

    return row ? mapPatch(row) : null;
  }

  /**
   * Guarded pull-request state change. `from` lists the states the row must
   * currently be in, so a duplicate or late job cannot move it backwards.
   */
  async function updatePullRequest(input: {
    runId: number;
    from: PullRequestRow["state"][];
    to: PullRequestRow["state"];
    actor: string;
    prNumber?: number;
    prUrl?: string;
    headSha?: string;
    errorCode?: string;
    errorDetail?: string;
  }): Promise<PullRequestRow | null> {
    assertActor(input.actor);

    return withTx(async (tx) => {
      const run = await lockRun(tx, input.runId);
      const result = await tx.query(
        `UPDATE rp_pull_requests SET state = $3, pr_number = COALESCE($4, pr_number), pr_url = COALESCE($5, pr_url),
           head_sha = COALESCE($6, head_sha), error_code = $7, error_detail = $8, updated_at = now()
         WHERE run_id = $1 AND state = ANY($2) RETURNING *`,
        [input.runId, input.from, input.to, input.prNumber ?? null, input.prUrl ?? null, input.headSha ?? null, input.errorCode ?? null, input.errorDetail === undefined ? null : redactSensitive(input.errorDetail).slice(0, 1000)]
      );
      const row = result.rows[0] as Raw | undefined;

      if (!row) {
        return null;
      }

      await appendAudit(tx, {
        runId: run.id,
        owner: run.owner,
        actor: input.actor,
        event: `pr_${input.to}`,
        detail: { ...(input.prNumber ? { prNumber: input.prNumber } : {}), ...(input.prUrl ? { prUrl: input.prUrl } : {}), ...(input.errorCode ? { code: input.errorCode } : {}) },
      });

      return mapPr(row);
    });
  }

  // -------------------------------------------------------------- artifacts

  /** Index an object written outside a stage transaction (e.g. a verification log). */
  async function indexArtifact(runId: number, input: ArtifactInput): Promise<ArtifactRow> {
    const result = await db.query(
      `INSERT INTO rp_artifacts (run_id, patch_id, kind, object_key, bytes, sha256) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (object_key) DO UPDATE SET bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256 RETURNING *`,
      [runId, input.patchId ?? null, input.kind, input.objectKey, input.bytes, input.sha256]
    );

    return mapArtifact(result.rows[0] as Raw);
  }

  async function listArtifacts(owner: string, runId: number): Promise<ArtifactRow[]> {
    const result = await db.query(
      `SELECT a.* FROM rp_artifacts a JOIN rp_runs r ON r.id = a.run_id WHERE a.run_id = $1 AND r.owner = $2 ORDER BY a.id`,
      [runId, owner]
    );

    return (result.rows as Raw[]).map(mapArtifact);
  }

  async function getArtifact(owner: string, runId: number, artifactId: number): Promise<ArtifactRow | null> {
    const result = await db.query(
      `SELECT a.* FROM rp_artifacts a JOIN rp_runs r ON r.id = a.run_id WHERE a.id = $1 AND a.run_id = $2 AND r.owner = $3`,
      [artifactId, runId, owner]
    );
    const row = result.rows[0] as Raw | undefined;

    return row ? mapArtifact(row) : null;
  }

  // ------------------------------------------------------------ credentials

  /** Store provider-key CIPHERTEXT. The plaintext never reaches this module. */
  async function putCredential(input: { owner: string; actor: string; provider: string; ciphertext: string; fingerprint: string }): Promise<void> {
    assertActor(input.actor);

    if (!isUserActor(input.actor)) {
      throw new RepoPilotError("invalid_actor", "only a user can configure credentials");
    }

    if (!/^[a-z]{3,20}$/.test(input.provider) || !/^[0-9a-f]{16}$/.test(input.fingerprint) || input.ciphertext.length < 20 || input.ciphertext.length > 4096) {
      throw new RepoPilotError("invalid_input", "invalid credential record");
    }

    await withTx(async (tx) => {
      await tx.query(
        `INSERT INTO rp_credentials (owner, provider, ciphertext, fingerprint, created_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (owner, provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, fingerprint = EXCLUDED.fingerprint, created_by = EXCLUDED.created_by, updated_at = now()`,
        [input.owner, input.provider, input.ciphertext, input.fingerprint, input.actor]
      );
      await appendAudit(tx, { runId: null, owner: input.owner, actor: input.actor, event: "credential_set", detail: { provider: input.provider, fingerprint: input.fingerprint } });
    });
  }

  async function deleteCredential(owner: string, actor: string, provider: string): Promise<boolean> {
    assertActor(actor);

    return withTx(async (tx) => {
      const result = await tx.query("DELETE FROM rp_credentials WHERE owner = $1 AND provider = $2", [owner, provider]);

      if ((result.rowCount ?? 0) > 0) {
        await appendAudit(tx, { runId: null, owner, actor, event: "credential_deleted", detail: { provider } });
      }

      return (result.rowCount ?? 0) > 0;
    });
  }

  /** Metadata only: never the ciphertext, never the key. */
  async function listCredentials(owner: string): Promise<Array<{ provider: string; fingerprint: string; updatedAt: Date }>> {
    const result = await db.query("SELECT provider, fingerprint, updated_at FROM rp_credentials WHERE owner = $1 ORDER BY provider", [owner]);

    return (result.rows as Raw[]).map((r) => ({ provider: r.provider as string, fingerprint: r.fingerprint as string, updatedAt: r.updated_at as Date }));
  }

  /** Worker-only: the sealed credential for a run's owner. */
  async function readCredentialCiphertext(owner: string, provider: string): Promise<string | null> {
    const result = await db.query("SELECT ciphertext FROM rp_credentials WHERE owner = $1 AND provider = $2", [owner, provider]);

    return ((result.rows[0] as Raw | undefined)?.ciphertext as string | undefined) ?? null;
  }

  // ---------------------------------------------------------------- metrics

  /** Operational counters. Counts and codes only: no repository content. */
  async function metrics(): Promise<{
    runsByState: Record<string, number>;
    activeRuns: number;
    oldestActiveRunAgeSec: number | null;
    runningStages: number;
    stageFailures24h: Array<{ stage: string; code: string; count: number }>;
    aiRequests24h: number;
  }> {
    const [states, oldest, running, failures, ai] = await Promise.all([
      db.query("SELECT state, count(*)::int AS n FROM rp_runs GROUP BY state"),
      db.query("SELECT extract(epoch FROM now() - min(created_at))::int AS age FROM rp_runs WHERE state NOT IN ('pr_opened','failed','cancelled')"),
      db.query("SELECT count(*)::int AS n FROM rp_stages WHERE state = 'running'"),
      db.query("SELECT stage, COALESCE(error_code, 'unknown') AS code, count(*)::int AS n FROM rp_stages WHERE state = 'failed' AND finished_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY n DESC LIMIT 20"),
      db.query("SELECT COALESCE(sum(ai_requests), 0)::int AS n FROM rp_runs WHERE updated_at > now() - interval '24 hours'"),
    ]);
    const runsByState: Record<string, number> = {};

    for (const row of states.rows as Raw[]) runsByState[row.state as string] = Number(row.n);

    const active = Object.entries(runsByState).filter(([state]) => !["pr_opened", "failed", "cancelled"].includes(state)).reduce((sum, [, n]) => sum + n, 0);

    return {
      runsByState,
      activeRuns: active,
      oldestActiveRunAgeSec: (oldest.rows[0] as Raw | undefined)?.age === null || (oldest.rows[0] as Raw | undefined)?.age === undefined ? null : Number((oldest.rows[0] as Raw).age),
      runningStages: Number((running.rows[0] as Raw).n),
      stageFailures24h: (failures.rows as Raw[]).map((r) => ({ stage: r.stage as string, code: r.code as string, count: Number(r.n) })),
      aiRequests24h: Number((ai.rows[0] as Raw).n),
    };
  }

  // -------------------------------------------------------------- retention

  /**
   * Remove bulky run evidence older than `days`: log rows and artifact index
   * rows (the caller deletes the objects). Runs, findings, patches, outcomes
   * and the audit history are NEVER removed here.
   */
  async function pruneEvidence(days: number): Promise<{ logRows: number; artifactKeys: string[] }> {
    if (!Number.isInteger(days) || days < 1) {
      throw new RepoPilotError("invalid_input", "days must be a positive integer");
    }

    return withTx(async (tx) => {
      const finished = "r.finished_at IS NOT NULL AND r.finished_at < now() - ($1::int * interval '1 day')";
      const logs = await tx.query(`DELETE FROM rp_logs l USING rp_runs r WHERE l.run_id = r.id AND ${finished}`, [days]);
      const artifacts = await tx.query(`DELETE FROM rp_artifacts a USING rp_runs r WHERE a.run_id = r.id AND ${finished} RETURNING a.object_key`, [days]);

      return { logRows: logs.rowCount ?? 0, artifactKeys: (artifacts.rows as Raw[]).map((r) => r.object_key as string) };
    });
  }

  return {
    withTx,
    appendAudit,
    verifyAuditChain,
    listAudit,
    recordOwnerEvent,
    recordRunEvent,
    authorizeRepository,
    revokeRepository,
    isRepositoryAuthorized,
    listRepositories,
    createRun,
    getRun,
    listRuns,
    requestCancel,
    isCancelRequested,
    listStages,
    beginStage,
    touchStage,
    completeStage,
    failStage,
    failRun,
    latestStageParams,
    recoverStaleStages,
    findIdleRuns,
    reserveAiRequest,
    recordAiUsage,
    appendLog,
    listLogs,
    listFindings,
    getFinding,
    listPatches,
    getPatch,
    getPatchById,
    latestValidPatch,
    recordVerification,
    listVerifications,
    listOutcomes,
    authorizePullRequest,
    getPullRequest,
    getPullRequestForRun,
    updatePullRequest,
    indexArtifact,
    listArtifacts,
    getArtifact,
    putCredential,
    deleteCredential,
    listCredentials,
    readCredentialCiphertext,
    pruneEvidence,
    metrics,
  };
}

export type RepoPilotStore = ReturnType<typeof createRepoPilotStore>;

// ----------------------------------------------------------------- helpers

/** Stable key used to drop duplicate findings within a run. */
export function findingFingerprint(finding: Pick<Finding, "file" | "category" | "title" | "lineStart">): string {
  const normalizedTitle = finding.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  return crypto
    .createHash("sha256")
    .update([finding.file, finding.category, normalizedTitle, Math.floor(finding.lineStart / 10)].join("\0"))
    .digest("hex");
}

/** Canonical JSON (sorted keys) so a hash does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

export function auditHash(prevHash: string, chainKey: string, actor: string, event: string, detail: Record<string, unknown>, at: Date): string {
  return crypto
    .createHash("sha256")
    .update([prevHash, chainKey, actor, event, canonicalJson(detail), String(at.getTime())].join("\n"))
    .digest("hex");
}

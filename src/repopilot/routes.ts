/**
 * RepoPilot HTTP API, mounted under /repopilot by createApiApp AFTER the
 * bearer-token gate, so every route here is already authenticated.
 *
 * ShipFlow has one shared API token, so there is a single principal (the
 * instance operator). All data access still goes through `owner`-scoped
 * store calls and `resolvePrincipal` is the single place a multi-user model
 * would plug in; no route trusts an owner supplied by the client.
 *
 * Responses follow the existing API shape: { success, ... } and
 * { success: false, code, message }. Errors never echo request bodies,
 * stack traces, SQL or filesystem paths.
 */

import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";

import type { RepoPilotConfig } from "./config.js";
import { CredentialError, PROVIDERS, assertKeyShape, credentialFingerprint, isProvider, sealCredential } from "./credentials.js";
import { createRateLimiter } from "./rateLimit.js";
import type { RateLimiter, RateRule } from "./rateLimit.js";
import type { EnqueueStage } from "./queue.js";
import { redactSensitive } from "./redact.js";
import { AuthorizePrRequestSchema, GithubRepoUrlSchema, parseGithubRepoUrl } from "./schemas.js";
import { MAX_STAGE_ATTEMPTS, InvalidTransitionError } from "./states.js";
import { RepoPilotError } from "./store.js";
import type { ArtifactRow, FindingRow, OutcomeRow, PatchRow, PullRequestRow, RepoPilotStore, RunRow, StageRow, VerificationRow } from "./store.js";

export interface Principal {
  owner: string;
  /** Audit identity, always `user:<id>`. */
  actor: string;
}

export interface WorkerCapabilities {
  /** Live orchestration workers (from their heartbeats). */
  workers: number;
  github: boolean;
  /** A provider-key unsealing key is configured on a worker. */
  credentialDecryption: boolean;
  sandbox: "off" | "ready" | "unavailable";
}

export interface ArtifactReader {
  /** Read at most `maxBytes` of an object; null if it does not exist. */
  read(objectKey: string, maxBytes: number): Promise<{ body: Buffer; contentType: string } | null>;
}

export interface RepoPilotRouteDeps {
  store: RepoPilotStore;
  enqueue: EnqueueStage;
  config: RepoPilotConfig;
  capabilities: () => Promise<WorkerCapabilities>;
  artifacts?: ArtifactReader;
  /** Queue depth by state, from BullMQ. */
  queueCounts?: () => Promise<Record<string, number>>;
  resolvePrincipal?: (req: Request) => Principal;
  limiter?: RateLimiter;
}

export const DEFAULT_PRINCIPAL: Principal = { owner: "instance", actor: "user:operator" };

export const LIMITATIONS: readonly string[] = [
  "Findings are suggestions from an AI model, not confirmed defects.",
  "A patch that passes tests is not proven correct or secure; review the diff yourself.",
  "Verification only runs when a validated isolated sandbox is configured; otherwise the outcome is inconclusive.",
  "RepoPilot never merges. Opening a pull request needs your explicit authorisation of the exact diff.",
];

// ------------------------------------------------------------------ helpers

const ID = /^[1-9][0-9]{0,14}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function parseId(value: unknown): number | null {
  return typeof value === "string" && ID.test(value) ? Number(value) : null;
}

function parseRef(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !REF.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".lock")) {
    return undefined;
  }

  return value;
}

function parseLimit(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[0-9]{1,4}$/.test(value)) return null;

  const n = Number(value);

  return n >= 1 && n <= max ? n : null;
}

const STATUS_FOR: Record<RepoPilotError["code"], number> = {
  not_found: 404,
  conflict: 409,
  quota: 429,
  invalid_actor: 403,
  invalid_input: 400,
  authorization_mismatch: 409,
};

function fail(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ success: false, code, message, ...extra });
}

/** Map any thrown value to a safe response. */
function sendError(res: Response, error: unknown): void {
  if (res.headersSent) {
    return;
  }

  if (error instanceof RepoPilotError) {
    return fail(res, STATUS_FOR[error.code], error.code, error.message);
  }

  if (error instanceof InvalidTransitionError) {
    return fail(res, 409, "invalid_transition", "That action is not allowed in the run's current state");
  }

  if (error instanceof CredentialError) {
    return fail(res, 400, error.code, error.message);
  }

  if (error instanceof ZodError) {
    // Paths and messages only: never the submitted values.
    return fail(res, 400, "invalid_request", "The request is invalid", {
      issues: error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  console.error("RepoPilot route error:", redactSensitive(error instanceof Error ? `${error.name}: ${error.message}` : "unknown"));

  return fail(res, 500, "internal_error", "Internal server error");
}

// ---------------------------------------------------------------- DTO shapes

const runDto = (run: RunRow) => ({
  id: run.id,
  repo: { owner: run.repoOwner, name: run.repoName, url: run.repoUrl },
  requestedRef: run.requestedRef,
  commitSha: run.commitSha,
  defaultBranch: run.defaultBranch,
  state: run.state,
  failure: run.failureCode ? { code: run.failureCode, detail: run.failureDetail } : null,
  cancelRequested: run.cancelRequested,
  ai: { requests: run.aiRequests, inputTokens: run.aiInputTokens, outputTokens: run.aiOutputTokens },
  createdBy: run.createdBy,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  finishedAt: run.finishedAt,
});

const stageDto = (s: StageRow) => ({
  stage: s.stage,
  attempt: s.attempt,
  state: s.state,
  error: s.errorCode ? { code: s.errorCode, detail: s.errorDetail } : null,
  startedAt: s.startedAt,
  finishedAt: s.finishedAt,
});

const findingDto = (f: FindingRow) => ({
  id: f.id,
  rank: f.rank,
  title: f.title,
  category: f.category,
  severity: f.severity,
  evidenceKind: f.evidenceKind,
  file: f.file,
  lineStart: f.lineStart,
  lineEnd: f.lineEnd,
  evidence: f.evidence,
  impact: f.impact,
  remediation: f.remediation,
  // The model's own estimate, labelled as such.
  modelConfidence: f.confidence,
});

const patchDto = (p: PatchRow) => ({
  id: p.id,
  findingId: p.findingId,
  baseCommit: p.baseCommit,
  title: p.title,
  explanation: p.explanation,
  diff: p.diff,
  testDiff: p.testDiff,
  diffSha256: p.diffSha256,
  policy: { passed: p.validationOk, details: p.validation },
  createdAt: p.createdAt,
});

const verificationDto = (v: VerificationRow) => ({
  id: v.id,
  patchId: v.patchId,
  arm: v.arm,
  attempt: v.attempt,
  kind: v.kind,
  exitCode: v.exitCode,
  durationMs: v.durationMs,
  detail: v.detail,
  commitSha: v.commitSha,
  diffSha256: v.diffSha256,
  testCommand: v.testCommand,
  environment: v.environmentProfile,
  hasLog: v.logKey !== null,
  createdAt: v.createdAt,
});

const outcomeDto = (o: OutcomeRow) => ({ patchId: o.patchId, outcome: o.outcome, reasons: o.reasons, details: o.arms, computedAt: o.computedAt });

const prDto = (p: PullRequestRow) => ({
  id: p.id,
  patchId: p.patchId,
  state: p.state,
  authorizedBy: p.authorizedBy,
  authorizedAt: p.authorizedAt,
  authorizedDiffSha256: p.authorizedDiffSha256,
  authorizedOutcome: p.authorizedOutcome,
  baseBranch: p.baseBranch,
  baseSha: p.baseSha,
  branch: p.branchName,
  number: p.prNumber,
  url: p.prUrl,
  headSha: p.headSha,
  error: p.errorCode ? { code: p.errorCode, detail: p.errorDetail } : null,
  updatedAt: p.updatedAt,
});

const artifactDto = (a: ArtifactRow) => ({ id: a.id, kind: a.kind, patchId: a.patchId, bytes: a.bytes, sha256: a.sha256, createdAt: a.createdAt });

export const MAX_ARTIFACT_DOWNLOAD_BYTES = 2 * 1024 * 1024;

// -------------------------------------------------------------------- router

export function createRepoPilotRouter(deps: RepoPilotRouteDeps): Router {
  const { store, enqueue, config } = deps;
  const limiter = deps.limiter ?? createRateLimiter();
  const principalOf = deps.resolvePrincipal ?? (() => DEFAULT_PRINCIPAL);
  const router = Router();

  const limit = (cls: "read" | "write" | "credentials"): RequestHandler => (req, res, next) => {
    const rule: RateRule = config.rateLimits[cls];
    const decision = limiter.hit(`${principalOf(req).owner}:${cls}`, rule);

    res.setHeader("RateLimit-Remaining", String(decision.remaining));

    if (!decision.ok) {
      res.setHeader("Retry-After", String(decision.retryAfterSec));

      return fail(res, 429, "rate_limited", "Too many requests; slow down", { retryAfterSec: decision.retryAfterSec });
    }

    return next();
  };

  const handle = (fn: (req: Request, res: Response, who: Principal) => Promise<void>): RequestHandler => (req, res) => {
    fn(req, res, principalOf(req)).catch((error: unknown) => sendError(res, error));
  };

  /** Run id from the path, 400 if malformed. */
  const runIdOf = (req: Request, res: Response): number | null => {
    const id = parseId(req.params.runId);

    if (id === null) fail(res, 400, "invalid_id", "Invalid run id");

    return id;
  };

  // ---------------------------------------------------------------- status

  router.get("/status", limit("read"), handle(async (_req, res, who) => {
    const caps = await deps.capabilities();
    const credentials = await store.listCredentials(who.owner);

    res.json({
      success: true,
      enabled: true,
      workers: caps.workers,
      github: { configured: caps.github },
      ai: { providers: PROVIDERS, configured: credentials.map((c) => c.provider), credentialEncryption: config.credentialPublicKey !== null, workerCanDecrypt: caps.credentialDecryption },
      sandbox: { mode: config.sandboxMode, status: caps.sandbox, note: caps.sandbox === "ready" ? "Verification runs in the configured isolated sandbox." : "Verification is not running: patches will be reported as inconclusive." },
      limits: { maxActiveRuns: config.limits.maxActiveRuns, maxAiRequestsPerRun: config.limits.maxAiRequestsPerRun, maxSnapshotFiles: config.limits.maxSnapshotFiles },
      problems: config.problems,
      limitations: LIMITATIONS,
    });
  }));

  // --------------------------------------------------------------- metrics

  router.get("/metrics", limit("read"), handle(async (_req, res) => {
    const [metrics, queue] = await Promise.all([store.metrics(), deps.queueCounts ? deps.queueCounts().catch(() => null) : Promise.resolve(null)]);

    res.json({ success: true, ...metrics, queue });
  }));

  // ---------------------------------------------------------- repositories

  router.get("/repositories", limit("read"), handle(async (_req, res, who) => {
    res.json({ success: true, repositories: await store.listRepositories(who.owner) });
  }));

  router.post("/repositories", limit("write"), handle(async (req, res, who) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseGithubRepoUrl(body.repoUrl);

    if (!parsed.ok || Object.keys(body).some((k) => k !== "repoUrl")) {
      return fail(res, 400, "invalid_request", "Provide only repoUrl, like https://github.com/<owner>/<repo>");
    }

    await store.authorizeRepository(who.owner, who.actor, parsed.value);
    res.status(201).json({ success: true, repository: { owner: parsed.value.owner, name: parsed.value.name } });
  }));

  router.delete("/repositories/:repoOwner/:repoName", limit("write"), handle(async (req, res, who) => {
    const parsed = parseGithubRepoUrl(`https://github.com/${String(req.params.repoOwner)}/${String(req.params.repoName)}`);

    if (!parsed.ok) {
      return fail(res, 400, "invalid_request", "Invalid repository");
    }

    const removed = await store.revokeRepository(who.owner, who.actor, parsed.value);
    res.status(removed ? 200 : 404).json(removed ? { success: true } : { success: false, code: "not_found", message: "Repository is not authorised" });
  }));

  // ----------------------------------------------------------- credentials

  router.get("/credentials", limit("read"), handle(async (_req, res, who) => {
    // Metadata only: provider, fingerprint, timestamp.
    res.json({ success: true, credentials: await store.listCredentials(who.owner) });
  }));

  router.put("/credentials/:provider", limit("credentials"), handle(async (req, res, who) => {
    const provider: unknown = req.params.provider;

    if (!isProvider(provider)) {
      return fail(res, 400, "unsupported_provider", `Supported providers: ${PROVIDERS.join(", ")}`);
    }

    if (!config.credentialPublicKey) {
      return fail(res, 503, "credential_encryption_not_configured", "Set REPOPILOT_CREDENTIAL_PUBLIC_KEY (and the private key on the worker) before storing provider keys. See docs/repopilot.md.");
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    if (Object.keys(body).some((k) => k !== "apiKey")) {
      return fail(res, 400, "invalid_request", "Provide only apiKey");
    }

    assertKeyShape(provider, body.apiKey);
    await store.putCredential({
      owner: who.owner,
      actor: who.actor,
      provider,
      ciphertext: sealCredential(config.credentialPublicKey, body.apiKey),
      fingerprint: credentialFingerprint(body.apiKey),
    });

    // The response never contains the key.
    res.status(200).json({ success: true, provider });
  }));

  router.delete("/credentials/:provider", limit("credentials"), handle(async (req, res, who) => {
    const provider: unknown = req.params.provider;

    if (!isProvider(provider)) {
      return fail(res, 400, "unsupported_provider", `Supported providers: ${PROVIDERS.join(", ")}`);
    }

    const removed = await store.deleteCredential(who.owner, who.actor, provider);
    res.status(removed ? 200 : 404).json(removed ? { success: true } : { success: false, code: "not_found", message: "No credential stored" });
  }));

  // ------------------------------------------------------------------ runs

  router.post("/runs", limit("write"), handle(async (req, res, who) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (Object.keys(body).some((k) => k !== "repoUrl" && k !== "ref")) {
      return fail(res, 400, "invalid_request", "Provide only repoUrl and optionally ref");
    }

    const repo = GithubRepoUrlSchema.parse(body.repoUrl);
    const ref = parseRef(body.ref);

    if (ref === undefined) {
      return fail(res, 400, "invalid_request", "ref must be a branch, tag or commit name");
    }

    const key = req.get("idempotency-key");

    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
      return fail(res, 400, "invalid_request", "Idempotency-Key must be 8-100 characters of A-Z a-z 0-9 . _ -");
    }

    if (!(await store.isRepositoryAuthorized(who.owner, repo))) {
      return fail(res, 403, "repository_not_authorized", "Authorise this repository for RepoPilot first (POST /repopilot/repositories)");
    }

    const { run, created } = await store.createRun({ owner: who.owner, actor: who.actor, repo, requestedRef: ref, idempotencyKey: key ?? null });

    if (created) {
      try {
        await enqueue({ runId: run.id, stage: "ingest", attempt: 1 });
      } catch {
        await store.failRun(run.id, "system", "enqueue_failed", "The run could not be queued");

        return fail(res, 503, "queue_unavailable", "The job queue is unavailable; try again shortly");
      }
    }

    res.status(created ? 202 : 200).json({ success: true, created, run: runDto(run) });
  }));

  router.get("/runs", limit("read"), handle(async (req, res, who) => {
    const limitN = parseLimit(req.query.limit, 50, 200);
    const before = req.query.before === undefined ? undefined : parseId(req.query.before);

    if (limitN === null || before === null) {
      return fail(res, 400, "invalid_request", "limit must be 1-200 and before a positive id");
    }

    const runs = await store.listRuns(who.owner, { limit: limitN, ...(before === undefined ? {} : { beforeId: before }) });
    res.json({ success: true, runs: runs.map(runDto) });
  }));

  router.get("/runs/:runId", limit("read"), handle(async (req, res, who) => {
    const id = runIdOf(req, res);
    if (id === null) return;

    const run = await store.getRun(who.owner, id);

    if (!run) {
      return fail(res, 404, "not_found", "Run not found");
    }

    const [stages, findings, patches, outcomes, pullRequest] = await Promise.all([
      store.listStages(who.owner, id), store.listFindings(who.owner, id), store.listPatches(who.owner, id), store.listOutcomes(who.owner, id), store.getPullRequest(who.owner, id),
    ]);

    res.json({
      success: true,
      run: runDto(run),
      stages: stages.map(stageDto),
      counts: { findings: findings.length, patches: patches.length },
      outcomes: outcomes.map(outcomeDto),
      pullRequest: pullRequest ? prDto(pullRequest) : null,
      limitations: LIMITATIONS,
    });
  }));

  router.post("/runs/:runId/cancel", limit("write"), handle(async (req, res, who) => {
    const id = runIdOf(req, res);
    if (id === null) return;

    const { run, cancelledNow } = await store.requestCancel(who.owner, id, who.actor);
    res.status(202).json({ success: true, cancelledNow, run: runDto(run) });
  }));

  // ------------------------------------------------------------- read views

  const ownedRun = async (req: Request, res: Response, who: Principal): Promise<number | null> => {
    const id = runIdOf(req, res);
    if (id === null) return null;

    if (!(await store.getRun(who.owner, id))) {
      fail(res, 404, "not_found", "Run not found");

      return null;
    }

    return id;
  };

  router.get("/runs/:runId/findings", limit("read"), handle(async (req, res, who) => {
    const id = await ownedRun(req, res, who);
    if (id === null) return;

    res.json({ success: true, findings: (await store.listFindings(who.owner, id)).map(findingDto), notice: LIMITATIONS[0] });
  }));

  router.get("/runs/:runId/patches", limit("read"), handle(async (req, res, who) => {
    const id = await ownedRun(req, res, who);
    if (id === null) return;

    res.json({ success: true, patches: (await store.listPatches(who.owner, id)).map(patchDto) });
  }));

  router.get("/runs/:runId/patches/:patchId", limit("read"), handle(async (req, res, who) => {
    const id = runIdOf(req, res);
    const patchId = parseId(req.params.patchId);

    if (id === null) return;
    if (patchId === null) return fail(res, 400, "invalid_id", "Invalid patch id");

    const patch = await store.getPatch(who.owner, id, patchId);

    if (!patch) return fail(res, 404, "not_found", "Patch not found");

    res.json({ success: true, patch: patchDto(patch) });
  }));

  router.get("/runs/:runId/verifications", limit("read"), handle(async (req, res, who) => {
    const id = await ownedRun(req, res, who);
    if (id === null) return;

    const [verifications, outcomes] = await Promise.all([store.listVerifications(who.owner, id), store.listOutcomes(who.owner, id)]);
    res.json({ success: true, verifications: verifications.map(verificationDto), outcomes: outcomes.map(outcomeDto), notice: LIMITATIONS[1] });
  }));

  router.get("/runs/:runId/logs", limit("read"), handle(async (req, res, who) => {
    const id = await ownedRun(req, res, who);
    if (id === null) return;

    const afterRaw = req.query.after;
    const after = afterRaw === undefined ? 0 : parseId(afterRaw);
    const limitN = parseLimit(req.query.limit, 500, 1000);

    if (after === null || limitN === null) {
      return fail(res, 400, "invalid_request", "after must be a positive id and limit 1-1000");
    }

    const logs = await store.listLogs(who.owner, id, { afterId: after, limit: limitN });
    res.json({ success: true, logs: logs.map((l) => ({ id: l.id, stage: l.stage, level: l.level, message: l.message, at: l.createdAt })) });
  }));

  router.get("/runs/:runId/audit", limit("read"), handle(async (req, res, who) => {
    const id = await ownedRun(req, res, who);
    if (id === null) return;

    const events = await store.listAudit(who.owner, id);
    res.json({ success: true, events: events.map((e) => ({ id: e.id, actor: e.actor, event: e.event, detail: e.detail, at: e.at })), chain: await store.verifyAuditChain(`run:${id}`) });
  }));

  router.get("/runs/:runId/artifacts", limit("read"), handle(async (req, res, who) => {
    const id = await ownedRun(req, res, who);
    if (id === null) return;

    res.json({ success: true, artifacts: (await store.listArtifacts(who.owner, id)).map(artifactDto) });
  }));

  router.get("/runs/:runId/artifacts/:artifactId", limit("read"), handle(async (req, res, who) => {
    const id = runIdOf(req, res);
    const artifactId = parseId(req.params.artifactId);

    if (id === null) return;
    if (artifactId === null) return fail(res, 400, "invalid_id", "Invalid artifact id");

    const artifact = await store.getArtifact(who.owner, id, artifactId);

    if (!artifact) return fail(res, 404, "not_found", "Artifact not found");
    if (!deps.artifacts) return fail(res, 503, "artifacts_unavailable", "Artifact storage is not available");
    if (artifact.bytes > MAX_ARTIFACT_DOWNLOAD_BYTES) return fail(res, 413, "too_large", "Artifact is too large to download here");

    // The object key comes from our own table, never from the request.
    const object = await deps.artifacts.read(artifact.objectKey, MAX_ARTIFACT_DOWNLOAD_BYTES);

    if (!object) return fail(res, 404, "not_found", "Artifact content has been removed");

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="repopilot-${artifact.kind.replace(/[^A-Za-z0-9._-]/g, "_")}-${artifact.id}.txt"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(object.body);
  }));

  // -------------------------------------------------------------- patching

  router.post("/runs/:runId/findings/:findingId/patch", limit("write"), handle(async (req, res, who) => {
    const id = runIdOf(req, res);
    const findingId = parseId(req.params.findingId);

    if (id === null) return;
    if (findingId === null) return fail(res, 400, "invalid_id", "Invalid finding id");

    const run = await store.getRun(who.owner, id);

    if (!run) return fail(res, 404, "not_found", "Run not found");
    if (run.state !== "awaiting_patch") return fail(res, 409, "invalid_state", `A patch can only be requested while the run is awaiting_patch (it is ${run.state})`);
    if (!(await store.getFinding(who.owner, id, findingId))) return fail(res, 404, "not_found", "Finding not found");

    const credentials = await store.listCredentials(who.owner);

    if (!credentials.some((c) => c.provider === "anthropic")) {
      return fail(res, 409, "ai_credentials_missing", "Add your own AI provider key first (PUT /repopilot/credentials/anthropic). ShipFlow never uses an operator's key for your runs.");
    }

    const attempts = (await store.listStages(who.owner, id)).filter((s) => s.stage === "patch").reduce((max, s) => Math.max(max, s.attempt), 0);

    if (attempts >= MAX_STAGE_ATTEMPTS.patch) {
      return fail(res, 409, "patch_attempts_exhausted", `This run has used its ${MAX_STAGE_ATTEMPTS.patch} patch attempts`);
    }

    await store.recordRunEvent(who.owner, id, who.actor, "patch_requested", { findingId });

    try {
      await enqueue({ runId: id, stage: "patch", attempt: attempts + 1, findingId });
    } catch {
      return fail(res, 503, "queue_unavailable", "The job queue is unavailable; try again shortly");
    }

    res.status(202).json({ success: true, attempt: attempts + 1 });
  }));

  // ---------------------------------------------------------- pull requests

  router.post("/runs/:runId/pull-request", limit("write"), handle(async (req, res, who) => {
    const id = runIdOf(req, res);
    if (id === null) return;

    // Strict: exact patch, digest, base commit and the outcome the human saw.
    const request = AuthorizePrRequestSchema.parse(req.body);
    const { run, pullRequest } = await store.authorizePullRequest({ owner: who.owner, runId: id, actor: who.actor, request });

    try {
      await enqueue({ runId: id, stage: "pr", attempt: 1 });
    } catch {
      // Authorised and recorded; the recovery pass queues the stage.
      return void res.status(202).json({ success: true, queued: false, run: runDto(run), pullRequest: prDto(pullRequest), message: "Authorised; the pull request will be opened shortly." });
    }

    res.status(202).json({ success: true, queued: true, run: runDto(run), pullRequest: prDto(pullRequest) });
  }));

  router.get("/runs/:runId/pull-request", limit("read"), handle(async (req, res, who) => {
    const id = await ownedRun(req, res, who);
    if (id === null) return;

    const pr = await store.getPullRequest(who.owner, id);
    res.json({ success: true, pullRequest: pr ? prDto(pr) : null });
  }));

  return router;
}

/** Served instead of the router when RepoPilot is disabled. */
export function createDisabledRepoPilotRouter(config: Pick<RepoPilotConfig, "problems">): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({
      success: true,
      enabled: false,
      message: "RepoPilot is disabled. Set REPOPILOT=enabled on the API and worker to turn it on. See docs/repopilot.md.",
      problems: config.problems,
      limitations: LIMITATIONS,
    });
  });

  router.use((_req, res) => {
    fail(res, 404, "repopilot_disabled", "RepoPilot is disabled on this server");
  });

  return router;
}

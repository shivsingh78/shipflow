import express from "express";
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import crypto from "crypto";
import { pipeline } from "stream/promises";

import {
  isValidReleaseId,
  validateRepoUrl,
  safeRelativePath,
} from "./validation.js";
import { errorMessage } from "./errors.js";
import type { Config } from "./config.js";
import type { ArtifactBody } from "./artifactStore.js";
import { buildEvidence } from "./evidence.js";
import { mountDashboard } from "./dashboard.js";
import type { SecretStore } from "./secrets.js";
import type { ReleaseRow, CreateReleaseInput, ReleaseUpdates } from "./releaseStore.js";
import type { ProjectRow, ProjectSummaryRow } from "./projectStore.js";
import type { ReleaseLogRow } from "./logStore.js";
import type { NotificationRow } from "./notify.js";
import type { RollbackResult } from "./rollback.js";
import type { TargetCheck, TargetSummary } from "./targets/types.js";
import type { ProjectConfig } from "../cli/lib/projectConfig.js";

/** Where artifact bytes are read from (a view of the artifact store). */
export interface ApiStorage {
  getObject(key: string): Promise<ArtifactBody>;
  isNotFoundError(error: unknown): boolean;
  describe?(): string;
}

export interface ApiReleases {
  createRelease(input: CreateReleaseInput): Promise<ReleaseRow | undefined>;
  getRelease(releaseId: string): Promise<ReleaseRow | undefined>;
  getAllReleases(limit: number, project: string | null): Promise<ReleaseRow[]>;
  updateRelease(releaseId: string, updates: ReleaseUpdates): Promise<ReleaseRow | undefined>;
  requestCancel(releaseId: string): Promise<ReleaseRow | undefined>;
  transitionRelease(
    releaseId: string,
    from: string[],
    to: string,
    errorMessage?: string | null
  ): Promise<ReleaseRow | undefined>;
}

export interface ApiProjects {
  upsertProject(config: ProjectConfig): Promise<ProjectRow | undefined>;
  getProject(name: string): Promise<ProjectRow | undefined>;
  listProjects(): Promise<ProjectSummaryRow[]>;
}

export interface SiteProjects {
  resolveSiteProject?(
    hostname: string | null | undefined,
    fallbackProject: string | null | undefined
  ): Promise<string | null | undefined>;
}

export interface ActivationLookup {
  getActiveReleaseId(project?: string): Promise<string | null>;
}

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: unknown;
}

export interface EnqueueReleaseInput {
  repoUrl: string;
  project?: string;
  mode?: string;
  ref?: string | null;
  trigger?: string;
  target?: string;
  config?: ProjectConfig | null;
}

export type EnqueueRelease = (input: EnqueueReleaseInput) => Promise<ReleaseRow>;

export interface ApiAppDeps {
  config: Pick<Config, "apiToken" | "instance" | "allowedRepoPrefixes" | "maxQueuedReleases">;
  releases: ApiReleases;
  projects?: ApiProjects;
  logs: { getReleaseLogs(releaseId: string): Promise<ReleaseLogRow[]> };
  notifications: { getReleaseNotifications(releaseId: string): Promise<NotificationRow[]> };
  queue: {
    getJobCounts(...types: string[]): Promise<Record<string, number>>;
    add(name: string, data: { releaseId: string }, options: object): Promise<unknown>;
    getJob(jobId: string): Promise<{ remove(): Promise<unknown> } | undefined>;
  };
  activation: ActivationLookup;
  rollback: { rollbackRelease(releaseId: string): Promise<RollbackResult> };
  storage: ApiStorage;
  secrets: SecretStore;
  healthCheck: () => Promise<unknown>;
  readiness: () => Promise<ReadinessCheck[]>;
  generateId: () => string;
  validateProjectConfig: (input: unknown) => ProjectConfig;
  requiredSecrets: (config: ProjectConfig) => string[];
  targets?: () => TargetSummary[];
  webhookHandler?: RequestHandler | null;
  checkTarget: (project: ProjectRow) => Promise<TargetCheck[]>;
  /** Built dashboard (ui/dist) to serve under /ui; absent or null = API only. */
  dashboardDir?: string | null;
}

export interface SiteAppDeps {
  releases: Pick<ApiReleases, "getRelease">;
  activation: ActivationLookup;
  storage: ApiStorage;
  projects?: SiteProjects;
  siteDefaultProject?: string | null;
}

/** Fields the error handler reads off errors thrown by routes and middleware. */
interface HttpErrorLike {
  type?: string;
  statusCode?: number;
  message?: string;
  errors?: unknown;
}

function digest(value: unknown) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

/**
 * Bearer-token auth. Hashing both sides gives equal-length buffers for a
 * constant-time comparison.
 */
export function requireToken(token: string): RequestHandler {
  const expected = digest(token);

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") || "";
    const match = header.match(/^Bearer (.+)$/);

    if (!match || !crypto.timingSafeEqual(digest(match[1]), expected)) {
      return res.status(401).json({
        success: false,
        message: "Missing or invalid API token",
      });
    }

    return next();
  };
}

function lastSegmentHasExtension(relativePath: string) {
  return (relativePath.split("/").pop() || "").includes(".");
}

/**
 * Stream one file of a release artifact from storage.
 * Directory paths fall back to their index.html and extension-less paths
 * fall back to the root index.html (single-page apps).
 */
export async function serveReleaseFile({
  res,
  storage,
  releaseId,
  artifactPath,
  requestedPath,
}: {
  res: Response;
  storage: Pick<ApiStorage, "getObject" | "isNotFoundError">;
  releaseId: string;
  artifactPath: string;
  requestedPath: string;
}) {
  const relativePath = safeRelativePath(requestedPath);

  if (relativePath === null) {
    return res.status(400).send("Invalid path");
  }

  const candidates = [relativePath];

  if (!lastSegmentHasExtension(relativePath)) {
    candidates.push(`${relativePath}/index.html`, "index.html");
  }

  for (const candidate of candidates) {
    let object: ArtifactBody;

    try {
      object = await storage.getObject(`${artifactPath}/${candidate}`);
    } catch (error) {
      if (storage.isNotFoundError(error)) {
        continue;
      }

      throw error;
    }

    res.setHeader(
      "Content-Type",
      object.ContentType || "application/octet-stream"
    );
    res.setHeader("X-ShipFlow-Release", releaseId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-cache");

    if (object.ContentLength !== undefined) {
      res.setHeader("Content-Length", object.ContentLength);
    }

    await pipeline(object.Body, res);
    return;
  }

  return res.status(404).send("Not found");
}

const jsonErrorHandler: ErrorRequestHandler = (
  caught: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  if (res.headersSent) {
    return next(caught);
  }

  // Errors are arbitrary values; only these optional fields are read.
  const error = caught as HttpErrorLike;

  if (error.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      message: "Request body must be valid JSON",
    });
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "Request body is too large",
    });
  }

  // Expected, user-facing errors (validation, conflicts, missing secrets).
  if (error.statusCode && error.statusCode < 600) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      ...(error.errors ? { errors: error.errors } : {}),
    });
  }

  console.error(error);

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
};

/** True for errors carrying the given `code` (e.g. a Postgres SQLSTATE). */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * The control API (port 8000). Everything except /health and the signed
 * GitHub webhook needs the bearer token.
 */
export function createApiApp(deps: ApiAppDeps) {
  const {
    config,
    releases,
    // Absent in some embeddings; routes that need it fail as before.
    projects = {} as ApiProjects,
    logs,
    notifications,
    queue,
    activation,
    rollback,
    storage,
    secrets,
    healthCheck,
    readiness,
    generateId,
    validateProjectConfig,
    requiredSecrets,
    targets,
    webhookHandler,
    checkTarget,
  } = deps;

  const app = express();
  app.disable("x-powered-by");

  app.get("/health", async (_req, res) => {
    try {
      await healthCheck();
      return res.status(200).json({ success: true, status: "ok" });
    } catch {
      return res.status(503).json({ success: false, status: "unavailable" });
    }
  });

  // Webhooks authenticate with an HMAC over the raw body, not the token.
  if (webhookHandler) {
    app.post(
      "/webhooks/github",
      express.raw({ type: "*/*", limit: "1mb" }),
      webhookHandler
    );
  }

  // The dashboard shell is public static content; its API calls are not.
  if (deps.dashboardDir) mountDashboard(app, deps.dashboardDir);

  app.use(express.json({ limit: "64kb" }));
  app.use(requireToken(config.apiToken));

  // Release IDs and project names are validated once for every route.
  app.param("releaseId", (_req, res, next, releaseId: string) => {
    if (!isValidReleaseId(releaseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid release ID",
      });
    }

    return next();
  });

  app.param("project", (_req, res, next, project: string) => {
    if (!PROJECT_NAME.test(project)) {
      return res.status(400).json({ success: false, message: "Invalid project name" });
    }

    return next();
  });

  const activeFor = async (rows: Pick<ReleaseRow, "project">[]) => {
    const names = [...new Set(rows.map((row) => row.project ?? "default"))];
    const entries = await Promise.all(
      names.map(async (name): Promise<[string, string | null]> => [
        name,
        await activation.getActiveReleaseId(name),
      ])
    );
    return Object.fromEntries(entries);
  };

  const withActiveFlag = (release: ReleaseRow, active: Record<string, string | null>) => ({
    ...release,
    is_active: release.release_id === active[release.project ?? "default"],
  });

  /**
   * Create a release row and queue it. Shared by CLI deploys and webhooks.
   */
  async function enqueueRelease({
    repoUrl,
    project = "default",
    mode = "deploy",
    ref = null,
    trigger = "cli",
    target = "shipflow",
    config: releaseConfig = null,
  }: EnqueueReleaseInput): Promise<ReleaseRow> {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
    const pending = Object.values(counts).reduce((a, b) => a + b, 0);

    if (pending >= config.maxQueuedReleases) {
      throw httpError(429, `Too many releases in progress (${pending}); try again later`);
    }

    const releaseId = generateId();

    const release = await releases.createRelease({
      releaseId,
      repoUrl,
      status: "QUEUED",
      currentStage: "RELEASE",
      project,
      mode,
      ref,
      trigger,
      target,
      config: releaseConfig,
    });

    try {
      await queue.add(
        "deployment",
        { releaseId },
        {
          jobId: releaseId,
          removeOnComplete: 100,
          removeOnFail: 100,
        }
      );
    } catch (error) {
      await releases.updateRelease(releaseId, {
        status: "FAILED",
        errorMessage: "Failed to queue release",
      });
      throw error;
    }

    // INSERT ... RETURNING always yields the new row.
    return release as ReleaseRow;
  }

  app.locals.enqueueRelease = enqueueRelease;

  app.get("/whoami", async (_req, res) => {
    res.json({
      success: true,
      instance: config.instance,
      targets: targets?.() ?? [],
      artifactStore: storage.describe?.() ?? null,
      secretsEnabled: Boolean(secrets?.enabled),
      githubWebhooks: Boolean(webhookHandler),
      allowedRepoPrefixes: config.allowedRepoPrefixes,
    });
  });

  app.get("/ready", async (_req, res) => {
    const checks = await readiness();
    const ok = checks.every((check) => check.ok);
    res.status(ok ? 200 : 503).json({ success: ok, checks });
  });

  // ------------------------------------------------------------ projects

  app.get("/projects", async (_req, res) => {
    res.json({ success: true, projects: await projects.listProjects() });
  });

  app.get("/projects/:project", async (req, res) => {
    const project = await projects.getProject(req.params.project);

    if (!project) {
      throw httpError(404, `Project ${req.params.project} not found`);
    }

    res.json({
      success: true,
      project,
      activeReleaseId: await activation.getActiveReleaseId(project.name),
      secrets: secrets ? await secrets.list(project.name) : [],
    });
  });

  app.put("/projects/:project", async (req, res) => {
    const normalized = validateProjectConfig((req.body as { config?: unknown } | undefined)?.config);

    if (normalized.project.name !== req.params.project) {
      throw httpError(400, `project.name "${normalized.project.name}" does not match /projects/${req.params.project}`);
    }

    try {
      normalized.project.repository = validateRepoUrl(
        normalized.project.repository,
        config.allowedRepoPrefixes
      );
    } catch (error) {
      throw httpError(400, `project.repository: ${errorMessage(error)}`);
    }

    let project: ProjectRow;

    try {
      // INSERT ... RETURNING always yields the row.
      project = (await projects.upsertProject(normalized)) as ProjectRow;
    } catch (error) {
      if (hasCode(error, "23505")) {
        throw httpError(409, "Another project already uses this hostname");
      }
      throw error;
    }

    const needed = requiredSecrets(normalized);
    const present = secrets ? (await secrets.list(project.name)).map((s) => s.name) : [];

    res.json({
      success: true,
      project,
      requiredSecrets: needed,
      missingSecrets: needed.filter((name) => !present.includes(name)),
    });
  });

  // ------------------------------------------------------------- secrets

  const requireProject = async (name: string) => {
    const project = await projects.getProject(name);
    if (!project) throw httpError(404, `Project ${name} not found; run \`shipflow deploy\` or \`shipflow projects sync\` first`);
    return project;
  };

  app.get("/projects/:project/secrets", async (req, res) => {
    await requireProject(req.params.project);
    res.json({ success: true, secrets: await secrets.list(req.params.project) });
  });

  app.put("/projects/:project/secrets/:name", async (req, res) => {
    await requireProject(req.params.project);
    const { value } = (req.body ?? {}) as { value?: unknown };
    // A non-string value is rejected by secrets.set as an empty one.
    await secrets.set(req.params.project, req.params.name, typeof value === "string" ? value : "");
    // The value is never echoed back.
    res.json({ success: true, project: req.params.project, name: req.params.name });
  });

  // Run the deployment target's own diagnostics (connectivity, permissions,
  // required tools) with the project's stored secrets. Read-only.
  app.post("/projects/:project/check", async (req, res) => {
    const project = await requireProject(req.params.project);
    const checks = await checkTarget(project);
    res.json({ success: checks.every((c) => c.ok), checks });
  });

  app.delete("/projects/:project/secrets/:name", async (req, res) => {
    await requireProject(req.params.project);
    const removed = await secrets.remove(req.params.project, req.params.name);
    if (!removed) throw httpError(404, `Secret ${req.params.name} not found`);
    res.json({ success: true });
  });

  // ------------------------------------------------------------- deploy

  app.post("/deploy", async (req, res) => {
    // Untrusted JSON; each field is validated before use.
    const body = (req.body ?? {}) as {
      project?: string;
      repoUrl?: string;
      ref?: string;
      mode?: string;
      /** Where the request came from; recorded on the release for display only. */
      trigger?: string;
    };

    // Legacy form: { repoUrl } deploys to the "default" project with
    // auto-detected settings.
    if (!body.project) {
      let repoUrl: string;

      try {
        repoUrl = validateRepoUrl(body.repoUrl, config.allowedRepoPrefixes);
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: errorMessage(error),
        });
      }

      const release = await enqueueRelease({ repoUrl });

      return res.status(202).json({
        success: true,
        message: "Release queued",
        release,
      });
    }

    if (!PROJECT_NAME.test(body.project)) {
      throw httpError(400, "Invalid project name");
    }

    const project = await projects.getProject(body.project);

    if (!project) {
      throw httpError(404, `Project ${body.project} not found; register it with \`shipflow deploy\` from a directory containing shipflow.yml`);
    }

    // The allowlist may have changed since the project was registered.
    try {
      validateRepoUrl(project.repo_url, config.allowedRepoPrefixes);
    } catch (error) {
      throw httpError(403, `Repository no longer allowed: ${errorMessage(error)}`);
    }

    const needed = requiredSecrets(project.config);
    if (needed.length) {
      const present = (await secrets.list(project.name)).map((s) => s.name);
      const missing = needed.filter((name) => !present.includes(name));
      if (missing.length) {
        throw httpError(409, `Missing secret(s) for ${project.name}: ${missing.join(", ")}. Set with: shipflow secrets set ${missing[0]} --project ${project.name}`);
      }
    }

    const ref = body.ref ?? project.config.project.branch;

    const release = await enqueueRelease({
      repoUrl: project.repo_url,
      project: project.name,
      mode: body.mode === "check" ? "check" : "deploy",
      ref,
      // A label only (it grants nothing): anything but "dashboard" is recorded as the CLI.
      trigger: body.trigger === "dashboard" ? "dashboard" : "cli",
      target: project.target,
      config: project.config,
    });

    return res.status(202).json({ success: true, message: "Release queued", release });
  });

  // ----------------------------------------------------------- releases

  app.get("/releases", async (req, res) => {
    const projectFilter =
      typeof req.query.project === "string" && PROJECT_NAME.test(req.query.project)
        ? req.query.project
        : null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const all = await releases.getAllReleases(limit, projectFilter);
    const active = await activeFor(all);

    return res.status(200).json({
      success: true,
      activeReleaseId: active[projectFilter ?? "default"] ?? null,
      releases: all.map((release) => withActiveFlag(release, active)),
    });
  });

  app.get("/releases/:releaseId", async (req, res) => {
    const { releaseId } = req.params;

    const release = await releases.getRelease(releaseId);

    if (!release) {
      return res.status(404).json({
        success: false,
        message: `Release ${releaseId} not found`,
      });
    }

    return res.status(200).json({
      success: true,
      release: withActiveFlag(release, await activeFor([release])),
    });
  });

  app.get("/releases/:releaseId/logs", async (req, res) => {
    const { releaseId } = req.params;

    const release = await releases.getRelease(releaseId);

    if (!release) {
      return res.status(404).json({
        success: false,
        message: `Release ${releaseId} not found`,
      });
    }

    const [releaseLogs, releaseNotifications] = await Promise.all([
      logs.getReleaseLogs(releaseId),
      notifications.getReleaseNotifications(releaseId),
    ]);

    return res.status(200).json({
      success: true,
      release: {
        release_id: release.release_id,
        project: release.project,
        status: release.status,
        current_stage: release.current_stage,
      },
      logs: releaseLogs,
      notifications: releaseNotifications,
    });
  });

  // Deterministic summary of what happened to a release (see src/evidence.ts).
  app.get("/releases/:releaseId/evidence", async (req, res) => {
    const { releaseId } = req.params;
    const release = await releases.getRelease(releaseId);

    if (!release) {
      return res.status(404).json({
        success: false,
        message: `Release ${releaseId} not found`,
      });
    }

    return res.status(200).json({
      success: true,
      evidence: buildEvidence(release, await logs.getReleaseLogs(releaseId)),
    });
  });

  app.post("/releases/:releaseId/cancel", async (req, res) => {
    const { releaseId } = req.params;
    const release = await releases.requestCancel(releaseId);

    if (!release) {
      const existing = await releases.getRelease(releaseId);
      if (!existing) throw httpError(404, `Release ${releaseId} not found`);
      throw httpError(409, `Release ${releaseId} is already ${existing.status}`);
    }

    // A queued release is cancelled immediately; a running one stops at the
    // next check (the worker polls), but never once ACTIVATE has begun.
    if (release.status === "QUEUED") {
      const job = await queue.getJob(releaseId);
      await job?.remove().catch(() => {});
      const cancelled = await releases.transitionRelease(releaseId, ["QUEUED"], "CANCELLED", "Cancelled by user");
      if (cancelled) {
        return res.json({ success: true, status: "CANCELLED", release: cancelled });
      }
    }

    return res.status(202).json({
      success: true,
      status: "CANCEL_REQUESTED",
      message: "The worker will stop this release before activation if it has not started activating",
    });
  });

  app.post("/rollback/:releaseId", async (req, res) => {
    const result = await rollback.rollbackRelease(req.params.releaseId);

    return res.status(200).json({
      success: true,
      message: "Rollback completed",
      rollback: result,
    });
  });

  // Serve any uploaded release (active or not) for pre-activation checks.
  app.get("/preview/:releaseId{/*splat}", async (req, res) => {
    const { releaseId } = req.params;
    const splat: unknown = (req.params as Record<string, unknown>).splat;
    const release = await releases.getRelease(releaseId);

    if (!release?.artifact_path) {
      return res.status(404).json({
        success: false,
        message: `No uploaded artifact for release ${releaseId}`,
      });
    }

    if (release.artifact_type && release.artifact_type !== "static") {
      return res.status(404).json({
        success: false,
        message: `Release ${releaseId} is a ${release.artifact_type} release; it is served by its deployment target, not by ShipFlow`,
      });
    }

    await serveReleaseFile({
      res,
      storage,
      releaseId,
      artifactPath: release.artifact_path,
      requestedPath: Array.isArray(splat) ? splat.join("/") : "",
    });
    return undefined;
  });

  app.use((_req, res) => {
    res.status(404).json({ success: false, message: "Not found" });
  });

  app.use(jsonErrorHandler);

  return app;
}

/**
 * The public site (port 8080): serves a project's active release at the
 * root path, so absolute asset URLs like /assets/app.js work. The project
 * is chosen by the request's Host (see resolveSiteProject).
 */
export function createSiteApp({
  releases,
  activation,
  storage,
  projects = {},
  siteDefaultProject,
}: SiteAppDeps) {
  const app = express();
  app.disable("x-powered-by");

  app.use(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(405).send("Method not allowed");
    }

    const project = projects.resolveSiteProject
      ? await projects.resolveSiteProject(req.hostname, siteDefaultProject)
      : "default";
    const activeReleaseId = project ? await activation.getActiveReleaseId(project) : null;
    const release = activeReleaseId ? await releases.getRelease(activeReleaseId) : undefined;

    if (!activeReleaseId || !release?.artifact_path) {
      return res.status(404).send("No active deployment");
    }

    if (release.artifact_type && release.artifact_type !== "static") {
      return res.status(404).send("This project is served by its own deployment target");
    }

    await serveReleaseFile({
      res,
      storage,
      releaseId: activeReleaseId,
      artifactPath: release.artifact_path,
      requestedPath: req.path,
    });
    return undefined;
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(error);
    }

    console.error("Site error:", error);
    return res.status(502).send("Deployment unavailable");
  });

  return app;
}

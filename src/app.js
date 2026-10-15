import express from "express";
import crypto from "crypto";
import { pipeline } from "stream/promises";

import {
  isValidReleaseId,
  validateRepoUrl,
  safeRelativePath,
} from "./validation.js";

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

/**
 * Bearer-token auth. Hashing both sides gives equal-length buffers for a
 * constant-time comparison.
 */
export function requireToken(token) {
  const expected = digest(token);

  return (req, res, next) => {
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

function lastSegmentHasExtension(relativePath) {
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
    let object;

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

function jsonErrorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

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
}

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * The control API (port 8000). Everything except /health and the signed
 * GitHub webhook needs the bearer token.
 */
export function createApiApp(deps) {
  const {
    config,
    releases,
    projects = {},
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

  app.get("/health", async (req, res) => {
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

  app.use(express.json({ limit: "64kb" }));
  app.use(requireToken(config.apiToken));

  // Release IDs and project names are validated once for every route.
  app.param("releaseId", (req, res, next, releaseId) => {
    if (!isValidReleaseId(releaseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid release ID",
      });
    }

    return next();
  });

  app.param("project", (req, res, next, project) => {
    if (!PROJECT_NAME.test(project)) {
      return res.status(400).json({ success: false, message: "Invalid project name" });
    }

    return next();
  });

  const activeFor = async (rows) => {
    const names = [...new Set(rows.map((row) => row.project ?? "default"))];
    const entries = await Promise.all(
      names.map(async (name) => [name, await activation.getActiveReleaseId(name)])
    );
    return Object.fromEntries(entries);
  };

  const withActiveFlag = (release, active) => ({
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
  }) {
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

    return release;
  }

  app.locals.enqueueRelease = enqueueRelease;

  app.get("/whoami", async (req, res) => {
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

  app.get("/ready", async (req, res) => {
    const checks = await readiness();
    const ok = checks.every((check) => check.ok);
    res.status(ok ? 200 : 503).json({ success: ok, checks });
  });

  // ------------------------------------------------------------ projects

  app.get("/projects", async (req, res) => {
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
    const normalized = validateProjectConfig(req.body?.config);

    if (normalized.project.name !== req.params.project) {
      throw httpError(400, `project.name "${normalized.project.name}" does not match /projects/${req.params.project}`);
    }

    try {
      normalized.project.repository = validateRepoUrl(
        normalized.project.repository,
        config.allowedRepoPrefixes
      );
    } catch (error) {
      throw httpError(400, `project.repository: ${error.message}`);
    }

    let project;

    try {
      project = await projects.upsertProject(normalized);
    } catch (error) {
      if (error.code === "23505") {
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

  const requireProject = async (name) => {
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
    await secrets.set(req.params.project, req.params.name, req.body?.value);
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
    const body = req.body ?? {};

    // Legacy form: { repoUrl } deploys to the "default" project with
    // auto-detected settings.
    if (!body.project) {
      let repoUrl;

      try {
        repoUrl = validateRepoUrl(body.repoUrl, config.allowedRepoPrefixes);
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: error.message,
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
      throw httpError(403, `Repository no longer allowed: ${error.message}`);
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
    const { releaseId, splat } = req.params;
    const release = await releases.getRelease(releaseId);

    if (!release?.artifact_path) {
      return res.status(404).json({
        success: false,
        message: `No uploaded artifact for release ${releaseId}`,
      });
    }

    await serveReleaseFile({
      res,
      storage,
      releaseId,
      artifactPath: release.artifact_path,
      requestedPath: Array.isArray(splat) ? splat.join("/") : "",
    });
  });

  app.use((req, res) => {
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
export function createSiteApp({ releases, activation, storage, projects = {}, siteDefaultProject }) {
  const app = express();
  app.disable("x-powered-by");

  app.use(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(405).send("Method not allowed");
    }

    const project = projects.resolveSiteProject
      ? await projects.resolveSiteProject(req.hostname, siteDefaultProject)
      : "default";
    const activeReleaseId = project && (await activation.getActiveReleaseId(project));
    const release =
      activeReleaseId && (await releases.getRelease(activeReleaseId));

    if (!release?.artifact_path) {
      return res.status(404).send("No active deployment");
    }

    await serveReleaseFile({
      res,
      storage,
      releaseId: activeReleaseId,
      artifactPath: release.artifact_path,
      requestedPath: req.path,
    });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    console.error("Site error:", error);
    return res.status(502).send("Deployment unavailable");
  });

  return app;
}

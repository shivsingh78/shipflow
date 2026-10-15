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

  console.error(error);

  return res.status(500).json({
    success: false,
    message: "Internal server error",
  });
}

/**
 * The control API (port 8000). Everything except /health needs the token.
 */
export function createApiApp(deps) {
  const {
    config,
    releases,
    logs,
    notifications,
    queue,
    activation,
    rollback,
    storage,
    healthCheck,
    generateId,
  } = deps;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));

  app.get("/health", async (req, res) => {
    try {
      await healthCheck();
      return res.status(200).json({ success: true, status: "ok" });
    } catch {
      return res.status(503).json({ success: false, status: "unavailable" });
    }
  });

  app.use(requireToken(config.apiToken));

  // Release IDs are validated once for every route that takes one.
  app.param("releaseId", (req, res, next, releaseId) => {
    if (!isValidReleaseId(releaseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid release ID",
      });
    }

    return next();
  });

  const withActiveFlag = (release, activeReleaseId) => ({
    ...release,
    is_active: release.release_id === activeReleaseId,
  });

  app.post("/deploy", async (req, res) => {
    let repoUrl;

    try {
      repoUrl = validateRepoUrl(
        req.body?.repoUrl,
        config.allowedRepoPrefixes
      );
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }

    const counts = await queue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "prioritized"
    );
    const pending = Object.values(counts).reduce((a, b) => a + b, 0);

    if (pending >= config.maxQueuedReleases) {
      return res.status(429).json({
        success: false,
        message: `Too many releases in progress (${pending}); try again later`,
      });
    }

    const releaseId = generateId();

    const release = await releases.createRelease({
      releaseId,
      repoUrl,
      status: "QUEUED",
      currentStage: "RELEASE",
    });

    try {
      await queue.add(
        "deployment",
        { releaseId, repoUrl },
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

    return res.status(202).json({
      success: true,
      message: "Release queued",
      release,
    });
  });

  app.get("/releases", async (req, res) => {
    const [all, activeReleaseId] = await Promise.all([
      releases.getAllReleases(),
      activation.getActiveReleaseId(),
    ]);

    return res.status(200).json({
      success: true,
      activeReleaseId,
      releases: all.map((release) =>
        withActiveFlag(release, activeReleaseId)
      ),
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
      release: withActiveFlag(
        release,
        await activation.getActiveReleaseId()
      ),
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
        status: release.status,
        current_stage: release.current_stage,
      },
      logs: releaseLogs,
      notifications: releaseNotifications,
    });
  });

  app.post("/rollback/:releaseId", async (req, res) => {
    try {
      const result = await rollback.rollbackRelease(req.params.releaseId);

      return res.status(200).json({
        success: true,
        message: "Rollback completed",
        rollback: result,
      });
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message,
        });
      }

      throw error;
    }
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
 * The public site (port 8080): serves the active release at the root path,
 * so absolute asset URLs like /assets/app.js work.
 */
export function createSiteApp({ releases, activation, storage }) {
  const app = express();
  app.disable("x-powered-by");

  app.use(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(405).send("Method not allowed");
    }

    const activeReleaseId = await activation.getActiveReleaseId();
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

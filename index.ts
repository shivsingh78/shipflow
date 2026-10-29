import { config } from "./src/config.js";
import { pool } from "./src/db.js";
import { connection, bullConnection, deployQueue } from "./src/queue.js";
import { runMigrations } from "./src/migrate.js";
import { genrate } from "./src/genrate.js";
import { rollbackRelease } from "./src/rollback.js";
import { getArtifactStore } from "./src/artifactStore.js";
import { getActiveReleaseId } from "./src/activation.js";
import { createApiApp, createSiteApp } from "./src/app.js";
import type { EnqueueRelease, ReadinessCheck } from "./src/app.js";
import { createSecretStore, parseSecretsKey } from "./src/secrets.js";
import { createGithubWebhookHandler } from "./src/webhooks.js";
import { listTargets, getTarget } from "./src/targets/index.js";
import { releaseSettings, createTargetContext } from "./src/pipeline.js";
import {
  validateProjectConfig,
  requiredSecrets,
} from "./cli/lib/projectConfig.js";
import {
  createRelease,
  getRelease,
  getAllReleases,
  updateRelease,
  requestCancel,
  transitionRelease,
} from "./src/releaseStore.js";
import {
  upsertProject,
  getProject,
  listProjects,
  resolveSiteProject,
  findProjectsByRepository,
} from "./src/projectStore.js";
import { getReleaseLogs } from "./src/logStore.js";
import { getReleaseNotifications } from "./src/notify.js";
import { errorMessage } from "./src/errors.js";
import type { ProjectRow } from "./src/projectStore.js";
import type { TargetCheck } from "./src/targets/types.js";
import { resolveDashboardDir } from "./src/dashboard.js";
import { readCapabilities } from "./src/repopilot/capabilities.js";
import { loadRepoPilotConfig, workerSecretsLeakedInto } from "./src/repopilot/config.js";
import { createEvidenceStore } from "./src/repopilot/evidence.js";
import { bullEnqueue, createRepoPilotQueue } from "./src/repopilot/queue.js";
import { createDisabledRepoPilotRouter, createRepoPilotRouter } from "./src/repopilot/routes.js";
import { createRepoPilotStore } from "./src/repopilot/store.js";

if (config.apiToken.length < 24) {
  console.error(
    "SHIPFLOW_API_TOKEN must be set to at least 24 characters. " +
      "Generate one with: openssl rand -hex 32"
  );
  process.exit(1);
}

const artifactStore = await getArtifactStore();
const secretStore = createSecretStore({ key: parseSecretsKey(config.secretsKey) });

await runMigrations();
console.log("PostgreSQL connected and schema is up to date");

const releases = {
  createRelease,
  getRelease,
  getAllReleases,
  updateRelease,
  requestCancel,
  transitionRelease,
};
const projects = { upsertProject, getProject, listProjects, resolveSiteProject, findProjectsByRepository };
const activation = { getActiveReleaseId };
const storage = {
  getObject: (key: string) => artifactStore.get(key),
  isNotFoundError: (error: unknown) => artifactStore.isNotFound(error),
  describe: () => artifactStore.describe(),
};

/**
 * Readiness: every dependency a release needs, without secret values.
 */
async function readiness(): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      checks.push({ name, ok: true, detail: (await fn()) ?? "ok" });
    } catch (error) {
      checks.push({ name, ok: false, detail: errorMessage(error) });
    }
  };

  await run("postgres", async () => {
    await pool.query("SELECT 1");
  });
  await run("redis", async () => {
    await connection.ping();
  });
  await run("queue", async () => {
    const counts = await deployQueue.getJobCounts("waiting", "active", "failed");
    return `waiting ${counts.waiting}, active ${counts.active}, failed ${counts.failed}`;
  });
  await run("artifact storage", async () => {
    await artifactStore.list("healthcheck/");
    return artifactStore.describe();
  });
  await run("workers", async () => {
    const keys = await connection.keys(`shipflow:worker:${config.instance}:*`);
    if (keys.length === 0) throw new Error("no worker heartbeat in the last 30s; is the worker running?");
    const workers = (await Promise.all(keys.map((key) => connection.get(key))))
      .filter((value): value is string => Boolean(value))
      .map((value) => JSON.parse(value) as { sandbox?: string; egressProxy?: boolean });
    const restricted = workers.every((w) => w.sandbox !== "docker" || w.egressProxy);
    return `${workers.length} alive (sandbox ${workers.map((w) => w.sandbox).join(", ")}${
      restricted ? ", restricted network" : ", WARNING: unrestricted install network"
    })`;
  });
  if (repopilotRouterEnabled) {
    await run("repopilot workers", async () => {
      const caps = await readCapabilities(connection, config.instance);
      if (caps.workers === 0) throw new Error("no RepoPilot worker heartbeat in the last 30s; start the repopilot-worker service");
      return `${caps.workers} alive (github ${caps.github ? "configured" : "NOT configured"}, sandbox ${caps.sandbox})`;
    });
  }
  await run("secret storage", async () => {
    if (!secretStore.enabled) throw new Error("disabled: set SHIPFLOW_SECRETS_KEY (needed for ssh targets)");
  });

  return checks;
}

/**
 * Target diagnostics for `shipflow doctor`. Secrets are decrypted here, in
 * the trusted API process, and never returned.
 */
async function checkTarget(project: ProjectRow): Promise<TargetCheck[]> {
  const settings = releaseSettings({ config: project.config });
  const target = getTarget(settings.target);

  try {
    const names = target.requiredSecrets(settings.targetConfig);
    const secrets = names.length ? await secretStore.resolve(project.name, names) : {};
    const ctx = createTargetContext({
      project: project.name,
      releaseId: null,
      settings,
      secrets,
      store: artifactStore,
      log: async () => {},
    });

    return await target.check(ctx);
  } catch (error) {
    return [{ name: `target ${target.name}`, ok: false, detail: errorMessage(error) }];
  }
}

// The API app owns the enqueue function but is created after the webhook
// handler that needs it, so resolve it lazily.
const enqueueRelease: EnqueueRelease = (options) =>
  (api.locals.enqueueRelease as EnqueueRelease)(options);

const webhookHandler = config.githubWebhookSecret
  ? createGithubWebhookHandler({
      secret: config.githubWebhookSecret,
      allowedRepoPrefixes: config.allowedRepoPrefixes,
      findProjects: findProjectsByRepository,
      enqueue: (options) => enqueueRelease(options),
    })
  : null;

// RepoPilot is off unless REPOPILOT=enabled. The API holds neither the GitHub
// token nor the credential private key; if either shows up in its
// environment RepoPilot refuses to start here.
const repopilotConfig = loadRepoPilotConfig();
const leakedSecrets = workerSecretsLeakedInto();
let repopilotRouterEnabled = false;
let repopilotRouter;

if (repopilotConfig.enabled && leakedSecrets.length > 0) {
  console.error(
    `RepoPilot is DISABLED: worker-only secrets are set on the API process (${leakedSecrets.join(", ")}). ` +
      "Move them to the repopilot-worker's own env file (see docs/repopilot.md)."
  );
  repopilotRouter = createDisabledRepoPilotRouter({
    problems: [...repopilotConfig.problems, `Worker-only secrets (${leakedSecrets.join(", ")}) must not be set on the API process. Remove them to enable RepoPilot.`],
  });
} else if (repopilotConfig.enabled) {
  const repopilotQueue = createRepoPilotQueue(bullConnection);
  const evidenceStore = createEvidenceStore(artifactStore);

  repopilotRouterEnabled = true;
  repopilotRouter = createRepoPilotRouter({
    store: createRepoPilotStore(pool, { maxActiveRuns: repopilotConfig.limits.maxActiveRuns }),
    enqueue: bullEnqueue(repopilotQueue),
    config: repopilotConfig,
    capabilities: () => readCapabilities(connection, config.instance),
    artifacts: {
      read: async (objectKey, maxBytes) => {
        const body = await evidenceStore.get(objectKey, maxBytes);

        return body ? { body, contentType: "application/octet-stream" } : null;
      },
    },
    queueCounts: () => repopilotQueue.getJobCounts("waiting", "active", "delayed", "failed"),
  });
  console.log(`RepoPilot enabled (sandbox verification: ${repopilotConfig.sandboxMode})`);
} else {
  repopilotRouter = createDisabledRepoPilotRouter(repopilotConfig);
}

const dashboardDir = resolveDashboardDir(config.dashboardDir, config.dashboardDisabled);

if (dashboardDir) console.log(`Dashboard available at /ui (${dashboardDir})`);

const api = createApiApp({
  config,
  dashboardDir,
  releases,
  projects,
  logs: { getReleaseLogs },
  notifications: { getReleaseNotifications },
  queue: deployQueue,
  activation,
  rollback: { rollbackRelease: (id: string) => rollbackRelease(id, { secretStore }) },
  storage,
  secrets: secretStore,
  healthCheck: () => pool.query("SELECT 1"),
  readiness,
  generateId: genrate,
  validateProjectConfig,
  requiredSecrets,
  targets: listTargets,
  webhookHandler,
  checkTarget,
  repopilotRouter,
});

const site = createSiteApp({
  releases,
  activation,
  storage,
  projects,
  siteDefaultProject: config.siteDefaultProject,
});

const apiServer = api.listen(config.apiPort, () => {
  console.log(`ShipFlow API listening on port ${config.apiPort}`);
});

const siteServer = site.listen(config.sitePort, () => {
  console.log(`Active deployments served on port ${config.sitePort} (artifacts: ${artifactStore.describe()})`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  apiServer.close();
  siteServer.close();
  await deployQueue.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

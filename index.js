import { config } from "./src/config.js";
import { pool } from "./src/db.js";
import { connection, deployQueue } from "./src/queue.js";
import { runMigrations } from "./src/migrate.js";
import { genrate } from "./src/genrate.js";
import { rollbackRelease } from "./src/rollback.js";
import { getArtifactStore } from "./src/artifactStore.js";
import { getActiveReleaseId } from "./src/activation.js";
import { createApiApp, createSiteApp } from "./src/app.js";
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
  getObject: (key) => artifactStore.get(key),
  isNotFoundError: (error) => artifactStore.isNotFound(error),
  describe: () => artifactStore.describe(),
};

/**
 * Readiness: every dependency a release needs, without secret values.
 */
async function readiness() {
  const checks = [];
  const run = async (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: (await fn()) ?? "ok" });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
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
      .filter(Boolean)
      .map((value) => JSON.parse(value));
    const restricted = workers.every((w) => w.sandbox !== "docker" || w.egressProxy);
    return `${workers.length} alive (sandbox ${workers.map((w) => w.sandbox).join(", ")}${
      restricted ? ", restricted network" : ", WARNING: unrestricted install network"
    })`;
  });
  await run("secret storage", async () => {
    if (!secretStore.enabled) throw new Error("disabled: set SHIPFLOW_SECRETS_KEY (needed for ssh targets)");
  });

  return checks;
}

/**
 * Target diagnostics for `shipflow doctor`. Secrets are decrypted here, in
 * the trusted API process, and never returned.
 */
async function checkTarget(project) {
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
    return [{ name: `target ${target.name}`, ok: false, detail: error.message }];
  }
}

let enqueueRelease;

const webhookHandler = config.githubWebhookSecret
  ? createGithubWebhookHandler({
      secret: config.githubWebhookSecret,
      allowedRepoPrefixes: config.allowedRepoPrefixes,
      findProjects: findProjectsByRepository,
      enqueue: (options) => enqueueRelease(options),
    })
  : null;

const api = createApiApp({
  config,
  releases,
  projects,
  logs: { getReleaseLogs },
  notifications: { getReleaseNotifications },
  queue: deployQueue,
  activation,
  rollback: { rollbackRelease: (id) => rollbackRelease(id, { secretStore }) },
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
});

enqueueRelease = api.locals.enqueueRelease;

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

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  apiServer.close();
  siteServer.close();
  await deployQueue.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

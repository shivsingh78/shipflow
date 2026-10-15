import { config } from "./src/config.js";
import { pool } from "./src/db.js";
import { deployQueue } from "./src/queue.js";
import { runMigrations } from "./src/migrate.js";
import { genrate } from "./src/genrate.js";
import { rollbackRelease } from "./src/rollback.js";
import { getS3Object, isNotFoundError } from "./src/aws.js";
import { getActiveReleaseId } from "./src/activation.js";
import { createApiApp, createSiteApp } from "./src/app.js";
import {
  createRelease,
  getRelease,
  getAllReleases,
  updateRelease,
} from "./src/releaseStore.js";
import { getReleaseLogs } from "./src/logStore.js";
import { getReleaseNotifications } from "./src/notify.js";

if (config.apiToken.length < 24) {
  console.error(
    "SHIPFLOW_API_TOKEN must be set to at least 24 characters. " +
      "Generate one with: openssl rand -hex 32"
  );
  process.exit(1);
}

if (!config.s3.bucket) {
  console.error("S3_BUCKET_NAME must be set");
  process.exit(1);
}

await runMigrations();
console.log("PostgreSQL connected and schema is up to date");

const releases = { createRelease, getRelease, getAllReleases, updateRelease };
const activation = { getActiveReleaseId };
const storage = { getObject: getS3Object, isNotFoundError };

const api = createApiApp({
  config,
  releases,
  logs: { getReleaseLogs },
  notifications: { getReleaseNotifications },
  queue: deployQueue,
  activation,
  rollback: { rollbackRelease },
  storage,
  healthCheck: () => pool.query("SELECT 1"),
  generateId: genrate,
});

const site = createSiteApp({ releases, activation, storage });

const apiServer = api.listen(config.apiPort, () => {
  console.log(`ShipFlow API listening on port ${config.apiPort}`);
});

const siteServer = site.listen(config.sitePort, () => {
  console.log(`Active deployment served on port ${config.sitePort}`);
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

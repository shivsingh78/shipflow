#!/usr/bin/env node

import {
  createRelease,
  getReleaseStatus,
  getAllReleases,
  getReleaseLogs,
  rollbackRelease,
} from "./deploy.js";

const USAGE = [
  "Usage:",
  "  shipflow deploy <repoUrl>      Queue a release and follow it",
  "  shipflow status <releaseId>    Show one release",
  "  shipflow releases              List recent releases",
  "  shipflow logs <releaseId>      Show stage logs and notifications",
  "  shipflow rollback <releaseId>  Make an earlier successful release live",
  "",
  "Environment:",
  "  SHIPFLOW_API_URL    API address (default http://localhost:8000)",
  "  SHIPFLOW_API_TOKEN  API token configured on the server",
].join("\n");

const POLL_INTERVAL_MS = 2000;
const DEPLOY_TIMEOUT_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireArgument(value, usage) {
  if (!value) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }

  return value;
}

function printRelease(release) {
  console.log(`Release:    ${release.release_id}${release.is_active ? "  (ACTIVE)" : ""}`);
  console.log(`Repository: ${release.repo_url}`);
  console.log(`Status:     ${release.status}`);
  console.log(`Stage:      ${release.current_stage}`);

  if (release.commit_sha) {
    console.log(`Commit:     ${release.commit_sha}`);
  }

  if (release.test_status) {
    console.log(`Tests:      ${release.test_status}`);
  }

  if (release.artifact_path) {
    console.log(`Artifact:   ${release.artifact_path}`);
  }

  if (release.is_active && release.public_deployment_url) {
    console.log(`Live URL:   ${release.public_deployment_url}`);
  }

  if (release.error_message) {
    console.log(`Error:      ${release.error_message}`);
  }

  console.log(`Created:    ${release.created_at}`);
  console.log(`Updated:    ${release.updated_at}`);
}

/*
|--------------------------------------------------------------------------
| DEPLOY
|--------------------------------------------------------------------------
*/

async function deploy(repoUrl) {
  console.log(`Deploying: ${repoUrl}`);

  const { release } = await createRelease(repoUrl);

  console.log(`Release: ${release.release_id}`);

  const startedAt = Date.now();
  let lastState = null;
  let consecutiveErrors = 0;

  // Poll release status
  while (Date.now() - startedAt < DEPLOY_TIMEOUT_MS) {
    let current;

    try {
      current = (await getReleaseStatus(release.release_id)).release;
      consecutiveErrors = 0;
    } catch (error) {
      // Tolerate brief API restarts while a build is running.
      if (++consecutiveErrors >= 5 || error.status === 404) {
        throw error;
      }

      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const state = `${current.current_stage} (${current.status})`;

    if (state !== lastState) {
      console.log(`→ ${state}`);
      lastState = state;
    }

    if (current.status === "SUCCESS") {
      console.log("");
      console.log("✅ Deployment successful");
      console.log(`Tests: ${current.test_status}`);

      if (current.public_deployment_url) {
        console.log(`URL: ${current.public_deployment_url}`);
      }

      return 0;
    }

    if (current.status === "FAILED") {
      console.error("");
      console.error("❌ Deployment failed");
      console.error(`Stage: ${current.current_stage}`);

      if (current.error_message) {
        console.error(`Reason: ${current.error_message}`);
      }

      console.error(`Details: shipflow logs ${current.release_id}`);
      return 1;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  console.error(
    `Timed out waiting for ${release.release_id}; check later with: shipflow status ${release.release_id}`
  );
  return 1;
}

/*
|--------------------------------------------------------------------------
| STATUS / RELEASES / LOGS / ROLLBACK
|--------------------------------------------------------------------------
*/

async function status(releaseId) {
  const { release } = await getReleaseStatus(releaseId);
  printRelease(release);
  return 0;
}

async function releases() {
  const result = await getAllReleases();

  if (result.releases.length === 0) {
    console.log("No releases found.");
    return 0;
  }

  console.log("RELEASE \tSTATUS \tSTAGE   \tTESTS  \tCREATED");

  for (const release of result.releases) {
    console.log(
      `${release.release_id}\t${release.status.padEnd(7)}\t${release.current_stage.padEnd(8)}\t${(release.test_status || "-").padEnd(7)}\t${release.created_at}${release.is_active ? "\t← active" : ""}`
    );
  }

  return 0;
}

async function logs(releaseId) {
  const result = await getReleaseLogs(releaseId);

  console.log(
    `Release ${result.release.release_id}: ${result.release.status} (${result.release.current_stage})`
  );
  console.log("");

  if (result.logs.length === 0) {
    console.log(
      result.release.status === "QUEUED"
        ? "No logs yet: the release is still waiting for a worker."
        : "No logs recorded for this release."
    );
  }

  for (const log of result.logs) {
    console.log(`[${log.stage}] [${log.level}] ${log.message}`);
  }

  if (result.notifications.length > 0) {
    console.log("");
    console.log("Notifications:");

    for (const notification of result.notifications) {
      console.log(`  ${notification.type}: ${notification.message}`);
    }
  }

  return 0;
}

async function rollback(releaseId) {
  const result = await rollbackRelease(releaseId);
  const { previousReleaseId, targetReleaseId } = result.rollback;

  console.log(
    `✅ Rolled back: ${previousReleaseId ?? "(none)"} → ${targetReleaseId}`
  );
  return 0;
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

const [command, argument] = process.argv.slice(2);

const commands = {
  deploy: () => deploy(requireArgument(argument, "shipflow deploy <repoUrl>")),
  status: () => status(requireArgument(argument, "shipflow status <releaseId>")),
  releases: () => releases(),
  logs: () => logs(requireArgument(argument, "shipflow logs <releaseId>")),
  rollback: () =>
    rollback(requireArgument(argument, "shipflow rollback <releaseId>")),
};

if (!command || command === "help" || command === "--help") {
  console.log(USAGE);
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}\n`);
  console.error(USAGE);
  process.exit(1);
}

try {
  process.exit(await commands[command]());
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

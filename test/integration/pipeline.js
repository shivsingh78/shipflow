// Shared fixture: drive a run through ingest -> manifest -> analyze -> patch
// with in-memory GitHub/AI fakes, ending in `verifying` (or `awaiting_patch`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createOrchestrator } from "../../dist/src/repopilot/orchestrator.js";
import { createGithubClient } from "../../dist/src/repopilot/github.js";
import { createIngestHandler, createManifestHandler } from "../../dist/src/repopilot/stagesIngest.js";
import { createAnalyzeHandler } from "../../dist/src/repopilot/stagesAnalyze.js";
import { createPatchHandler } from "../../dist/src/repopilot/stagesPatch.js";
import { createEvidenceStore } from "../../dist/src/repopilot/evidence.js";
import { loadRepoPilotConfig } from "../../dist/src/repopilot/config.js";
import { generateCredentialKeyPair, sealCredential } from "../../dist/src/repopilot/credentials.js";
import { createLocalStore } from "../../dist/src/artifactStore.js";
import { createFakeGithub } from "../helpers/fakeGithub.js";
import { REPO, SHA, fakeQueue, finding } from "./helpers.js";

export const API_KEY = "sk-ant-api03-integrationKeyValue0123456789abcdef";
export const GH_TOKEN = "ghp_integrationTokenValue0123456789abcdef";
export const KEYS = generateCredentialKeyPair();
export const OWNER = "instance";
export const USER = "user:operator";

export const INDEX = "const a = JSON.parse(x);\nexport default a;\nfunction f() {}\n";
export const PKG = JSON.stringify({ name: "demo", scripts: { test: "node --test" } });
export const GOOD_DIFF = ["diff --git a/src/index.js b/src/index.js", "index 1111111..2222222 100644", "--- a/src/index.js", "+++ b/src/index.js", "@@ -1,2 +1,2 @@", "-const a = JSON.parse(x);", "+const a = (() => { try { return JSON.parse(x); } catch { return null; } })();", " export default a;", ""].join("\n");
export const GOOD_TEST = ["diff --git a/test/new.test.js b/test/new.test.js", "new file mode 100644", "index 0000000..1111111", "--- /dev/null", "+++ b/test/new.test.js", "@@ -0,0 +1,2 @@", "+import test from 'node:test';", "+test('handles bad json', () => {});", ""].join("\n");

const reply = (json) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json) });
const tool = (name, input) => reply({ model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", name, input }], usage: { input_tokens: 800, output_tokens: 200 } });

export function makeEvidence() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rp-pipe-"));

  return { root, evidence: createEvidenceStore(createLocalStore(root)), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * Build a run in `verifying` with one policy-valid patch.
 * `extraHandlers` are added to the orchestrator (e.g. verify, pr).
 */
export async function verifyingRun({ store, evidence, files, extraHandlers = () => ({}), config = loadRepoPilotConfig({}) }) {
  await store.putCredential({ owner: OWNER, actor: USER, provider: "anthropic", ciphertext: sealCredential(KEYS.publicKeyPem, API_KEY), fingerprint: "0123456789abcdef" });

  const run = (await store.createRun({ owner: OWNER, actor: USER, repo: REPO })).run;
  const gh = createFakeGithub({ owner: REPO.owner, name: REPO.name, branches: { main: SHA }, commits: { [SHA]: files ?? { "package.json": PKG, "package-lock.json": "{}", "src/index.js": INDEX } } });
  const github = createGithubClient({ token: GH_TOKEN, fetch: gh.fetch, timeoutMs: 1000 });
  const aiFetch = async (_url, init) => {
    const body = JSON.parse(init.body);

    return body.tool_choice.name === "report_findings"
      ? tool("report_findings", { findings: [finding({ file: "src/index.js", lineStart: 1, lineEnd: 1 })] })
      : tool("propose_patch", { title: "Guard JSON.parse", explanation: "Wrap it.", diff: GOOD_DIFF, testDiff: GOOD_TEST });
  };
  const deps = { store, github, evidence, config };
  const ai = { credentialPrivateKey: KEYS.privateKeyPem, fetch: aiFetch, timeoutMs: 1000 };
  const queue = fakeQueue();
  const orchestrator = createOrchestrator({
    store, enqueue: queue.enqueue, workerId: "t", heartbeatMs: 50, cancelPollMs: 20,
    handlers: { ingest: createIngestHandler(deps), manifest: createManifestHandler(deps), analyze: createAnalyzeHandler({ ...deps, ai }), patch: createPatchHandler({ ...deps, ai }), ...extraHandlers({ deps, ai }) },
  });

  for (const stage of ["ingest", "manifest", "analyze"]) await orchestrator.processJob({ runId: run.id, stage, attempt: 1 });

  const [found] = await store.listFindings(OWNER, run.id);
  await orchestrator.processJob({ runId: run.id, stage: "patch", attempt: 1, findingId: found.id });
  queue.jobs.length = 0;

  const [patch] = await store.listPatches(OWNER, run.id);

  return { run, found, patch, orchestrator, queue, deps, github, gh };
}

/** A scriptable SandboxRunner. `script(input, n)` returns a SandboxResult-like object or throws. */
export function fakeSandbox({ script, status = "ready", supportsControlArm = true, reason }) {
  const calls = [];

  return {
    calls,
    runner: {
      status,
      profile: { runner: "fake", note: "test double; not an isolation boundary" },
      supportsControlArm,
      ...(reason ? { reason } : {}),
      async run(input, signal) {
        calls.push(input);
        if (signal.aborted) throw signal.reason;

        return script(input, calls.length, signal);
      },
    },
  };
}

export const exited = (exitCode, log = "") => ({ run: { kind: "exited", exitCode, durationMs: 12 }, log });

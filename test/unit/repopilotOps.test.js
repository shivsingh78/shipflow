import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { heartbeatPrefix, readCapabilities } from "../../dist/src/repopilot/capabilities.js";
import { loadRepoPilotConfig, workerSecretsLeakedInto } from "../../dist/src/repopilot/config.js";
import { writeKeyPair } from "../../dist/src/repopilot/keygen.js";
import { openCredential, sealCredential } from "../../dist/src/repopilot/credentials.js";

const redis = (entries) => ({ keys: async (pattern) => Object.keys(entries).filter((k) => k.startsWith(pattern.replace("*", ""))), get: async (k) => entries[k] ?? null });
const beat = (over = {}) => JSON.stringify({ at: "2026-10-28T00:00:00Z", github: true, credentialDecryption: true, sandbox: "off", concurrency: 1, ...over });

test("capabilities come only from live worker heartbeats", async () => {
  const prefix = heartbeatPrefix("shipflow");

  assert.deepEqual(await readCapabilities(redis({}), "shipflow"), { workers: 0, github: false, credentialDecryption: false, sandbox: "off" });

  const caps = await readCapabilities(redis({ [`${prefix}a`]: beat({ github: false, credentialDecryption: false }), [`${prefix}b`]: beat({ sandbox: "unavailable" }), "shipflow:worker:shipflow:x": beat() }), "shipflow");
  assert.deepEqual(caps, { workers: 2, github: true, credentialDecryption: true, sandbox: "unavailable" });

  assert.equal((await readCapabilities(redis({ [`${prefix}a`]: beat({ sandbox: "ready" }), [`${prefix}b`]: beat({ sandbox: "off" }) }), "shipflow")).sandbox, "ready");
  assert.deepEqual(await readCapabilities(redis({ [`${prefix}a`]: "{not json", [`${prefix}b`]: "" }), "shipflow"), { workers: 0, github: false, credentialDecryption: false, sandbox: "off" });
  assert.equal((await readCapabilities(redis({ [heartbeatPrefix("other") + "a"]: beat() }), "shipflow")).workers, 0, "another instance's workers are ignored");
});

test("worker-only secrets are detected in an API environment", () => {
  assert.deepEqual(workerSecretsLeakedInto({}), []);
  assert.deepEqual(workerSecretsLeakedInto({ REPOPILOT_GITHUB_TOKEN: "ghp_x" }), ["REPOPILOT_GITHUB_TOKEN"]);
  assert.deepEqual(workerSecretsLeakedInto({ REPOPILOT_CREDENTIAL_PRIVATE_KEY_FILE: "/k", REPOPILOT_CREDENTIAL_PRIVATE_KEY: "x", REPOPILOT_GITHUB_TOKEN: "t" }).length, 3);
  assert.deepEqual(workerSecretsLeakedInto({ REPOPILOT_GITHUB_TOKEN: "", REPOPILOT_CREDENTIAL_PUBLIC_KEY: "pub" }), [], "empty values and the public key are fine");
});

test("the shared config never carries worker secrets even when they are in the environment", () => {
  const config = loadRepoPilotConfig({ REPOPILOT: "enabled", REPOPILOT_GITHUB_TOKEN: "ghp_secretvalue0123456789abcdef", REPOPILOT_CREDENTIAL_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----" });

  assert.ok(!JSON.stringify(config).includes("ghp_") && !JSON.stringify(config).includes("PRIVATE"));
});

test("keygen writes a working key pair with private-key permissions and never overwrites", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-keygen-"));

  try {
    const target = path.join(dir, "keys");
    const { publicPath, privatePath } = writeKeyPair(target);

    assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(publicPath, "utf-8"), /BEGIN PUBLIC KEY/);
    assert.equal(openCredential(fs.readFileSync(privatePath, "utf-8"), sealCredential(fs.readFileSync(publicPath, "utf-8"), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123")), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");

    const before = fs.readFileSync(privatePath);
    assert.throws(() => writeKeyPair(target), /Refusing to overwrite/);
    assert.deepEqual(fs.readFileSync(privatePath), before, "the existing private key is untouched");

    // The public key file is accepted by the API config; the private one is refused.
    assert.equal(loadRepoPilotConfig({ REPOPILOT_CREDENTIAL_PUBLIC_KEY_FILE: publicPath }).problems.length, 0);
    assert.ok(loadRepoPilotConfig({ REPOPILOT_CREDENTIAL_PUBLIC_KEY_FILE: privatePath }).problems.some((p) => /PRIVATE/.test(p)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------- structural security guards

const dir = new URL("../../src/repopilot/", import.meta.url).pathname;
const sources = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf-8")]);

test("no RepoPilot module can execute a process or reach Docker", () => {
  const offenders = [];

  for (const [file, text] of sources) {
    if (/child_process|\bexecFile?\b|\bspawn(Sync)?\b|\bfork\(|docker\.sock|node:vm|\beval\(|new Function\(/.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))) offenders.push(file);
  }

  assert.deepEqual(offenders, [], "RepoPilot orchestration must never run repository code");
});

test("API-side modules cannot read worker-only secrets", () => {
  const apiSide = ["routes.ts", "capabilities.ts", "rateLimit.ts", "credentials.ts", "store.ts"];

  for (const [file, text] of sources.filter(([f]) => apiSide.includes(f))) {
    assert.ok(!/loadWorkerSecrets|REPOPILOT_GITHUB_TOKEN|openCredential/.test(text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "")) || file === "credentials.ts", `${file} must not touch worker secrets`);
  }

  const index = fs.readFileSync(new URL("../../index.ts", import.meta.url), "utf-8");
  assert.ok(!/loadWorkerSecrets|openCredential/.test(index), "the API entrypoint must not load worker secrets or unseal credentials");
  assert.match(index, /workerSecretsLeakedInto/);
});

test("the only module that unseals provider keys is the AI credential resolver", () => {
  const users = sources.filter(([, text]) => /\bopenCredential\(/.test(text)).map(([f]) => f).sort();

  assert.deepEqual(users, ["ai.ts", "credentials.ts"]);
});

test("PR creation is the only code that writes to GitHub, and it cannot merge", () => {
  const writers = sources.filter(([, text]) => /request\("(POST|PUT|PATCH|DELETE)"/.test(text)).map(([f]) => f).sort();

  assert.deepEqual(writers, ["github.ts"]);
  const code = (text) => text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

  // No GitHub merge endpoint or option is referenced anywhere...
  assert.ok(!sources.some(([, text]) => /\/merge\b|merge_method|enable_auto_merge|\bmergeable\b/i.test(code(text))), "no merge endpoint is referenced");
  // ...and the word only appears as an entry in the model-output BLOCKLIST of forbidden keys.
  assert.deepEqual(sources.filter(([, text]) => /automerge/i.test(code(text))).map(([f]) => f), ["schemas.ts"]);

  const prStage = sources.find(([f]) => f === "stagesPr.ts")[1];
  assert.match(prStage, /deps\.config\.prDraft/);
  assert.ok(!/createPullRequest\([^)]*main/.test(prStage));
});

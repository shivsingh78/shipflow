import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { CredentialError, assertKeyShape, credentialFingerprint, generateCredentialKeyPair, isProvider, openCredential, parsePublicKeyPem, sealCredential } from "../../dist/src/repopilot/credentials.js";
import { loadRepoPilotConfig, loadWorkerSecrets } from "../../dist/src/repopilot/config.js";
import { createRateLimiter } from "../../dist/src/repopilot/rateLimit.js";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const pair = generateCredentialKeyPair();

test("a sealed credential round-trips only with the matching private key", () => {
  const sealed = sealCredential(pair.publicKeyPem, KEY);

  assert.notEqual(sealed, KEY);
  assert.ok(!sealed.includes(KEY));
  assert.equal(openCredential(pair.privateKeyPem, sealed), KEY);

  const other = generateCredentialKeyPair();
  assert.throws(() => openCredential(other.privateKeyPem, sealed), (e) => e instanceof CredentialError && e.code === "unseal_failed" && !e.message.includes(KEY));
  assert.throws(() => openCredential(pair.privateKeyPem, "bm90LXZhbGlk"), CredentialError);
});

test("sealing is randomised (same key, different ciphertext)", () => {
  assert.notEqual(sealCredential(pair.publicKeyPem, KEY), sealCredential(pair.publicKeyPem, KEY));
});

test("a PRIVATE key is refused where a public key is expected", () => {
  assert.throws(() => parsePublicKeyPem(pair.privateKeyPem), (e) => e instanceof CredentialError && e.code === "invalid_public_key");
  assert.throws(() => sealCredential(pair.privateKeyPem, KEY), CredentialError);
  assert.throws(() => parsePublicKeyPem("not a key"), CredentialError);
  assert.equal(parsePublicKeyPem(pair.publicKeyPem), pair.publicKeyPem);

  const small = crypto.generateKeyPairSync("rsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  assert.throws(() => parsePublicKeyPem(small.publicKey), /2048/);

  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256", publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  assert.throws(() => parsePublicKeyPem(ec.publicKey), CredentialError);
});

test("key shape is checked without echoing the key", () => {
  assert.doesNotThrow(() => assertKeyShape("anthropic", KEY));

  for (const bad of ["", "sk-ant-short", "sk-live-abcdefghijklmnopqrstuvwxyz", `${KEY} `, `${KEY}\n`, null, 5, undefined, "sk-ant-" + "a".repeat(300)]) {
    assert.throws(() => assertKeyShape("anthropic", bad), (e) => e instanceof CredentialError && e.code === "invalid_key" && (typeof bad !== "string" || bad.length < 8 || !e.message.includes(bad)));
  }

  assert.equal(isProvider("anthropic"), true);
  assert.equal(isProvider("openai"), false);
});

test("the fingerprint is short, stable and does not contain the key", () => {
  const fp = credentialFingerprint(KEY);

  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, credentialFingerprint(KEY));
  assert.notEqual(fp, credentialFingerprint(KEY + "x"));
});

// ------------------------------------------------------------------- config

test("RepoPilot and the sandbox are OFF by default", () => {
  const config = loadRepoPilotConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.sandboxMode, "off");
  assert.equal(config.credentialPublicKey, null);
  assert.deepEqual(config.problems, []);
});

test("only the exact enabling value turns the feature on", () => {
  for (const value of ["true", "1", "yes", "ENABLED", "on"]) assert.equal(loadRepoPilotConfig({ REPOPILOT: value }).enabled, false, value);
  assert.equal(loadRepoPilotConfig({ REPOPILOT: "enabled" }).enabled, true);
});

test("an unsupported sandbox mode falls back to off and is reported", () => {
  for (const mode of ["docker", "none", "local", "true"]) {
    const config = loadRepoPilotConfig({ REPOPILOT_SANDBOX: mode });
    assert.equal(config.sandboxMode, "off", mode);
    assert.ok(config.problems.some((p) => p.includes(mode)));
  }

  assert.equal(loadRepoPilotConfig({ REPOPILOT_SANDBOX: "remote" }).sandboxMode, "remote");
});

test("a private key in the API's public-key variable is rejected, not used", () => {
  const config = loadRepoPilotConfig({ REPOPILOT_CREDENTIAL_PUBLIC_KEY: pair.privateKeyPem.replace(/\n/g, "\\n") });

  assert.equal(config.credentialPublicKey, null);
  assert.ok(config.problems.some((p) => /PRIVATE/.test(p)));
  assert.ok(!JSON.stringify(config).includes("BEGIN PRIVATE"));
});

test("a valid public key is accepted, including escaped newlines", () => {
  const config = loadRepoPilotConfig({ REPOPILOT_CREDENTIAL_PUBLIC_KEY: pair.publicKeyPem.replace(/\n/g, "\\n") });

  assert.ok(config.credentialPublicKey);
  assert.deepEqual(config.problems, []);
});

test("numeric limits are validated and bounded", () => {
  assert.equal(loadRepoPilotConfig({ REPOPILOT_MAX_AI_REQUESTS: "3" }).limits.maxAiRequestsPerRun, 3);

  for (const [name, value] of [["REPOPILOT_MAX_AI_REQUESTS", "0"], ["REPOPILOT_MAX_AI_REQUESTS", "-1"], ["REPOPILOT_MAX_AI_REQUESTS", "abc"], ["REPOPILOT_MAX_AI_REQUESTS", "1000000"], ["REPOPILOT_RATE_WRITE_PER_MIN", "0"]]) {
    assert.throws(() => loadRepoPilotConfig({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
});

test("worker secrets are read separately from the shared config", () => {
  const env = { REPOPILOT_GITHUB_TOKEN: "ghp_secretvalue0123456789abcdef", REPOPILOT_CREDENTIAL_PRIVATE_KEY: pair.privateKeyPem.replace(/\n/g, "\\n") };

  assert.ok(!JSON.stringify(loadRepoPilotConfig(env)).includes("ghp_"));
  assert.ok(!JSON.stringify(loadRepoPilotConfig(env)).includes("PRIVATE"));

  const secrets = loadWorkerSecrets(env);
  assert.equal(secrets.githubToken, env.REPOPILOT_GITHUB_TOKEN);
  assert.match(secrets.credentialPrivateKey, /BEGIN PRIVATE KEY/);
  assert.deepEqual(loadWorkerSecrets({}), { githubToken: null, credentialPrivateKey: null });
});

// -------------------------------------------------------------- rate limiter

test("the limiter allows `max` per window, then refuses with a retry hint, then resets", () => {
  let now = 1_000_000;
  const limiter = createRateLimiter(() => now);
  const rule = { windowMs: 60_000, max: 3 };

  assert.deepEqual([1, 2, 3].map(() => limiter.hit("a", rule).ok), [true, true, true]);

  const blocked = limiter.hit("a", rule);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSec, 60);

  now += 30_000;
  assert.equal(limiter.hit("a", rule).retryAfterSec, 30);
  assert.equal(limiter.hit("b", rule).ok, true, "keys are independent");

  now += 31_000;
  assert.equal(limiter.hit("a", rule).ok, true, "a new window starts");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { REDACTED, redactSensitive, sanitizeForStorage } from "../../dist/src/repopilot/redact.js";

const SECRETS = [
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-abcdefghijklmnopqrstuvwxyz",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "gho_abcdefghijklmnopqrstuvwxyz0123456789",
  "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
  "AKIAIOSFODNN7EXAMPLE",
];

test("known credential formats are redacted wherever they appear", () => {
  for (const secret of SECRETS) {
    for (const text of [secret, `error: ${secret} rejected`, `{"key":"${secret}"}`, `x=${secret};y`]) {
      const out = redactSensitive(text);
      assert.ok(!out.includes(secret), `${secret} leaked in ${text}`);
    }
  }
});

test("authorization headers, URL credentials, env assignments and PEM blocks are redacted", () => {
  const cases = [
    ["Authorization: Bearer abcdefghijklmnop1234", "abcdefghijklmnop1234"],
    ["authorization: token abcdefghijklmnop1234", "abcdefghijklmnop1234"],
    ["git clone https://user:hunter2pw@github.com/a/b", "hunter2pw"],
    ["GITHUB_TOKEN=abc123secretvalue run", "abc123secretvalue"],
    ["ANTHROPIC_API_KEY=whatever-value-here", "whatever-value-here"],
    ["DB_PASSWORD=p@ssw0rd!", "p@ssw0rd!"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----", "MIIBOgIBAAJBAK"],
    ["-----BEGIN PRIVATE KEY-----\nTRUNCATEDKEYDATA", "TRUNCATEDKEYDATA"],
    // lower-case and structured forms
    ["connect failed password=hunter2 at host", "hunter2"],
    ["api_key=abc123verysecret", "abc123verysecret"],
    ["apiKey: s3cr3tvalue123", "s3cr3tvalue123"],
    ['{"password": "hunter2-json"}', "hunter2-json"],
    ["{'client_secret':'sekrit-value-1'}", "sekrit-value-1"],
    ['{"Authorization":"abcd1234efgh5678"}', "abcd1234efgh5678"],
    ["x-access-token: abcdefghij12345", "abcdefghij12345"],
  ];

  for (const [text, secret] of cases) {
    const out = redactSensitive(text);
    assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
    assert.ok(out.includes(REDACTED));
  }
});

test("ordinary text and code survive unchanged", () => {
  for (const text of ["TypeError: Cannot read properties of undefined", "src/app.ts:42:7", "Tests: 12 passed", "the sky is blue", "https://github.com/acme/widgets"]) {
    assert.equal(redactSensitive(text), text);
  }
});

test("storage sanitising drops sensitive keys, scrubs and bounds strings, depth and breadth", () => {
  const out = sanitizeForStorage({
    apiKey: "x", githubToken: "y", Authorization: "z", password: "p", cookie: "c", credentials: "d",
    ok: "fine", note: `see ${SECRETS[0]}`, long: "a".repeat(2000),
    nested: { secret: "s", keep: 1, deep: { deeper: { deepest: { x: { y: { z: 1 } } } } } },
    list: Array.from({ length: 80 }, (_, i) => i),
  });

  for (const key of ["apiKey", "githubToken", "Authorization", "password", "cookie", "credentials"]) assert.equal(out[key], REDACTED, key);
  assert.equal(out.ok, "fine");
  assert.ok(!out.note.includes("sk-ant"));
  assert.ok(out.long.length <= 501);
  assert.equal(out.nested.secret, REDACTED);
  assert.equal(out.nested.keep, 1);
  assert.equal(out.list.length, 50);
  assert.ok(JSON.stringify(out).includes("[truncated]"));
});

test("non-JSON values are dropped rather than stringified", () => {
  assert.equal(sanitizeForStorage(undefined), undefined);
  assert.equal(sanitizeForStorage(() => 1), undefined);
  assert.equal(sanitizeForStorage(null), null);
});

test("token COUNTERS are left alone but token VALUES are not", () => {
  const usage = '{"inputTokens": 1200, "output_tokens": 300, "max_tokens": 4096}';

  assert.equal(redactSensitive(usage), usage);
  assert.ok(!redactSensitive("token: 1234567890abcdef").includes("1234567890abcdef"));
  assert.ok(!redactSensitive('"access_token": "abc123def456"').includes("abc123def456"));
  assert.ok(!redactSensitive("MY_TOKEN=12345678").includes("12345678"));
});

test("redacting JSON text keeps it valid JSON", () => {
  const doc = JSON.stringify({ usage: { inputTokens: 5, outputTokens: 6 }, password: "hunter2", nested: { api_key: "abc", ok: "fine" }, note: `see ${"sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"}` }, null, 2);
  const out = redactSensitive(doc);
  const parsed = JSON.parse(out);

  assert.equal(parsed.usage.inputTokens, 5);
  assert.equal(parsed.password, REDACTED);
  assert.equal(parsed.nested.api_key, REDACTED);
  assert.equal(parsed.nested.ok, "fine");
  assert.ok(!out.includes("hunter2") && !out.includes("sk-ant"));
});

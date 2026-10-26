// Guards the unit-test isolation set up in test/unit/setup.js.
import { test, after } from "node:test";
import assert from "node:assert/strict";

import { config } from "../../dist/src/config.js";
import { pool } from "../../dist/src/db.js";

after(() => pool.end());

test("unit tests never load .env or inherit cloud credentials", () => {
  assert.equal(process.env.SHIPFLOW_NO_DOTENV, "1", "run unit tests with `pnpm test` (preloads test/unit/setup.js)");
  assert.equal(process.env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(process.env.AWS_SECRET_KEY, undefined);
  assert.equal(config.s3.bucket, undefined);
  assert.equal(config.artifactStore, "local");
});

test("the database pool points at a reserved, unreachable host", () => {
  assert.equal(pool.options.host, "unit-tests.shipflow.invalid");
  assert.notEqual(pool.options.host, "127.0.0.1");
  assert.notEqual(pool.options.host, "localhost");
});

test("an unmocked database call fails fast instead of reaching a real server", async () => {
  const started = Date.now();

  await assert.rejects(pool.query("SELECT 1"), (error) => {
    assert.match(error.code ?? error.message, /ENOTFOUND|EAI_AGAIN/);
    return true;
  });

  assert.ok(Date.now() - started < 15_000, "failed promptly");
});

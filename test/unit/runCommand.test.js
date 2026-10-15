import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runCommand,
  runCommandOrThrow,
  redactSecrets,
  CommandError,
} from "../../src/runCommand.js";

const node = process.execPath;

test("captures output and exit code", async () => {
  const result = await runCommand(
    node,
    ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
    { timeoutMs: 10_000 }
  );

  assert.equal(result.exitCode, 3);
  assert.match(result.output, /out/);
  assert.match(result.output, /err/);
});

test("keeps only the tail of very large output", async () => {
  const result = await runCommand(
    node,
    ["-e", "for (let i = 0; i < 20000; i++) console.log('line ' + i)"],
    { timeoutMs: 10_000, maxOutputBytes: 1000 }
  );

  assert.equal(result.exitCode, 0);
  assert.ok(result.output.length < 1100);
  assert.match(result.output, /^\[output truncated\]/);
  assert.match(result.output, /line 19999/);
});

test("kills commands that exceed the timeout", async () => {
  const result = await runCommand(node, ["-e", "setTimeout(() => {}, 60000)"], {
    timeoutMs: 300,
  });

  assert.equal(result.timedOut, true);
});

test("runCommandOrThrow keeps output on failure", async () => {
  await assert.rejects(
    runCommandOrThrow("Build", node, ["-e", "console.error('boom'); process.exit(2)"], {
      timeoutMs: 10_000,
    }),
    (error) => {
      assert.ok(error instanceof CommandError);
      assert.match(error.message, /Build failed with exit code 2/);
      assert.match(error.result.output, /boom/);
      return true;
    }
  );
});

test("reports a missing executable instead of crashing", async () => {
  const result = await runCommand("definitely-not-a-real-binary", [], {
    timeoutMs: 5_000,
  });

  assert.equal(result.exitCode, null);
  assert.match(result.output, /ENOENT/);
});

test("redactSecrets hides secret env values", () => {
  const env = {
    AWS_SECRET_ACCESS_KEY: "super-secret-value",
    SHIPFLOW_API_TOKEN: "token-123456",
    PATH: "/usr/bin",
  };

  const text = redactSecrets(
    "key=super-secret-value token=token-123456 path=/usr/bin",
    env
  );

  assert.equal(text, "key=[REDACTED] token=[REDACTED] path=/usr/bin");
});

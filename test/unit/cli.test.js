import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const CLI = fileURLToPath(new URL("../../cli/index.js", import.meta.url));
const TOKEN = "cli-test-token";

let server;
let apiUrl;

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: {
          PATH: process.env.PATH,
          SHIPFLOW_API_URL: apiUrl,
          SHIPFLOW_API_TOKEN: TOKEN,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      }
    );
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(res, 401, { success: false, message: "Missing or invalid API token" });
    }

    if (req.url === "/releases/Missing1/logs") {
      return json(res, 404, { success: false, message: "Release Missing1 not found" });
    }

    if (req.url === "/releases/Queued01/logs") {
      return json(res, 200, {
        success: true,
        release: { release_id: "Queued01", status: "QUEUED", current_stage: "RELEASE" },
        logs: [],
        notifications: [],
      });
    }

    if (req.url === "/releases/Done0001/logs") {
      return json(res, 200, {
        success: true,
        release: { release_id: "Done0001", status: "FAILED", current_stage: "TEST" },
        logs: [{ stage: "TEST", level: "ERROR", message: "Tests failed with exit code 1" }],
        notifications: [{ type: "RELEASE_FAILED", message: "Release Done0001 failed during TEST" }],
      });
    }

    if (req.url === "/rollback/Failed01" && req.method === "POST") {
      return json(res, 409, {
        success: false,
        message: "Release Failed01 cannot be a rollback target: status is FAILED",
      });
    }

    if (req.url === "/rollback/Good0001" && req.method === "POST") {
      return json(res, 200, {
        success: true,
        rollback: { previousReleaseId: "Newer001", targetReleaseId: "Good0001" },
      });
    }

    return json(res, 404, { success: false, message: "Not found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("logs for an unknown release shows the API's not-found message", async () => {
  const result = await runCli(["logs", "Missing1"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Release Missing1 not found \(HTTP 404\)/);
});

test("logs for a queued release explains there are no logs yet", async () => {
  const result = await runCli(["logs", "Queued01"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /still waiting for a worker/);
});

test("logs prints stage logs and notifications", async () => {
  const result = await runCli(["logs", "Done0001"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[TEST\] \[ERROR\] Tests failed/);
  assert.match(result.stdout, /RELEASE_FAILED/);
});

test("rollback reports success and API errors", async () => {
  const ok = await runCli(["rollback", "Good0001"]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /Newer001 → Good0001/);

  const bad = await runCli(["rollback", "Failed01"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /cannot be a rollback target/);
});

test("missing token gives a hint", async () => {
  const result = await runCli(["releases"], { SHIPFLOW_API_TOKEN: "" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Set SHIPFLOW_API_TOKEN/);
});

test("unreachable API gives a useful diagnostic", async () => {
  // Find a port that is free, then close it so nothing is listening.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const closedUrl = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));

  const result = await runCli(["releases"], { SHIPFLOW_API_URL: closedUrl });

  assert.equal(result.code, 1);
  assert.ok(
    result.stderr.includes(`Cannot reach ShipFlow API at ${closedUrl} (ECONNREFUSED)`),
    result.stderr
  );
});

test("missing arguments and unknown commands print usage", async () => {
  const missing = await runCli(["status"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Usage: shipflow status <releaseId>/);

  const unknown = await runCli(["explode"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command: explode/);

  const help = await runCli([]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /shipflow rollback <releaseId>/);
});

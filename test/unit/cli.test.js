import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const CLI = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
const TOKEN = "cli-test-token";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

let server;
let apiUrl;
let configHome;
const requests = [];
let statusPolls = 0;

/** Run the CLI in a temp working directory with an isolated config home. */
function runCli(args, { env = {}, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd ?? configHome,
      env: {
        PATH: process.env.PATH,
        XDG_CONFIG_HOME: configHome,
        SHIPFLOW_API_URL: apiUrl,
        SHIPFLOW_API_TOKEN: TOKEN,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(input ?? "");
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const release = (overrides = {}) => ({
  release_id: "Proj0001",
  project: "my-site",
  repo_url: "https://github.com/me/site",
  status: "QUEUED",
  current_stage: "RELEASE",
  created_at: "now",
  updated_at: "now",
  ...overrides,
});

before(async () => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cli-"));

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });

      if (req.url === "/health") return json(res, 200, { success: true });

      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return json(res, 401, { success: false, message: "Missing or invalid API token" });
      }

      if (req.url === "/whoami") return json(res, 200, { success: true, instance: "test", targets: [], artifactStore: "local:/x" });
      if (req.url === "/ready") return json(res, 200, { success: true, checks: [{ name: "postgres", ok: true, detail: "ok" }] });

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

      if (req.url === "/projects/my-site" && req.method === "PUT") {
        const needsKey = body.includes('"ssh"');
        return json(res, 200, {
          success: true,
          project: { name: "my-site" },
          requiredSecrets: needsKey ? ["SSH_PRIVATE_KEY"] : [],
          missingSecrets: needsKey ? ["SSH_PRIVATE_KEY"] : [],
        });
      }

      if (req.url === "/deploy" && req.method === "POST") {
        return json(res, 202, { success: true, release: release() });
      }

      if (req.url === "/releases/Proj0001") {
        statusPolls += 1;
        return json(res, 200, {
          success: true,
          release:
            statusPolls < 2
              ? release({ status: "RUNNING", current_stage: "BUILD" })
              : release({ status: "SUCCESS", current_stage: "ACTIVATE", test_status: "PASSED", public_deployment_url: "https://site.example/" }),
        });
      }

      if (req.url === "/projects/my-site/secrets/SSH_PRIVATE_KEY" && req.method === "PUT") {
        return json(res, 200, { success: true });
      }

      return json(res, 404, { success: false, message: "Not found" });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function projectDir(config) {
  const dir = fs.mkdtempSync(path.join(configHome, "proj-"));
  if (config) fs.writeFileSync(path.join(dir, "shipflow.yml"), config);
  return dir;
}

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

test("logs prints stage logs and notifications, or JSON", async () => {
  const result = await runCli(["logs", "Done0001"]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\[TEST\] \[ERROR\] Tests failed/);
  assert.match(result.stdout, /RELEASE_FAILED/);

  const asJson = await runCli(["logs", "Done0001", "--json"]);
  assert.equal(JSON.parse(asJson.stdout).logs[0].stage, "TEST");
});

test("rollback reports success and API errors", async () => {
  const ok = await runCli(["rollback", "Good0001"]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /Newer001 → Good0001/);

  const bad = await runCli(["rollback", "Failed01"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /cannot be a rollback target/);
});

test("missing token gives a hint and exit code 3", async () => {
  const result = await runCli(["releases"], { env: { SHIPFLOW_API_TOKEN: "" } });

  assert.equal(result.code, 3);
  assert.match(result.stderr, /Set SHIPFLOW_API_TOKEN/);
  assert.match(result.stderr, /shipflow login/);
});

test("unreachable API gives a useful diagnostic and exit code 3", async () => {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const closedUrl = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));

  const result = await runCli(["releases"], { env: { SHIPFLOW_API_URL: closedUrl } });

  assert.equal(result.code, 3);
  assert.ok(
    result.stderr.includes(`Cannot reach ShipFlow API at ${closedUrl} (ECONNREFUSED)`),
    result.stderr
  );
});

test("usage errors exit with 2", async () => {
  const missing = await runCli(["status"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Usage: shipflow status <releaseId>/);

  const unknown = await runCli(["explode"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command: explode/);

  const badFlag = await runCli(["releases", "--bogus"]);
  assert.equal(badFlag.code, 2);

  const help = await runCli([]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /shipflow rollback <releaseId>/);
  assert.match(help.stdout, /shipflow init/);
});

test("init --yes writes a valid shipflow.yml without prompting", async () => {
  const dir = projectDir();
  const result = await runCli(
    ["init", "--yes", "--name", "my-site", "--repo", "https://github.com/me/site", "--output", "dist"],
    { cwd: dir }
  );

  assert.equal(result.code, 0, result.stderr);
  const text = fs.readFileSync(path.join(dir, "shipflow.yml"), "utf8");
  assert.match(text, /Do NOT put secrets here/);
  assert.match(text, /name: my-site/);
  assert.match(text, /output: dist/);
  assert.match(text, /target: shipflow/);

  const again = await runCli(["init", "--yes"], { cwd: dir });
  assert.equal(again.code, 2, "refuses to overwrite");
});

test("init reports invalid answers with field names", async () => {
  const dir = projectDir();
  const result = await runCli(
    ["init", "--yes", "--name", "Bad Name", "--repo", "https://github.com/me/site", "--target", "ssh", "--ssh-host", "vps", "--ssh-user", "root", "--ssh-path", "/", "--url", "https://x.example"],
    { cwd: dir }
  );

  assert.equal(result.code, 2);
  assert.match(result.stderr, /project\.name/);
  assert.match(result.stderr, /deployment\.ssh\.user/);
  assert.match(result.stderr, /deployment\.ssh\.path/);
  assert.match(result.stderr, /deployment\.ssh\.hostKey/);
  assert.equal(fs.existsSync(path.join(dir, "shipflow.yml")), false);
});

test("deploy with an invalid shipflow.yml exits 2 before contacting the server", async () => {
  const dir = projectDir("version: 1\nproject:\n  name: my-site\n  repository: https://github.com/me/site\ndeployment:\n  target: netlify\n");
  const before = requests.length;
  const result = await runCli(["deploy"], { cwd: dir });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /deployment.target: unsupported target "netlify"/);
  assert.equal(requests.length, before);
});

test("deploy registers the project, queues it and follows it to success", async () => {
  statusPolls = 0;
  const dir = projectDir(
    "version: 1\nproject:\n  name: my-site\n  repository: https://github.com/me/site\ndeployment:\n  target: shipflow\n"
  );
  const result = await runCli(["deploy", "--ref", "main"], { cwd: dir });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Deployment successful/);
  assert.match(result.stdout, /URL: https:\/\/site.example\//);

  const put = requests.find((r) => r.method === "PUT" && r.url === "/projects/my-site");
  assert.equal(put.body.config.project.name, "my-site");
  const post = requests.filter((r) => r.url === "/deploy").at(-1);
  assert.deepEqual(post.body, { project: "my-site", ref: "main" });
});

test("deploy stops with exit 2 when the target's secret is missing", async () => {
  const dir = projectDir(
    [
      "version: 1",
      "project:",
      "  name: my-site",
      "  repository: https://github.com/me/site",
      "deployment:",
      "  target: ssh",
      "  ssh:",
      "    host: vps.example.com",
      "    user: deploy",
      "    path: /srv/my-site",
      `    hostKey: ${HOST_KEY}`,
      "    url: https://my-site.example.com",
      "",
    ].join("\n")
  );
  const result = await runCli(["deploy"], { cwd: dir });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Missing secret\(s\) on the server: SSH_PRIVATE_KEY/);
  assert.match(result.stderr, /shipflow secrets set SSH_PRIVATE_KEY --project my-site/);
});

test("secrets set reads the value from stdin and never prints it", async () => {
  const result = await runCli(["secrets", "set", "SSH_PRIVATE_KEY", "--project", "my-site"], {
    input: "-----BEGIN OPENSSH PRIVATE KEY-----\nverysecretvalue\n-----END OPENSSH PRIVATE KEY-----\n",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /verysecretvalue/);
  const put = requests.filter((r) => r.url === "/projects/my-site/secrets/SSH_PRIVATE_KEY").at(-1);
  assert.match(put.body.value, /verysecretvalue/);
});

test("login stores the token 0600 and only sends it to that server", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sf-login-"));
  const env = { XDG_CONFIG_HOME: home, SHIPFLOW_API_TOKEN: "", SHIPFLOW_API_URL: "" };

  const login = await runCli(["login", "--server", apiUrl, "--token-stdin"], { env, input: `${TOKEN}\n` });
  assert.equal(login.code, 0, login.stderr);

  const file = path.join(home, "shipflow", "credentials.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

  const ok = await runCli(["releases"], { env });
  assert.notEqual(ok.code, 3, "saved token is used for the saved server");

  // Pointing the CLI at a different server must not leak the saved token.
  const other = http.createServer((req, res) => {
    other.seenAuth = req.headers.authorization;
    json(res, 401, { message: "no" });
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  await runCli(["releases"], { env: { ...env, SHIPFLOW_API_URL: `http://127.0.0.1:${other.address().port}` } });
  other.close();
  assert.equal(other.seenAuth, undefined);
});

test("login refuses plain HTTP to a remote server", async () => {
  const result = await runCli(["login", "--server", "http://shipflow.example.com", "--token-stdin"], { input: "x\n" });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Refusing to send the API token over plain HTTP/);
});

test("doctor reports each check and fails when the server is unreachable", async () => {
  const result = await runCli(["doctor", "--json"], { env: { SHIPFLOW_API_URL: "http://127.0.0.1:1" } });
  const report = JSON.parse(result.stdout);

  assert.equal(result.code, 1);
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.name === "server reachable" && !c.ok));

  const good = await runCli(["doctor"]);
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /✔ authentication/);
});

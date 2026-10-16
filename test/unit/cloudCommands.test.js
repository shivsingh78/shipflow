// Argument parsing, entry-point behaviour and exit codes of `shipflow cloud`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

import { CLOUD_USAGE, parseCloudArgs, runCloud } from "../../cli/lib/cloud/commands.js";
import { UsageError } from "../../cli/lib/errors.js";
import { createFakeDeps, createFakeIo } from "./helpers/cloudHarness.js";

const CLI = fileURLToPath(new URL("../../cli/index.js", import.meta.url));
const CLOUD_DIR = fileURLToPath(new URL("../../cli/lib/cloud/", import.meta.url));

function runCli(args, { env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sf-cloud-cli-"));

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH, XDG_CONFIG_HOME: home, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr, home }));
  });
}

test("there is no --yes: creating or destroying always needs the typed confirmation", () => {
  for (const [sub, word] of [["deploy", "CREATE"], ["destroy", "DESTROY"], ["status", "CREATE"]]) {
    for (const flag of ["--yes", "-y"]) {
      assert.throws(
        () => parseCloudArgs(sub, [flag]),
        (error) => error instanceof UsageError && error.message.includes("there is no --yes") && error.message.includes(sub === "destroy" ? "DESTROY" : word),
        `${sub} ${flag}`
      );
    }
  }
});

test("AWS credentials are never accepted as command-line options", () => {
  for (const flag of ["--access-key-id", "--secret-access-key", "--session-token", "--aws-secret", "--token"]) {
    assert.throws(
      () => parseCloudArgs("deploy", [flag, "AKIAFAKEFAKEFAKE1234"]),
      (error) => error instanceof UsageError && /never accepted as command-line options/.test(error.message) && !error.message.includes("AKIAFAKE"),
      flag
    );
  }
});

test("valid flags parse; unknown flags and positional arguments are rejected", () => {
  assert.deepEqual(
    { ...parseCloudArgs("deploy", ["--region", "ap-south-1", "--name", "site", "--ssh-cidr", "198.51.100.7", "--profile", "work"]) },
    { region: "ap-south-1", name: "site", "ssh-cidr": "198.51.100.7", profile: "work" }
  );
  assert.deepEqual({ ...parseCloudArgs("status", ["--id", "sf-0000abcd", "--json", "--default-credentials"]) }, {
    id: "sf-0000abcd",
    json: true,
    "default-credentials": true,
  });

  assert.throws(() => parseCloudArgs("deploy", ["--bogus"]), /Unknown option '--bogus'[\s\S]*Usage:/);
  assert.throws(() => parseCloudArgs("destroy", ["sf-0000abcd"]), /Unexpected argument: sf-0000abcd/);
  assert.throws(() => parseCloudArgs("status", ["--region", "x"]), UsageError, "status has no --region");
});

test("the usage text documents the safety rules", () => {
  assert.match(CLOUD_USAGE, /never accepted as command-line options/);
  assert.match(CLOUD_USAGE, /there is no --yes/);
  for (const word of ["deploy", "status", "destroy", "--ssh-cidr", "--profile"]) assert.ok(CLOUD_USAGE.includes(word), word);
});

test("runCloud: help, unknown subcommands and non-interactive guards", async () => {
  const noDeps = () => assert.fail("must not build dependencies for these cases");
  const noIo = () => ({ interactive: false });

  assert.equal(await runCloud([], { createDeps: noDeps }), 0);
  assert.equal(await runCloud(["help"], { createDeps: noDeps }), 0);
  assert.equal(await runCloud(["deploy", "--help"], { createDeps: noDeps }), 0);
  await assert.rejects(runCloud(["frobnicate"], { createDeps: noDeps }), /Unknown cloud command: frobnicate/);

  for (const sub of ["deploy", "destroy"]) {
    await assert.rejects(
      runCloud([sub], { createDeps: noDeps, createIo: noIo }),
      (error) => error instanceof UsageError && /interactive terminal/.test(error.message),
      sub
    );
  }
});

test("runCloud status works non-interactively and releases the terminal", async () => {
  const h = await createFakeDeps();
  let closed = false;
  const io = Object.assign(createFakeIo({ interactive: false }), { close: () => (closed = true) });

  assert.equal(await runCloud(["status"], { createDeps: () => h.deps, createIo: () => io }), 0);
  assert.equal(closed, true);
  assert.match(io.text(), /No ShipFlow cloud deployments are recorded/);
});

test("spawned CLI: help, exit codes and messages", async () => {
  const help = await runCli(["cloud", "help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /shipflow cloud deploy/);

  const unknown = await runCli(["cloud", "nope"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown cloud command: nope/);

  const yes = await runCli(["cloud", "deploy", "--yes"]);
  assert.equal(yes.code, 2);
  assert.match(yes.stderr, /there is no --yes/);

  const creds = await runCli(["cloud", "deploy", "--secret-access-key", "abc"]);
  assert.equal(creds.code, 2);
  assert.match(creds.stderr, /never accepted as command-line options/);
  assert.doesNotMatch(creds.stderr, /abc\b/);

  const headless = await runCli(["cloud", "deploy"]);
  assert.equal(headless.code, 2);
  assert.match(headless.stderr, /interactive terminal/);

  const destroy = await runCli(["cloud", "destroy"]);
  assert.equal(destroy.code, 2);

  const empty = await runCli(["cloud", "status"]);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /No ShipFlow cloud deployments are recorded in .*cloud/);
});

test("spawned CLI: the global help lists the cloud commands and every pre-existing command", async () => {
  const help = await runCli([]);

  assert.equal(help.code, 0);
  for (const command of ["login", "logout", "init", "deploy", "status", "releases", "logs", "rollback", "cancel", "secrets", "projects", "targets", "doctor", "cloud deploy|status|destroy"]) {
    assert.ok(help.stdout.includes(command), `help lost "${command}"`);
  }

  const unknown = await runCli(["explode"]);
  assert.equal(unknown.code, 2);
});

test("the AWS SDK is only loaded by the cloud commands, never at startup", () => {
  // Static imports of the SDK anywhere in the CLI would slow down every command.
  const offenders = [];

  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith(".js") && /^\s*import\s[^(]*from\s+["']@aws-sdk/m.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
    }
  };

  scan(path.dirname(CLOUD_DIR.replace(/\/$/, "")));
  scan(path.dirname(CLI));

  assert.deepEqual(offenders, []);
  assert.match(fs.readFileSync(path.join(CLOUD_DIR, "aws.js"), "utf8"), /await Promise\.all\(\[\s*import\("@aws-sdk\/client-ec2"\)/);
  assert.match(fs.readFileSync(CLI, "utf8"), /await import\("\.\/lib\/cloud\/commands\.js"\)/);
});

test("the CLI package declares the AWS SDK dependencies and ships the cloud code", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(CLI), "package.json"), "utf8"));

  assert.match(pkg.dependencies["@aws-sdk/client-ec2"], /^\^3\./);
  assert.match(pkg.dependencies["@aws-sdk/client-sts"], /^\^3\./);
  assert.ok(pkg.dependencies.yaml);
  assert.ok(pkg.files.includes("lib/"), "lib/ (including lib/cloud) is packaged");
});

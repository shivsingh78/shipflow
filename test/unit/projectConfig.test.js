import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateProjectConfig,
  requiredSecrets,
  ProjectConfigError,
} from "../../cli/dist/lib/projectConfig.js";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

const base = () => ({
  version: 1,
  project: { name: "my-site", repository: "https://github.com/me/site" },
  deployment: { target: "shipflow" },
});

const sshConfig = () => ({
  ...base(),
  deployment: {
    target: "ssh",
    ssh: {
      host: "vps.example.com",
      user: "deploy",
      path: "/srv/my-site",
      hostKey: HOST_KEY,
      url: "https://my-site.example.com",
    },
  },
});

function errorsOf(input) {
  try {
    validateProjectConfig(input);
  } catch (error) {
    assert.ok(error instanceof ProjectConfigError);
    return error.errors.map((e) => e.path);
  }
  assert.fail("expected validation to fail");
}

test("minimal config gets safe defaults", () => {
  const config = validateProjectConfig(base());

  assert.equal(config.project.branch, "main");
  assert.deepEqual(config.build, { install: "auto", command: "auto", output: "auto", test: "auto", env: {} });
  assert.deepEqual(config.verification, { path: "/", expectStatus: 200 });
  assert.equal(config.github.deployOnPush, false, "never deploy on push unless asked");
  assert.equal(config.github.checkPullRequests, true);
  assert.deepEqual(requiredSecrets(config), []);
});

test("ssh target is validated and names its secret", () => {
  const config = validateProjectConfig(sshConfig());

  assert.equal(config.deployment.ssh.port, 22);
  assert.equal(config.deployment.ssh.privateKeySecret, "SSH_PRIVATE_KEY");
  assert.deepEqual(requiredSecrets(config), ["SSH_PRIVATE_KEY"]);
});

test("version, required fields and unknown fields are reported with paths", () => {
  assert.deepEqual(errorsOf({}), ["version", "project", "project.name", "project.repository", "deployment", "deployment.target"]);
  assert.ok(errorsOf({ ...base(), version: 2 }).includes("version"));
  assert.ok(errorsOf({ ...base(), extra: true }).includes("(root).extra"));
  assert.ok(errorsOf({ ...base(), build: { comand: "x" } }).includes("build.comand"));
});

test("unsupported targets and mismatched target settings are rejected", () => {
  assert.ok(errorsOf({ ...base(), deployment: { target: "vercel" } }).includes("deployment.target"));
  assert.ok(
    errorsOf({ ...base(), deployment: { target: "shipflow", ssh: { host: "x" } } }).includes("deployment.ssh")
  );
});

test("paths cannot escape or point at dangerous locations", () => {
  assert.ok(errorsOf({ ...base(), build: { output: "../etc" } }).includes("build.output"));
  assert.ok(errorsOf({ ...base(), build: { output: "/abs" } }).includes("build.output"));

  for (const path of ["/", "/srv", "/srv/../etc", "relative/dir", "/srv/my site", "/srv/a;rm"]) {
    const input = sshConfig();
    input.deployment.ssh.path = path;
    assert.ok(errorsOf(input).includes("deployment.ssh.path"), path);
  }
});

test("ssh user must not be root and host key is required", () => {
  const root = sshConfig();
  root.deployment.ssh.user = "root";
  assert.ok(errorsOf(root).includes("deployment.ssh.user"));

  const noKey = sshConfig();
  delete noKey.deployment.ssh.hostKey;
  assert.ok(errorsOf(noKey).includes("deployment.ssh.hostKey"));

  const badKey = sshConfig();
  badKey.deployment.ssh.hostKey = "ssh-ed25519 AAAA; rm -rf /";
  assert.ok(errorsOf(badKey).includes("deployment.ssh.hostKey"));
});

test("secrets are refused in the file", () => {
  const withKey = sshConfig();
  withKey.deployment.ssh.privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc";
  const paths = errorsOf(withKey);
  assert.ok(paths.includes("(root).deployment.ssh.privateKey"));

  const envSecret = { ...base(), build: { env: { API_TOKEN: "x" } } };
  assert.ok(errorsOf(envSecret).includes("(root).build.env.API_TOKEN"));

  const awsKey = { ...base(), build: { env: { PUBLIC: "AKIAABCDEFGHIJKLMNOP" } } };
  assert.ok(errorsOf(awsKey).some((p) => p.endsWith("build.env.PUBLIC")));

  const creds = base();
  creds.project.repository = "https://user:pass@github.com/me/site";
  assert.ok(errorsOf(creds).includes("project.repository"));
});

test("public build environment values are allowed and stringified", () => {
  const config = validateProjectConfig({ ...base(), build: { env: { VITE_API_URL: "https://api.example.com", RETRIES: 3 } } });
  assert.deepEqual(config.build.env, { VITE_API_URL: "https://api.example.com", RETRIES: "3" });
});

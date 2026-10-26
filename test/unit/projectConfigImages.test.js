import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateProjectConfig,
  requiredSecrets,
  ProjectConfigError,
} from "../../cli/dist/lib/projectConfig.js";
import { artifactOf, imageKey, isImageDigest } from "../../dist/src/artifacts.js";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const DIGEST = `sha256:${"a".repeat(64)}`;

const dockerConfig = () => ({
  version: 1,
  project: { name: "api", repository: "https://github.com/me/api" },
  runtime: { port: 3000, env: { LOG_LEVEL: "info" }, secrets: ["DATABASE_URL"] },
  deployment: {
    target: "docker",
    docker: { host: "docker.example.com", user: "deploy", hostKey: HOST_KEY, url: "https://api.example.com" },
  },
});

const k8sConfig = () => ({
  version: 1,
  project: { name: "api", repository: "https://github.com/me/api" },
  build: { strategy: "dockerfile", dockerfile: "docker/Dockerfile" },
  runtime: { port: 8080 },
  deployment: {
    target: "kubernetes",
    kubernetes: { namespace: "apps", registry: "registry.example.com/team", url: "https://api.example.com" },
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

test("docker target config gets safe defaults and names its secrets", () => {
  const config = validateProjectConfig(dockerConfig());

  assert.equal(config.deployment.docker.port, 22);
  assert.equal(config.deployment.docker.publishPort, 80);
  assert.equal(config.deployment.docker.privateKeySecret, "SSH_PRIVATE_KEY");
  assert.deepEqual(config.runtime, { port: 3000, env: { LOG_LEVEL: "info" }, secrets: ["DATABASE_URL"] });
  assert.deepEqual(requiredSecrets(config), ["SSH_PRIVATE_KEY", "DATABASE_URL"]);
  assert.equal("strategy" in config.build, false, "strategy stays unset (auto) unless given");
});

test("kubernetes target config is validated", () => {
  const config = validateProjectConfig(k8sConfig());

  assert.equal(config.build.strategy, "dockerfile");
  assert.equal(config.build.dockerfile, "docker/Dockerfile");
  assert.equal(config.deployment.kubernetes.replicas, 1);
  assert.equal(config.deployment.kubernetes.kubeconfigSecret, "KUBECONFIG");
  assert.deepEqual(requiredSecrets(config), ["KUBECONFIG"]);

  const withAuth = k8sConfig();
  withAuth.deployment.kubernetes.registryAuthSecret = "REGISTRY_AUTH";
  assert.deepEqual(requiredSecrets(validateProjectConfig(withAuth)), ["KUBECONFIG", "REGISTRY_AUTH"]);

  for (const registry of ["https://registry.example.com", "registry.example.com/team:latest", "UPPER/case", ""]) {
    const bad = k8sConfig();
    bad.deployment.kubernetes.registry = registry;
    assert.ok(errorsOf(bad).includes("deployment.kubernetes.registry"), registry);
  }

  const badNamespace = k8sConfig();
  badNamespace.deployment.kubernetes.namespace = "Not_Valid";
  assert.ok(errorsOf(badNamespace).includes("deployment.kubernetes.namespace"));
});

test("image targets need runtime.port; static targets reject runtime and image strategies", () => {
  const noRuntime = dockerConfig();
  delete noRuntime.runtime;
  assert.ok(errorsOf(noRuntime).includes("runtime"));

  const noPort = dockerConfig();
  delete noPort.runtime.port;
  assert.ok(errorsOf(noPort).includes("runtime.port"));

  const staticTarget = { version: 1, project: { name: "s", repository: "https://github.com/me/s" }, deployment: { target: "shipflow" } };
  assert.ok(errorsOf({ ...staticTarget, runtime: { port: 80 } }).includes("runtime"));
  assert.ok(errorsOf({ ...staticTarget, build: { strategy: "node" } }).includes("build.strategy"));
  assert.ok(errorsOf({ ...staticTarget, build: { strategy: "bogus" } }).includes("build.strategy"));

  const staticOnDocker = dockerConfig();
  staticOnDocker.build = { strategy: "static" };
  assert.ok(errorsOf(staticOnDocker).includes("build.strategy"));

  // Unchanged v1 behaviour: an explicit static strategy on a static target is fine.
  assert.equal(validateProjectConfig({ ...staticTarget, build: { strategy: "static" } }).build.strategy, "static");
});

test("runtime secrets are names only, and runtime env cannot carry secrets", () => {
  const badName = dockerConfig();
  badName.runtime.secrets = ["lower"];
  assert.ok(errorsOf(badName).includes("runtime.secrets[0]"));

  const secretValue = dockerConfig();
  secretValue.runtime.env = { DB_PASSWORD: "hunter2" };
  assert.ok(errorsOf(secretValue).some((p) => p.endsWith("runtime.env.DB_PASSWORD")));
});

test("artifacts: legacy releases are static; image artifacts must carry a valid digest", () => {
  assert.deepEqual(artifactOf({ artifact_path: "releases/R1/build" }), { type: "static", path: "releases/R1/build", fileCount: 0 });
  assert.equal(artifactOf({ artifact_path: null }), null);

  const image = { type: "image", key: imageKey("R2"), digest: DIGEST, sizeBytes: 10, port: 3000 };
  assert.deepEqual(artifactOf({ artifact_type: "image", artifact: image, artifact_path: "releases/R2/image" }), image);
  assert.equal(artifactOf({ artifact: { ...image, digest: "latest" } }), null, "mutable references are never accepted");
  assert.equal(isImageDigest(DIGEST), true);
  assert.equal(isImageDigest("sha256:abc"), false);
});

test("kubernetes derives object names from the project name, so it must be short", () => {
  const long = k8sConfig();
  long.project.name = "a".repeat(36);
  assert.ok(errorsOf(long).includes("project.name"));

  const ok = k8sConfig();
  ok.project.name = "a".repeat(35);
  assert.equal(validateProjectConfig(ok).project.name.length, 35);
});

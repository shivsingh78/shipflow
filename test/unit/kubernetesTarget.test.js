// The Kubernetes target is verified ONLY against the in-process fake API server
// below and a fake docker runner. No real cluster is involved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";

import { parseKubeconfig, createK8sClient } from "../../dist/src/targets/k8sClient.js";
import {
  createKubernetesTarget,
  buildDeployment,
  buildEnvSecret,
  buildLiveService,
  buildCandidateService,
  releaseNames,
  selectDeploymentsToDelete,
  parsePushDigest,
} from "../../dist/src/targets/kubernetes.js";
import { getTarget } from "../../dist/src/targets/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const REG_DIGEST = `sha256:${"b".repeat(64)}`;
const TOKEN = "super-secret-token-value";
const DB_PASSWORD = "hunter2-db-password";
const AUTH = "dXNlcjpwYXNzd29yZC1zZWNyZXQ=";
const DOCKER_CONFIG = JSON.stringify({ auths: { "registry.example.com": { auth: AUTH } } });

const b64 = (text) => Buffer.from(text).toString("base64");

function kubeconfig(server, user = { token: TOKEN }) {
  return [
    "apiVersion: v1",
    "kind: Config",
    "current-context: ctx",
    "contexts:",
    "- name: ctx",
    "  context: { cluster: c, user: u }",
    "clusters:",
    "- name: c",
    `  cluster: { server: "${server}" }`,
    "users:",
    "- name: u",
    `  user: ${JSON.stringify(user)}`,
  ].join("\n");
}

// ---- fake Kubernetes API server

class FakeCluster {
  constructor() {
    this.requests = [];
    this.objects = new Map(); // "kind/ns/name" -> object
    this.mode = "ready"; // ready | pullbackoff | never
    this.proxyStatus = 200;
    this.clock = 0;
    this.allowed = true;
    this.namespaces = new Set(["apps"]);
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => this.handle(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  stop() {
    this.server.close();
  }

  find(kind) {
    return [...this.objects.entries()].filter(([key]) => key.startsWith(`${kind}/`)).map(([, v]) => v);
  }

  get(kind, name) {
    return [...this.objects.entries()].find(([key]) => key === `${kind}/apps/${name}`)?.[1];
  }

  handle(req, res, body) {
    const url = new URL(req.url, "http://x");
    this.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof json === "string" ? json : JSON.stringify(json));
    };
    const p = url.pathname;
    let m;

    if (p === "/version") return send(200, { gitVersion: "v1.30.0+k3s1" });

    if (p === "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews") {
      return send(201, { status: { allowed: this.allowed } });
    }

    if ((m = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(p))) {
      return this.namespaces.has(m[1]) ? send(200, { metadata: { name: m[1] } }) : send(404, { message: "not found" });
    }

    if (p === "/api/v1/namespaces" && req.method === "POST") {
      this.namespaces.add(JSON.parse(body).metadata.name);
      return send(201, {});
    }

    if ((m = /^\/apis\/apps\/v1\/namespaces\/([^/]+)\/deployments(?:\/([^/]+))?$/.exec(p))) {
      return this.resource("Deployment", m[1], m[2], req, url, body, send);
    }

    if ((m = /^\/api\/v1\/namespaces\/([^/]+)\/(services|secrets)(?:\/([^/]+))?$/.exec(p))) {
      return this.resource(m[2] === "services" ? "Service" : "Secret", m[1], m[3], req, url, body, send);
    }

    if (/^\/api\/v1\/namespaces\/([^/]+)\/pods$/.test(p)) {
      const selector = decodeURIComponent(url.searchParams.get("labelSelector") ?? "");
      const release = /release=(.+)$/.exec(selector)?.[1];
      const items = [];

      if (release && this.find("Deployment").some((d) => d.metadata.labels["shipflow.io/release"] === release)) {
        const waiting = this.mode === "pullbackoff" ? { reason: "ImagePullBackOff" } : this.mode === "never" ? { reason: "ContainerCreating" } : undefined;
        items.push({
          metadata: { name: `pod-${release}-1` },
          status: { phase: "Pending", containerStatuses: [{ restartCount: 0, state: waiting ? { waiting } : { running: {} } }] },
        });
      }

      return send(200, { items });
    }

    if (/^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/.test(p)) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`failed to pull image; token ${TOKEN} leaked?\nline two\n`);
    }

    if (/^\/api\/v1\/namespaces\/([^/]+)\/services\/([^/]+):(\d+)\/proxy\/(.*)$/.test(p)) {
      return send(this.proxyStatus, "ok");
    }

    return send(404, { message: `unhandled ${req.method} ${p}` });
  }

  resource(kind, ns, name, req, url, body, send) {
    if (!name) {
      const selector = decodeURIComponent(url.searchParams.get("labelSelector") ?? "");
      const project = /project=(.+)$/.exec(selector)?.[1];
      const items = this.find(kind).filter((o) => !project || o.metadata.labels?.["shipflow.io/project"] === project);
      return send(200, { items: items.map((o) => this.withStatus(o)) });
    }

    const key = `${kind}/${ns}/${name}`;

    if (req.method === "GET") {
      const object = this.objects.get(key);
      return object ? send(200, this.withStatus(object)) : send(404, { message: "not found" });
    }

    if (req.method === "PATCH") {
      assert.equal(req.headers["content-type"], "application/apply-patch+yaml");
      assert.match(url.search, /fieldManager=shipflow/);
      assert.match(url.search, /force=true/);
      const object = JSON.parse(body);
      const existing = this.objects.get(key);
      object.metadata.creationTimestamp = existing?.metadata.creationTimestamp ?? new Date(Date.UTC(2026, 0, 1, 0, 0, ++this.clock)).toISOString();
      this.objects.set(key, object);
      return send(existing ? 200 : 201, object);
    }

    if (req.method === "DELETE") {
      return this.objects.delete(key) ? send(200, {}) : send(404, { message: "not found" });
    }

    return send(405, {});
  }

  withStatus(object) {
    if (object.kind !== "Deployment") return object;
    const replicas = object.spec.replicas;
    const ready = this.mode === "ready" ? replicas : 0;
    return { ...object, status: { readyReplicas: ready, updatedReplicas: ready } };
  }
}

const clusters = [];

async function cluster() {
  const c = new FakeCluster();
  await c.start();
  clusters.push(c);
  return c;
}

after(() => clusters.forEach((c) => c.stop()));

// ---- fake docker runner

function fakeDocker({ loadOutput = `Loaded image ID: ${DIGEST}\n`, pushOutput } = {}) {
  const calls = [];
  const run = async (label, command, args, options) => {
    const call = { label, command, args, env: options?.env, pushConfig: null, configDir: null };
    calls.push(call);

    if (args[0] === "push") {
      call.configDir = options.env.DOCKER_CONFIG;
      call.pushConfig = await fs.readFile(`${call.configDir}/config.json`, "utf8");
      call.mode = (await fs.stat(call.configDir)).mode & 0o777;
      return { exitCode: 0, signal: null, timedOut: false, output: pushOutput ?? `latest: digest: ${REG_DIGEST} size: 1234\n` };
    }
    if (args[0] === "load") return { exitCode: 0, signal: null, timedOut: false, output: loadOutput };
    if (args.join(" ").includes("RepoDigests")) {
      const repo = args.at(-1).replace(/:[^:/]+$/, "");
      return { exitCode: 0, signal: null, timedOut: false, output: `${repo}@${REG_DIGEST}\n` };
    }
    return { exitCode: 0, signal: null, timedOut: false, output: "" };
  };
  return { run, calls };
}

function makeTarget(docker, extra = {}) {
  return createKubernetesTarget({
    run: docker.run,
    sleep: async () => {},
    readyTimeoutMs: 30,
    pollMs: 1,
    candidateAttempts: 2,
    candidateRetryMs: 0,
    liveAttempts: 2,
    liveRetryMs: 0,
    httpGet: async () => ({ status: 200, headers: {}, body: Buffer.from("ok") }),
    ...extra,
  });
}

function makeCtx(fake, overrides = {}, logs = []) {
  return {
    project: "demo",
    releaseId: "AbCd1234",
    targetConfig: {
      kubeconfigSecret: "KUBECONFIG",
      namespace: "apps",
      registry: "registry.example.com/team",
      registryAuthSecret: "REGISTRY_AUTH",
      replicas: 2,
      url: "https://demo.example.com",
    },
    verification: { path: "/healthz", expectStatus: 200 },
    secrets: { KUBECONFIG: kubeconfig(fake.url), REGISTRY_AUTH: DOCKER_CONFIG, DB_PASSWORD },
    artifact: { type: "image", key: "releases/AbCd1234/image/image.tar", digest: DIGEST, sizeBytes: 10, port: 3000 },
    runtime: { port: 3000, env: { NODE_ENV: "production" }, secrets: ["DB_PASSWORD"] },
    ensureArtifactDir: async () => {
      throw new Error("not used");
    },
    ensureImageArchive: async () => "/tmp/fake-image.tar",
    log: (message, level) => logs.push({ message, level }),
    ...overrides,
  };
}

const noSecretsIn = (text) => {
  for (const secret of [TOKEN, DB_PASSWORD, AUTH]) assert.ok(!text.includes(secret), `leaked ${secret}`);
};

// ---- kubeconfig

test("parseKubeconfig reads server, CA and token", () => {
  const conn = parseKubeconfig(
    kubeconfig("https://k8s.example.com:6443", { token: "t" }).replace("{ server:", `{ certificate-authority-data: "${b64("PEM")}", server:`)
  );
  assert.equal(conn.server.host, "k8s.example.com:6443");
  assert.equal(conn.ca, "PEM");
  assert.equal(conn.auth.token, "t");
});

test("parseKubeconfig reads client certificate auth", () => {
  const conn = parseKubeconfig(kubeconfig("https://k8s.example.com", { "client-certificate-data": b64("CERT"), "client-key-data": b64("KEY") }));
  assert.equal(conn.auth.clientCertificate, "CERT");
  assert.equal(conn.auth.clientKey, "KEY");
});

test("parseKubeconfig rejects exec and auth-provider plugins", () => {
  assert.throws(() => parseKubeconfig(kubeconfig("https://k.example.com", { exec: { command: "sh" } })), /exec plugin/);
  assert.throws(() => parseKubeconfig(kubeconfig("https://k.example.com", { "auth-provider": { name: "gcp" } })), /auth-provider/);
});

test("parseKubeconfig rejects file references, remote http and insecure TLS", () => {
  assert.throws(() => parseKubeconfig(kubeconfig("https://k.example.com", { tokenFile: "/etc/x" })), /refers to a file/);
  assert.throws(() => parseKubeconfig(kubeconfig("http://k.example.com")), /plain http/);
  assert.throws(() => parseKubeconfig(kubeconfig("https://k.example.com").replace("{ server:", "{ insecure-skip-tls-verify: true, server:")), /TLS verification/);
  assert.doesNotThrow(() => parseKubeconfig(kubeconfig("http://127.0.0.1:8080")));
});

test("kubeconfig errors never contain kubeconfig content", () => {
  try {
    parseKubeconfig(`token: ${TOKEN}\n  : [bad yaml`);
    assert.fail("should throw");
  } catch (error) {
    noSecretsIn(error.message);
  }
});

// ---- manifests

test("manifests keep secret values out of the Deployment and use the digest image", () => {
  const image = `registry.example.com/team/demo@${REG_DIGEST}`;
  const deployment = buildDeployment(
    {
      project: "demo",
      releaseId: "AbCd1234",
      image,
      replicas: 2,
      port: 3000,
      env: { NODE_ENV: "production" },
      envSecret: releaseNames("demo", "AbCd1234").envSecret,
      pullSecret: "shipflow-demo-registry",
      verification: { path: "/healthz", expectStatus: 200 },
    },
    "apps"
  );
  const text = JSON.stringify(deployment);
  noSecretsIn(text);

  const container = deployment.spec.template.spec.containers[0];
  assert.equal(deployment.metadata.name, "shipflow-demo-abcd1234");
  assert.equal(deployment.metadata.labels["shipflow.io/project"], "demo");
  assert.equal(deployment.metadata.labels["shipflow.io/release"], "abcd1234");
  assert.equal(container.image, image);
  assert.deepEqual(container.envFrom, [{ secretRef: { name: "shipflow-demo-abcd1234-env" } }]);
  assert.deepEqual(container.env, [{ name: "NODE_ENV", value: "production" }]);
  assert.deepEqual(container.readinessProbe.httpGet, { path: "/healthz", port: 3000 });
  assert.deepEqual(container.livenessProbe.httpGet, { path: "/healthz", port: 3000 });
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(container.securityContext.readOnlyRootFilesystem, false);
  assert.ok(container.resources.limits.memory && container.resources.requests.cpu);
  assert.deepEqual(deployment.spec.template.spec.imagePullSecrets, [{ name: "shipflow-demo-registry" }]);
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
});

test("non-2xx/3xx expectations fall back to a TCP probe", () => {
  const d = buildDeployment({ project: "demo", releaseId: "abcd1234", image: "x@y", replicas: 1, port: 80, env: {}, verification: { path: "/", expectStatus: 401 } }, "apps");
  assert.deepEqual(d.spec.template.spec.containers[0].readinessProbe.tcpSocket, { port: 80 });
});

test("only the env Secret carries secret values; services select by labels", () => {
  const secret = buildEnvSecret("demo", "AbCd1234", "apps", { DB_PASSWORD });
  assert.equal(secret.data.DB_PASSWORD, b64(DB_PASSWORD));
  assert.equal(secret.metadata.name, "shipflow-demo-abcd1234-env");

  const live = buildLiveService("demo", "AbCd1234", "apps", 3000);
  assert.deepEqual(live.spec.selector, { "shipflow.io/project": "demo", "shipflow.io/release": "abcd1234" });
  assert.equal(live.spec.type, "ClusterIP");
  assert.equal(live.spec.ports[0].targetPort, 3000);
  assert.equal(buildLiveService("demo", null, "apps", 3000).spec.selector["shipflow.io/release"], "none");
  assert.equal(buildCandidateService("demo", "AbCd1234", "apps", 3000).metadata.name, "shipflow-demo-abcd1234-candidate");
});

test("object names that would exceed Kubernetes limits are rejected", () => {
  assert.throws(() => releaseNames("a".repeat(50), "AbCd1234"), /too long/);
});

test("parsePushDigest reads the registry digest", () => {
  assert.equal(parsePushDigest(`The push refers to repository\nlatest: digest: ${REG_DIGEST} size: 1\n`), REG_DIGEST);
  assert.equal(parsePushDigest("nothing"), null);
});

// ---- pruning planner

test("selectDeploymentsToDelete keeps the newest N plus the live release", () => {
  const items = ["r1", "r2", "r3", "r4", "r5", "r6"].map((release, i) => ({
    name: `shipflow-demo-${release}`,
    release,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));
  const doomed = selectDeploymentsToDelete(items, { keep: 3, liveReleaseId: "r1" }).map((d) => d.release);

  assert.deepEqual(doomed.sort(), ["r2", "r3"]);
  assert.deepEqual(selectDeploymentsToDelete(items, { keep: 3, liveReleaseId: null }).map((d) => d.release).sort(), ["r1", "r2", "r3"]);
  assert.deepEqual(selectDeploymentsToDelete(items.slice(0, 2), { keep: 3, liveReleaseId: null }), []);
});

// ---- full flow

test("happy path: prepare, verifyCandidate, activate, verifyLive", async () => {
  const fake = await cluster();
  const docker = fakeDocker();
  const target = makeTarget(docker);
  const logs = [];
  const ctx = makeCtx(fake, {}, logs);

  const prepared = await target.prepare(ctx);
  assert.match(prepared.detail, new RegExp(`registry.example.com/team/demo@${REG_DIGEST}`));

  // docker: load, tag by image ID, push with a private DOCKER_CONFIG, inspect, remove tag
  assert.deepEqual(docker.calls.map((c) => c.args[0]), ["load", "tag", "push", "image", "image"]);
  assert.equal(docker.calls[1].args[1], DIGEST);
  assert.equal(docker.calls[1].args[2], "registry.example.com/team/demo:abcd1234");
  const push = docker.calls[2];
  assert.equal(push.pushConfig, DOCKER_CONFIG);
  assert.equal(push.mode, 0o700);
  await assert.rejects(fs.stat(push.configDir), /ENOENT/);
  assert.deepEqual(docker.calls.at(-1).args, ["image", "rm", "registry.example.com/team/demo:abcd1234"]);

  const deployment = fake.get("Deployment", "shipflow-demo-abcd1234");
  assert.equal(deployment.spec.template.spec.containers[0].image, `registry.example.com/team/demo@${REG_DIGEST}`);
  assert.ok(fake.get("Service", "shipflow-demo-abcd1234-candidate"));
  assert.ok(fake.get("Secret", "shipflow-demo-registry"));
  assert.equal(fake.get("Secret", "shipflow-demo-registry").type, "kubernetes.io/dockerconfigjson");
  assert.equal(fake.get("Service", "shipflow-demo"), undefined, "nothing is live before activate");

  const verified = await target.verifyCandidate(ctx);
  assert.match(verified.detail, /2 replicas ready/);
  assert.ok(fake.requests.some((r) => r.path === "/api/v1/namespaces/apps/services/shipflow-demo-abcd1234-candidate:80/proxy/healthz"));
  assert.equal(fake.get("Service", "shipflow-demo"), undefined, "candidate verification does not go live");

  await target.activate(ctx);
  assert.equal(fake.get("Service", "shipflow-demo").spec.selector["shipflow.io/release"], "abcd1234");

  const live = await target.verifyLive(ctx);
  assert.equal(live.url, "https://demo.example.com/healthz");

  // Order of mutating requests: secrets/deployment/candidate service before the live service.
  const writes = fake.requests.filter((r) => r.method === "PATCH").map((r) => r.path.split("/").at(-1));
  assert.equal(writes.at(-1), "shipflow-demo");
  assert.ok(writes.indexOf("shipflow-demo-abcd1234") < writes.indexOf("shipflow-demo"));

  // Secret values appear only in Secret data; never in other requests, never in logs.
  for (const request of fake.requests) {
    const isSecretWrite = /\/secrets\//.test(request.path) && request.method === "PATCH";
    if (!isSecretWrite) noSecretsIn(request.body + request.path + request.search);
  }
  noSecretsIn(JSON.stringify(logs));
  assert.ok(fake.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`));
});

test("image ID mismatch refuses to push", async () => {
  const fake = await cluster();
  const docker = fakeDocker({ loadOutput: `Loaded image ID: sha256:${"c".repeat(64)}\n` });

  await assert.rejects(makeTarget(docker).prepare(makeCtx(fake)), /does not match the artifact digest/);
  assert.ok(!docker.calls.some((c) => c.args[0] === "push"));
});

test("ImagePullBackOff fails fast, deletes the candidate, redacts logs, leaves live untouched", async () => {
  const fake = await cluster();
  const target = makeTarget(fakeDocker(), { readyTimeoutMs: 60_000 });
  const first = makeCtx(fake);

  await target.prepare(first);
  await target.verifyCandidate(first);
  await target.activate(first);
  const liveBefore = JSON.stringify(fake.get("Service", "shipflow-demo"));

  fake.mode = "pullbackoff";
  const second = makeCtx(fake, { releaseId: "ZyXw9876" });
  await target.prepare(second);

  await assert.rejects(target.verifyCandidate(second), (error) => {
    assert.match(error.message, /ImagePullBackOff/);
    assert.match(error.message, /line two/);
    noSecretsIn(error.message);
    return true;
  });

  assert.equal(fake.get("Deployment", "shipflow-demo-zyxw9876"), undefined);
  assert.equal(fake.get("Service", "shipflow-demo-zyxw9876-candidate"), undefined);
  assert.equal(fake.get("Secret", "shipflow-demo-zyxw9876-env"), undefined);
  assert.equal(JSON.stringify(fake.get("Service", "shipflow-demo")), liveBefore);
  assert.ok(fake.get("Deployment", "shipflow-demo-abcd1234"), "the live release is untouched");
});

test("unready replicas time out and the candidate is deleted", async () => {
  const fake = await cluster();
  fake.mode = "never";
  const target = makeTarget(fakeDocker());
  const ctx = makeCtx(fake);

  await target.prepare(ctx);
  await assert.rejects(target.verifyCandidate(ctx), /Timed out .* ready replicas/);
  assert.equal(fake.get("Deployment", "shipflow-demo-abcd1234"), undefined);
  assert.equal(fake.get("Service", "shipflow-demo"), undefined);
});

test("a candidate answering the wrong status fails and is deleted", async () => {
  const fake = await cluster();
  fake.proxyStatus = 503;
  const target = makeTarget(fakeDocker());
  const ctx = makeCtx(fake);

  await target.prepare(ctx);
  await assert.rejects(target.verifyCandidate(ctx), /returned HTTP 503, expected 200/);
  assert.equal(fake.get("Deployment", "shipflow-demo-abcd1234"), undefined);
});

test("rollback re-activates an earlier release without pushing again", async () => {
  const fake = await cluster();
  const docker = fakeDocker();
  const target = makeTarget(docker);
  const one = makeCtx(fake);
  const two = makeCtx(fake, { releaseId: "ZyXw9876" });

  for (const ctx of [one, two]) {
    await target.prepare(ctx);
    await target.verifyCandidate(ctx);
    await target.activate(ctx);
  }
  assert.equal(fake.get("Service", "shipflow-demo").spec.selector["shipflow.io/release"], "zyxw9876");

  const pushes = docker.calls.filter((c) => c.args[0] === "push").length;
  await target.activate(one);
  assert.equal(fake.get("Service", "shipflow-demo").spec.selector["shipflow.io/release"], "abcd1234");
  assert.equal(docker.calls.filter((c) => c.args[0] === "push").length, pushes);

  // Re-preparing an existing release reuses its digest image.
  await target.prepare(one);
  assert.equal(docker.calls.filter((c) => c.args[0] === "push").length, pushes);
});

test("rollback to a pruned release recreates it first", async () => {
  const fake = await cluster();
  const docker = fakeDocker();
  const target = makeTarget(docker);
  const one = makeCtx(fake);

  await target.prepare(one);
  await target.verifyCandidate(one);
  await target.activate(one);
  fake.objects.delete("Deployment/apps/shipflow-demo-abcd1234");

  await target.activate(one);
  assert.ok(fake.get("Deployment", "shipflow-demo-abcd1234"));
  assert.equal(docker.calls.filter((c) => c.args[0] === "push").length, 2);
});

test("prepare prunes old releases but never the live one", async () => {
  const fake = await cluster();
  const target = makeTarget(fakeDocker());
  const ids = ["Rel00001", "Rel00002", "Rel00003", "Rel00004", "Rel00005", "Rel00006"];

  for (const [i, id] of ids.entries()) {
    const ctx = makeCtx(fake, { releaseId: id });
    await target.prepare(ctx);
    if (i === 0) await target.activate(ctx); // Rel00001 stays live
  }

  const left = fake.find("Deployment").map((d) => d.metadata.labels["shipflow.io/release"]).sort();
  assert.ok(left.includes("rel00001"), "live release kept");
  assert.deepEqual(left, ["rel00001", "rel00003", "rel00004", "rel00005", "rel00006"], "oldest non-live release pruned");
});

test("deactivate selects nothing and removes the failed release", async () => {
  const fake = await cluster();
  const target = makeTarget(fakeDocker());
  const ctx = makeCtx(fake);

  await target.prepare(ctx);
  await target.activate(ctx);
  await target.deactivate(ctx);

  assert.equal(fake.get("Service", "shipflow-demo").spec.selector["shipflow.io/release"], "none");
  assert.equal(fake.get("Deployment", "shipflow-demo-abcd1234"), undefined);
  assert.equal(fake.get("Secret", "shipflow-demo-abcd1234-env"), undefined);
});

test("verifyLive fails on the wrong status", async () => {
  const fake = await cluster();
  const target = makeTarget(fakeDocker(), { httpGet: async () => ({ status: 502, headers: {}, body: Buffer.alloc(0) }) });

  await assert.rejects(target.verifyLive(makeCtx(fake)), /returned HTTP 502, expected 200/);
});

test("a missing runtime secret fails before anything is applied for the Deployment", async () => {
  const fake = await cluster();
  const ctx = makeCtx(fake);
  delete ctx.secrets.DB_PASSWORD;

  await assert.rejects(makeTarget(fakeDocker()).prepare(ctx), /Secret DB_PASSWORD is not available/);
  assert.equal(fake.get("Deployment", "shipflow-demo-abcd1234"), undefined);
});

// ---- check, registry

test("check reports kubeconfig, API, namespace, permissions, registry and docker", async () => {
  const fake = await cluster();
  const checks = await makeTarget(fakeDocker()).check(makeCtx(fake));
  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));

  for (const name of ["kubeconfig", "api-server", "namespace", "permissions", "registry", "docker"]) {
    assert.ok(byName[name]?.ok, `${name}: ${byName[name]?.detail}`);
  }
  assert.match(byName["api-server"].detail, /v1.30.0/);
  noSecretsIn(JSON.stringify(checks));
});

test("check flags denied RBAC, unreachable namespace creation, bad kubeconfig and missing auth secret", async () => {
  const fake = await cluster();
  fake.allowed = false;
  const ctx = makeCtx(fake);
  delete ctx.secrets.REGISTRY_AUTH;
  const byName = Object.fromEntries((await makeTarget(fakeDocker()).check(ctx)).map((c) => [c.name, c]));

  assert.equal(byName.permissions.ok, false);
  assert.equal(byName.registry.ok, false);

  fake.namespaces.clear();
  const missing = Object.fromEntries((await makeTarget(fakeDocker()).check(ctx)).map((c) => [c.name, c]));
  assert.equal(missing.namespace.ok, false);

  const bad = makeCtx(fake, { secrets: { KUBECONFIG: kubeconfig("http://evil.example.com"), REGISTRY_AUTH: DOCKER_CONFIG } });
  const badChecks = await makeTarget(fakeDocker()).check(bad);
  assert.equal(badChecks[0].ok, false);
  assert.match(badChecks[0].detail, /plain http/);
});

test("requiredSecrets, capabilities and registration", () => {
  const target = getTarget("kubernetes");
  const config = makeCtx({ url: "http://127.0.0.1:1" }).targetConfig;

  assert.deepEqual(target.requiredSecrets(config), ["KUBECONFIG", "REGISTRY_AUTH"]);
  assert.deepEqual(target.requiredSecrets({ ...config, registryAuthSecret: undefined }), ["KUBECONFIG"]);
  assert.deepEqual(target.capabilities.artifactTypes, ["image"]);
  assert.equal(target.liveUrl({ targetConfig: config }), "https://demo.example.com");
});

test("the client sends server-side apply with the shipflow field manager", async () => {
  const fake = await cluster();
  const client = createK8sClient(kubeconfig(fake.url));

  await client.applyService("apps", buildLiveService("demo", "abcd1234", "apps", 80));
  const request = fake.requests.at(-1);

  assert.equal(request.method, "PATCH");
  assert.equal(request.headers["content-type"], "application/apply-patch+yaml");
  assert.equal(request.search, "?fieldManager=shipflow&force=true");
});

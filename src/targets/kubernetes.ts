// Target "kubernetes": run container images on a Kubernetes or K3s cluster.
//
// HONESTY NOTE: this adapter was written and tested ONLY against an in-process
// fake Kubernetes API server and a fake docker runner (test/unit/
// kubernetesTarget.test.js). No real cluster, registry or docker daemon has
// been involved. Real clusters differ (admission controllers, PodSecurity,
// registry quirks, containerd image store digests); expect a first real run to
// find problems.
//
// Availability: this target gives exactly what its parts give and no more.
//   * replicas > 1 spreads a release over several pods, which survives the loss
//     of one pod or (if the cluster has several nodes) one node
//   * a Service selector switch moves traffic to the new release; endpoint
//     propagation to kube-proxy is eventually consistent, so "atomic" means the
//     single API operation, not an instantaneous cut-over everywhere
//   * a single-node K3s with one control plane is a single point of failure:
//     if that node or its datastore is lost, the cluster and every release on
//     it is down. ShipFlow does not add control-plane redundancy.
//   * ShipFlow itself is not in the request path, but the worker must be
//     reachable to deploy or roll back.
//
// Flow (per release, nothing is ever mutated in place):
//   prepare         docker load the stored archive on the worker, check the image
//                   ID against the artifact digest, push to deployment.kubernetes
//                   .registry, read back the REGISTRY digest, and from then on
//                   reference the image only as <registry>/<project>@sha256:...
//                   Then apply per-release objects: env Secret, Deployment
//                   shipflow-<project>-<release>, candidate Service (ClusterIP).
//   verifyCandidate wait for ready replicas, fail fast on ImagePullBackOff /
//                   CrashLoopBackOff, then GET the verification path through the
//                   API server's service proxy.
//   activate        server-side-apply the live Service shipflow-<project> with a
//                   selector for this release. Rollback is the same operation
//                   for an earlier release (re-pushed first only if its
//                   Deployment was pruned).
//   verifyLive      GET deployment.kubernetes.url + verification path from the
//                   ShipFlow server. Exposing the live Service (ingress, load
//                   balancer, NodePort) is the user's responsibility and out of
//                   scope; the Service is ClusterIP on port 80.
//
// Safety rules:
//   * no kubectl and no kubeconfig plugins (see k8sClient.ts)
//   * secret values live only in Secret objects (and in the kubeconfig /
//     docker auth used locally); never in a Deployment spec, never in logs
//   * the registry auth (Docker config.json) is written to a 0700 temp
//     DOCKER_CONFIG directory for the push only and always deleted
//   * pods: no privilege escalation, all capabilities dropped, RuntimeDefault
//     seccomp, no service-account token mounted. runAsNonRoot is NOT forced:
//     Kubernetes rejects it for images whose USER is root or non-numeric, and
//     ShipFlow cannot know that for user images. Add it in your Dockerfile
//     (numeric USER) for stronger isolation.
//   * failed candidates are deleted, so they do not linger
import fs from "fs/promises";
import os from "os";
import path from "path";

import { runCommandOrThrow, redactSecrets, CommandError } from "../runCommand.js";
import { httpGet } from "../verify.js";
import type { RuntimeConfig } from "../../cli/lib/projectConfig.js";
import type { ImageArtifact } from "../artifacts.js";
import { K8sApiError, createK8sClient, httpTransport, parseKubeconfig } from "./k8sClient.js";
import type { K8sClient, K8sObject, K8sTransportFactory } from "./k8sClient.js";
import type {
  DeploymentTarget,
  KubernetesTargetConfig,
  TargetCheck,
  TargetContext,
  TargetDetail,
  TargetLiveResult,
  Verification,
} from "./types.js";

// ---- constants

export const KEEP_RELEASES = 3;
export const SERVICE_PORT = 80;
export const NO_RELEASE = "none";
export const LABEL_PROJECT = "shipflow.io/project";
export const LABEL_RELEASE = "shipflow.io/release";

export const RESOURCES = {
  requests: { cpu: "50m", memory: "128Mi" },
  limits: { cpu: "1000m", memory: "512Mi" },
} as const;

const FATAL_WAITING = new Set(["ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff", "CreateContainerConfigError", "InvalidImageName"]);
const MAX_NAME = 63;

// ---- naming

export interface ReleaseNames {
  deployment: string;
  candidateService: string;
  envSecret: string;
  releaseLabel: string;
}

export function liveServiceName(project: string): string {
  return `shipflow-${project}`;
}

export function pullSecretName(project: string): string {
  return `shipflow-${project}-registry`;
}

export function releaseNames(project: string, releaseId: string): ReleaseNames {
  const release = releaseId.toLowerCase();
  const names: ReleaseNames = {
    deployment: `shipflow-${project}-${release}`,
    candidateService: `shipflow-${project}-${release}-candidate`,
    envSecret: `shipflow-${project}-${release}-env`,
    releaseLabel: release,
  };

  if (!/^[a-z0-9][a-z0-9-]*$/.test(project) || !/^[a-z0-9]+$/.test(release)) {
    throw new Error(`Project "${project}" or release "${releaseId}" cannot be used in Kubernetes object names`);
  }

  for (const name of [names.candidateService, names.envSecret, names.deployment]) {
    if (name.length > MAX_NAME) {
      throw new Error(
        `Project name "${project}" is too long for Kubernetes object names (${name.length} > ${MAX_NAME}); use a project name of at most ${MAX_NAME - 28} characters`
      );
    }
  }

  return names;
}

export function releaseSelector(project: string, releaseId: string): Record<string, string> {
  return { [LABEL_PROJECT]: project, [LABEL_RELEASE]: releaseId.toLowerCase() };
}

function labelSelectorString(labels: Record<string, string>): string {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",");
}

// ---- manifest builders (pure)

const MANAGED = { "app.kubernetes.io/managed-by": "shipflow" };

export interface DeploymentInput {
  project: string;
  releaseId: string;
  /** Immutable reference: <registry>/<project>@sha256:... */
  image: string;
  replicas: number;
  port: number;
  env: Record<string, string>;
  /** Name of the Secret holding runtime secrets (envFrom), when there are any. */
  envSecret?: string;
  /** imagePullSecret name, when the registry needs credentials. */
  pullSecret?: string;
  verification: Verification;
}

/** The readiness/liveness probe. HTTP probes only count 200-399 as healthy, so other expectations fall back to a TCP check. */
export function buildProbe(port: number, verification: Verification): Record<string, unknown> {
  const base = { periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 3 };

  if (verification.expectStatus >= 200 && verification.expectStatus < 400) {
    return { httpGet: { path: verification.path, port }, ...base };
  }

  return { tcpSocket: { port }, ...base };
}

export function buildDeployment(input: DeploymentInput, namespace: string): K8sObject {
  const names = releaseNames(input.project, input.releaseId);
  const labels = { ...releaseSelector(input.project, input.releaseId), ...MANAGED };

  const container: Record<string, unknown> = {
    name: "app",
    image: input.image,
    imagePullPolicy: "IfNotPresent",
    ports: [{ containerPort: input.port }],
    env: Object.entries(input.env).map(([name, value]) => ({ name, value })),
    resources: RESOURCES,
    readinessProbe: buildProbe(input.port, input.verification),
    livenessProbe: { ...buildProbe(input.port, input.verification), initialDelaySeconds: 15 },
    securityContext: {
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    },
  };

  if (input.envSecret) container.envFrom = [{ secretRef: { name: input.envSecret } }];

  const podSpec: Record<string, unknown> = {
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    containers: [container],
  };

  if (input.pullSecret) podSpec.imagePullSecrets = [{ name: input.pullSecret }];

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: names.deployment, namespace, labels },
    spec: {
      replicas: input.replicas,
      revisionHistoryLimit: 0,
      progressDeadlineSeconds: 600,
      selector: { matchLabels: releaseSelector(input.project, input.releaseId) },
      template: { metadata: { labels }, spec: podSpec },
    },
  };
}

function serviceBody(name: string, namespace: string, project: string, selector: Record<string, string>, port: number, extraLabels: Record<string, string>): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace, labels: { [LABEL_PROJECT]: project, ...MANAGED, ...extraLabels } },
    spec: { type: "ClusterIP", selector, ports: [{ name: "http", port: SERVICE_PORT, targetPort: port, protocol: "TCP" }] },
  };
}

export function buildCandidateService(project: string, releaseId: string, namespace: string, port: number): K8sObject {
  const names = releaseNames(project, releaseId);

  return serviceBody(names.candidateService, namespace, project, releaseSelector(project, releaseId), port, { [LABEL_RELEASE]: names.releaseLabel });
}

/** The live Service. Changing its selector is the atomic activation; releaseId null selects nothing. */
export function buildLiveService(project: string, releaseId: string | null, namespace: string, port: number): K8sObject {
  const selector = releaseId === null ? { [LABEL_PROJECT]: project, [LABEL_RELEASE]: NO_RELEASE } : releaseSelector(project, releaseId);

  return serviceBody(liveServiceName(project), namespace, project, selector, port, {});
}

const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

/** The only object that carries secret values (in data, base64). */
export function buildEnvSecret(project: string, releaseId: string, namespace: string, values: Record<string, string>): K8sObject {
  const names = releaseNames(project, releaseId);

  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name: names.envSecret, namespace, labels: { ...releaseSelector(project, releaseId), ...MANAGED } },
    data: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, b64(value)])),
  };
}

export function buildPullSecret(project: string, namespace: string, dockerConfigJson: string): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "kubernetes.io/dockerconfigjson",
    metadata: { name: pullSecretName(project), namespace, labels: { [LABEL_PROJECT]: project, ...MANAGED } },
    data: { ".dockerconfigjson": b64(dockerConfigJson) },
  };
}

// ---- pruning planner (pure)

export interface DeploymentSummary {
  name: string;
  release: string;
  createdAt: string;
}

/** Everything except the newest `keep` deployments and the live release. */
export function selectDeploymentsToDelete(
  deployments: DeploymentSummary[],
  { keep, liveReleaseId }: { keep: number; liveReleaseId: string | null }
): DeploymentSummary[] {
  const live = liveReleaseId?.toLowerCase() ?? null;
  const newestFirst = [...deployments].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.name.localeCompare(a.name)
  );
  const kept = new Set(newestFirst.slice(0, Math.max(0, keep)).map((d) => d.name));

  return newestFirst.filter((d) => !kept.has(d.name) && d.release !== live);
}

// ---- docker helpers (pure parts)

/** Registry digest from `docker push` output ("... digest: sha256:<hex> size: N"). */
export function parsePushDigest(output: string): string | null {
  const matches = [...output.matchAll(/digest:\s*(sha256:[a-f0-9]{64})/g)];

  return matches.at(-1)?.[1] ?? null;
}

function parseLoadedImage(output: string): { id?: string; ref?: string } {
  const id = /Loaded image ID:\s*(sha256:[a-f0-9]{64})/.exec(output)?.[1];
  const ref = /Loaded image:\s*(\S+)/.exec(output)?.[1];
  const result: { id?: string; ref?: string } = {};

  if (id) result.id = id;
  if (ref) result.ref = ref;

  return result;
}

/** Strings from a docker config.json that must never appear in logs. */
function dockerAuthSecrets(configText: string): string[] {
  const values: string[] = [];

  try {
    const parsed: unknown = JSON.parse(configText);
    const auths = typeof parsed === "object" && parsed !== null && "auths" in parsed ? parsed.auths : null;

    if (typeof auths === "object" && auths !== null) {
      for (const entry of Object.values(auths as Record<string, unknown>)) {
        if (typeof entry !== "object" || entry === null) continue;
        for (const key of ["auth", "password", "identitytoken", "registrytoken"]) {
          const value = (entry as Record<string, unknown>)[key];
          if (typeof value === "string" && value.length >= 4) values.push(value);
        }
      }
    }
  } catch {
    // Reported separately by validateDockerConfig.
  }

  return values;
}

function validateDockerConfig(text: string, secretName: string): void {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Secret ${secretName} must contain a Docker config.json (valid JSON with an "auths" object)`);
  }

  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { auths?: unknown }).auths !== "object") {
    throw new Error(`Secret ${secretName} must contain a Docker config.json with an "auths" object`);
  }
}

// ---- dependencies (injectable for tests)

type Runner = typeof runCommandOrThrow;

export interface KubernetesDeps {
  run: Runner;
  makeTransport: K8sTransportFactory;
  sleep(ms: number): Promise<void>;
  dockerBin(): string;
  httpGet: typeof httpGet;
  readyTimeoutMs: number;
  pollMs: number;
  candidateAttempts: number;
  candidateRetryMs: number;
  liveAttempts: number;
  liveRetryMs: number;
  keepReleases: number;
}

const defaultDeps = (): KubernetesDeps => ({
  run: runCommandOrThrow,
  makeTransport: httpTransport,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  dockerBin: () => process.env.SHIPFLOW_DOCKER_BIN || "docker",
  httpGet,
  readyTimeoutMs: 300_000,
  pollMs: 3_000,
  candidateAttempts: 10,
  candidateRetryMs: 2_000,
  liveAttempts: 5,
  liveRetryMs: 2_000,
  keepReleases: KEEP_RELEASES,
});

// ---- adapter

interface ImageJob {
  artifact: ImageArtifact;
  runtime: RuntimeConfig;
}

function imageJob(ctx: TargetContext<KubernetesTargetConfig>): ImageJob {
  if (!ctx.artifact || ctx.artifact.type !== "image") {
    throw new Error("The kubernetes target runs container images, but this release has no image artifact");
  }
  if (!ctx.runtime) throw new Error("The kubernetes target needs runtime settings (runtime.port)");

  return { artifact: ctx.artifact, runtime: ctx.runtime };
}

function requireSecret(ctx: TargetContext<KubernetesTargetConfig>, name: string): string {
  const value = ctx.secrets[name];

  if (!value) {
    throw new Error(`Secret ${name} is not available; set it with: shipflow secrets set ${name} --project ${ctx.project}`);
  }

  return value;
}

export function createKubernetesTarget(overrides: Partial<KubernetesDeps> = {}): DeploymentTarget<KubernetesTargetConfig> {
  const deps: KubernetesDeps = { ...defaultDeps(), ...overrides };

  const redact = (ctx: TargetContext<KubernetesTargetConfig>, text: unknown): string => {
    let result = redactSecrets(text);
    const values = [...Object.values(ctx.secrets)];
    const authName = ctx.targetConfig.registryAuthSecret;

    if (authName && ctx.secrets[authName]) values.push(...dockerAuthSecrets(ctx.secrets[authName]));

    // Credentials inside the kubeconfig (the whole file is a secret, but a log line would quote only the token).
    try {
      const { auth } = parseKubeconfig(ctx.secrets[ctx.targetConfig.kubeconfigSecret] ?? "");
      for (const value of [auth.token, auth.clientKey]) if (value) values.push(value);
    } catch {
      // An unusable kubeconfig is reported elsewhere.
    }

    for (const value of values) {
      if (value.length >= 4) result = result.split(value).join("[REDACTED]");
    }

    return result;
  };

  const clientFor = (ctx: TargetContext<KubernetesTargetConfig>): K8sClient =>
    createK8sClient(requireSecret(ctx, ctx.targetConfig.kubeconfigSecret), deps.makeTransport);

  const docker = async (ctx: TargetContext<KubernetesTargetConfig>, label: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<string> => {
    try {
      return (await deps.run(label, deps.dockerBin(), args, { env, timeoutMs, maxOutputBytes: 64 * 1024 })).output;
    } catch (error) {
      if (error instanceof CommandError) {
        const tail = redact(ctx, error.result.output).trim().split("\n").slice(-6).join(" | ").slice(0, 800);
        // eslint-disable-next-line preserve-caught-error -- a cause could carry unredacted secret text
        throw new Error(`${error.message}${tail ? `: ${tail}` : ""}`);
      }
      throw error;
    }
  };

  const baseDockerEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? os.tmpdir() };
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "XDG_RUNTIME_DIR"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    return { ...env, ...extra };
  };

  /** docker load + verify + tag + push; returns the immutable image reference. */
  const pushImage = async (ctx: TargetContext<KubernetesTargetConfig>, job: ImageJob): Promise<string> => {
    const { targetConfig, project } = ctx;
    const repository = `${targetConfig.registry}/${project}`;
    const tag = `${repository}:${releaseNames(project, ctx.releaseId).releaseLabel}`;
    const env = baseDockerEnv();
    const authText = targetConfig.registryAuthSecret ? requireSecret(ctx, targetConfig.registryAuthSecret) : null;

    if (authText && targetConfig.registryAuthSecret) validateDockerConfig(authText, targetConfig.registryAuthSecret);

    const archive = await ctx.ensureImageArchive();
    const loadOutput = await docker(ctx, "docker load", ["load", "-i", archive], env, 600_000);
    const loaded = parseLoadedImage(loadOutput);
    let imageId = loaded.id;

    if (!imageId && loaded.ref) {
      imageId = (await docker(ctx, "docker image inspect", ["image", "inspect", "--format", "{{.Id}}", loaded.ref], env)).trim();
    }

    if (!imageId) throw new Error("Could not determine the loaded image ID from docker load output");

    if (imageId !== job.artifact.digest) {
      throw new Error(`Loaded image ${imageId} does not match the artifact digest ${job.artifact.digest}; refusing to push`);
    }

    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "shipflow-k8s-docker-"));
    await fs.chmod(configDir, 0o700);

    try {
      await fs.writeFile(path.join(configDir, "config.json"), authText ?? "{}", { mode: 0o600 });
      const pushEnv = baseDockerEnv({ DOCKER_CONFIG: configDir });

      await docker(ctx, "docker tag", ["tag", imageId, tag], env);
      const pushOutput = await docker(ctx, "docker push", ["push", tag], pushEnv, 900_000);
      const pushed = parsePushDigest(pushOutput);

      const inspectOutput = await docker(
        ctx,
        "docker image inspect",
        ["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", tag],
        env
      );
      const inspected = inspectOutput
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith(`${repository}@sha256:`));
      const inspectedDigest = inspected?.slice(repository.length + 1);

      if (pushed && inspectedDigest && pushed !== inspectedDigest) {
        throw new Error(`Registry digest mismatch after push (push reported ${pushed}, docker reports ${inspectedDigest})`);
      }

      const digest = inspectedDigest ?? pushed;

      if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
        throw new Error("Could not determine the registry digest of the pushed image");
      }

      return `${repository}@${digest}`;
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
      // Best effort: drop our local tag (the image ID stays referenced by nothing we need).
      try {
        await deps.run("docker image rm", deps.dockerBin(), ["image", "rm", tag], { env, timeoutMs: 60_000 });
      } catch {
        // Cleanup only.
      }
    }
  };

  const ensureNamespace = async (client: K8sClient, namespace: string, ctx: TargetContext<KubernetesTargetConfig>): Promise<void> => {
    if (await client.getNamespace(namespace)) return;

    ctx.log(`Namespace ${namespace} does not exist; creating it`);
    try {
      await client.createNamespace(namespace);
    } catch (error) {
      if (error instanceof K8sApiError && error.status === 409) return; // created concurrently
      throw error;
    }
  };

  const liveReleaseOf = async (client: K8sClient, namespace: string, project: string): Promise<string | null> => {
    const service = await client.getService(namespace, liveServiceName(project));
    const selector = service?.spec && typeof service.spec.selector === "object" && service.spec.selector !== null
      ? (service.spec.selector as Record<string, unknown>)
      : {};
    const release = selector[LABEL_RELEASE];

    return typeof release === "string" && release !== NO_RELEASE ? release : null;
  };

  const deleteRelease = async (client: K8sClient, namespace: string, project: string, releaseId: string): Promise<void> => {
    const names = releaseNames(project, releaseId);

    await client.deleteDeployment(namespace, names.deployment);
    await client.deleteService(namespace, names.candidateService);
    await client.deleteSecret(namespace, names.envSecret);
  };

  /** Delete a release's objects unless it is the live release. Never throws. */
  const discardRelease = async (client: K8sClient, ctx: TargetContext<KubernetesTargetConfig>): Promise<void> => {
    const { namespace } = ctx.targetConfig;

    try {
      if ((await liveReleaseOf(client, namespace, ctx.project)) === ctx.releaseId.toLowerCase()) return;
      await deleteRelease(client, namespace, ctx.project, ctx.releaseId);
      ctx.log(`Removed failed candidate ${ctx.releaseId} from namespace ${namespace}`);
    } catch (error) {
      ctx.log(`Could not remove candidate ${ctx.releaseId}: ${redact(ctx, (error as Error).message)}`, "warn");
    }
  };

  const prune = async (client: K8sClient, ctx: TargetContext<KubernetesTargetConfig>): Promise<void> => {
    const { namespace } = ctx.targetConfig;

    try {
      const items = await client.listDeployments(namespace, `${LABEL_PROJECT}=${ctx.project}`);
      const current = ctx.releaseId.toLowerCase();
      const summaries: DeploymentSummary[] = [];

      for (const item of items) {
        const name = item.metadata?.name;
        const release = item.metadata?.labels?.[LABEL_RELEASE];
        if (!name || !release || release === current) continue;
        summaries.push({ name, release, createdAt: item.metadata?.creationTimestamp ?? "" });
      }

      const live = await liveReleaseOf(client, namespace, ctx.project);

      for (const old of selectDeploymentsToDelete(summaries, { keep: deps.keepReleases, liveReleaseId: live })) {
        await deleteRelease(client, namespace, ctx.project, old.release);
        ctx.log(`Pruned old release ${old.release}`);
      }
    } catch (error) {
      ctx.log(`Could not prune old releases: ${redact(ctx, (error as Error).message)}`, "warn");
    }
  };

  const containerImageOf = (deployment: K8sObject): string | null => {
    const template = deployment.spec?.template as { spec?: { containers?: Array<{ image?: unknown }> } } | undefined;
    const image = template?.spec?.containers?.[0]?.image;

    return typeof image === "string" ? image : null;
  };

  const waitReady = async (client: K8sClient, ctx: TargetContext<KubernetesTargetConfig>): Promise<number> => {
    const { namespace, replicas } = ctx.targetConfig;
    const names = releaseNames(ctx.project, ctx.releaseId);
    const selector = labelSelectorString(releaseSelector(ctx.project, ctx.releaseId));
    const deadline = Date.now() + deps.readyTimeoutMs;
    let lastState = "no pods yet";

    for (;;) {
      const deployment = await client.getDeployment(namespace, names.deployment);

      if (!deployment) throw new Error(`Deployment ${names.deployment} does not exist`);

      const status = (deployment.status ?? {}) as Record<string, unknown>;
      const ready = typeof status.readyReplicas === "number" ? status.readyReplicas : 0;
      const updated = typeof status.updatedReplicas === "number" ? status.updatedReplicas : 0;

      if (ready >= replicas && updated >= replicas) return ready;

      const pods = await client.listPods(namespace, selector);
      lastState = pods.length ? pods.map((pod) => `${pod.name}: ${pod.waiting.join("/") || pod.phase}`).join("; ") : lastState;

      for (const pod of pods) {
        const fatal = pod.waiting.find((reason) => FATAL_WAITING.has(reason));

        if (fatal) {
          const logs = redact(ctx, await client.podLogTail(namespace, pod.name, 20, fatal === "CrashLoopBackOff"));
          throw new Error(
            `Pod ${pod.name} is ${fatal}${logs.trim() ? `; last log lines:\n${logs.trim()}` : ""}`
          );
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out after ${Math.round(deps.readyTimeoutMs / 1000)}s waiting for ${replicas} ready replicas of ${names.deployment} (${ready} ready; ${lastState})`);
      }

      await deps.sleep(deps.pollMs);
    }
  };

  const applyRelease = async (client: K8sClient, ctx: TargetContext<KubernetesTargetConfig>, job: ImageJob, image: string): Promise<void> => {
    const { targetConfig, project, releaseId } = ctx;
    const { namespace } = targetConfig;
    const names = releaseNames(project, releaseId);
    const input: DeploymentInput = {
      project,
      releaseId,
      image,
      replicas: targetConfig.replicas,
      port: job.runtime.port,
      env: job.runtime.env,
      verification: ctx.verification,
    };

    if (targetConfig.registryAuthSecret) {
      const text = requireSecret(ctx, targetConfig.registryAuthSecret);
      validateDockerConfig(text, targetConfig.registryAuthSecret);
      await client.applySecret(namespace, buildPullSecret(project, namespace, text));
      input.pullSecret = pullSecretName(project);
    }

    if (job.runtime.secrets.length > 0) {
      const values: Record<string, string> = {};
      for (const name of job.runtime.secrets) values[name] = requireSecret(ctx, name);
      await client.applySecret(namespace, buildEnvSecret(project, releaseId, namespace, values));
      input.envSecret = names.envSecret;
    }

    await client.applyDeployment(namespace, buildDeployment(input, namespace));
    await client.applyService(namespace, buildCandidateService(project, releaseId, namespace, job.runtime.port));
  };

  /** Shared by prepare() and a rollback to a release whose objects were pruned. */
  const prepareRelease = async (client: K8sClient, ctx: TargetContext<KubernetesTargetConfig>): Promise<TargetDetail> => {
    const job = imageJob(ctx);
    const { namespace } = ctx.targetConfig;
    const names = releaseNames(ctx.project, ctx.releaseId);

    if (!ctx.targetConfig.registry) throw new Error("deployment.kubernetes.registry is required: cluster nodes cannot read the ShipFlow artifact store");

    await ensureNamespace(client, namespace, ctx);
    await prune(client, ctx);

    const existing = await client.getDeployment(namespace, names.deployment);
    const existingImage = existing ? containerImageOf(existing) : null;
    let image: string;

    if (existingImage && existingImage.includes("@sha256:")) {
      image = existingImage;
      ctx.log(`Deployment ${names.deployment} already exists; reusing image ${image} without pushing`);
    } else {
      image = await pushImage(ctx, job);
      ctx.log(`Pushed image as ${image}`);
    }

    try {
      await applyRelease(client, ctx, job, image);
    } catch (error) {
      if (!existing) await discardRelease(client, ctx);
      throw error;
    }

    return { detail: `Applied ${names.deployment} (${ctx.targetConfig.replicas} replica${ctx.targetConfig.replicas === 1 ? "" : "s"}) using ${image}` };
  };

  return {
    name: "kubernetes",
    description: "Run a container image on a Kubernetes or K3s cluster (image pushed to your registry, referenced by digest)",
    capabilities: {
      artifactTypes: ["image"],
      candidateVerification: "http",
      atomicActivation: true,
      rollback: true,
    },

    requiredSecrets(targetConfig) {
      return [targetConfig.kubeconfigSecret, ...(targetConfig.registryAuthSecret ? [targetConfig.registryAuthSecret] : [])];
    },

    async check(ctx) {
      const { targetConfig } = ctx;
      const checks: TargetCheck[] = [];
      const add = (name: string, ok: boolean, detail: string): void => {
        checks.push({ name, ok, detail });
      };

      let client: K8sClient | null = null;

      try {
        client = clientFor(ctx);
        add("kubeconfig", true, `parsed; ${client.describe()}`);
      } catch (error) {
        add("kubeconfig", false, (error as Error).message);
      }

      if (client) {
        try {
          add("api-server", true, `reachable, version ${await client.version()}`);

          const exists = await client.getNamespace(targetConfig.namespace);
          if (exists) add("namespace", true, `${targetConfig.namespace} exists`);
          else if (await client.can(null, "create", "", "namespaces")) add("namespace", true, `${targetConfig.namespace} will be created`);
          else add("namespace", false, `${targetConfig.namespace} does not exist and this user cannot create namespaces`);

          const wanted: Array<[string, string, string[], string?]> = [
            ["apps", "deployments", ["create", "patch", "delete", "list"]],
            ["", "services", ["create", "patch", "delete"]],
            ["", "secrets", ["create", "patch", "delete"]],
            ["", "pods", ["list"]],
            ["", "pods", ["get"], "log"],
            ["", "services", ["get"], "proxy"],
          ];
          const denied: string[] = [];

          if (exists) {
            for (const [group, resource, verbs, subresource] of wanted) {
              for (const verb of verbs) {
                if (!(await client.can(targetConfig.namespace, verb, group, resource, subresource))) {
                  denied.push(`${verb} ${resource}${subresource ? `/${subresource}` : ""}`);
                }
              }
            }
            add("permissions", denied.length === 0, denied.length === 0 ? `RBAC allows what ShipFlow needs in ${targetConfig.namespace}` : `denied in ${targetConfig.namespace}: ${denied.join(", ")}`);
          }
        } catch (error) {
          add("api-server", false, redact(ctx, (error as Error).message));
        }
      }

      if (!targetConfig.registry) add("registry", false, "deployment.kubernetes.registry is required");
      else if (targetConfig.registryAuthSecret && !ctx.secrets[targetConfig.registryAuthSecret]) {
        add("registry", false, `registry ${targetConfig.registry}; secret ${targetConfig.registryAuthSecret} is not set`);
      } else add("registry", true, `${targetConfig.registry}${targetConfig.registryAuthSecret ? " (with credentials)" : " (no credentials configured)"}`);

      try {
        const output = await deps.run("docker --version", deps.dockerBin(), ["--version"], { env: baseDockerEnv(), timeoutMs: 15_000 });
        add("docker", true, output.output.trim().split("\n")[0] ?? "docker available");
      } catch {
        add("docker", false, `docker CLI "${deps.dockerBin()}" is not available on the worker (set SHIPFLOW_DOCKER_BIN)`);
      }

      return checks;
    },

    async prepare(ctx) {
      return prepareRelease(clientFor(ctx), ctx);
    },

    async verifyCandidate(ctx) {
      const client = clientFor(ctx);
      const { namespace } = ctx.targetConfig;
      const names = releaseNames(ctx.project, ctx.releaseId);
      const job = imageJob(ctx);
      let ok = false;

      try {
        const ready = await waitReady(client, ctx);
        const url = ctx.verification.path;
        let lastProblem = "";

        for (let attempt = 1; attempt <= deps.candidateAttempts; attempt++) {
          const response = await client.proxyGet(namespace, names.candidateService, SERVICE_PORT, url);

          if (response.status === ctx.verification.expectStatus) {
            ok = true;
            return { detail: `${ready} replica${ready === 1 ? "" : "s"} ready; ${url} via the API server proxy returned HTTP ${response.status}` };
          }

          lastProblem = `HTTP ${response.status}`;
          if (attempt < deps.candidateAttempts) await deps.sleep(deps.candidateRetryMs);
        }

        throw new Error(`Candidate ${url} (port ${job.runtime.port}) returned ${lastProblem}, expected ${ctx.verification.expectStatus}`);
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- a cause could carry unredacted secret text
        throw new Error(redact(ctx, (error as Error).message));
      } finally {
        if (!ok) await discardRelease(client, ctx);
      }
    },

    async activate(ctx) {
      const client = clientFor(ctx);
      const job = imageJob(ctx);
      const { namespace } = ctx.targetConfig;
      const names = releaseNames(ctx.project, ctx.releaseId);

      if (!(await client.getDeployment(namespace, names.deployment))) {
        // Rollback to a release whose objects were pruned: bring it back first.
        ctx.log(`Deployment ${names.deployment} no longer exists; recreating it before switching traffic`);
        await prepareRelease(client, ctx);
      }

      try {
        await waitReady(client, ctx);
      } catch (error) {
        // eslint-disable-next-line preserve-caught-error -- a cause could carry unredacted secret text
        throw new Error(`Refusing to activate ${ctx.releaseId}: ${redact(ctx, (error as Error).message)}`);
      }

      await client.applyService(namespace, buildLiveService(ctx.project, ctx.releaseId, namespace, job.runtime.port));
      ctx.log(`Service ${liveServiceName(ctx.project)} now selects release ${ctx.releaseId}`);
    },

    async deactivate(ctx) {
      const client = clientFor(ctx);
      const { namespace } = ctx.targetConfig;
      const port = ctx.runtime?.port ?? (ctx.artifact?.type === "image" ? ctx.artifact.port : 80);

      await client.applyService(namespace, buildLiveService(ctx.project, null, namespace, port));
      ctx.log(`Service ${liveServiceName(ctx.project)} selects no release`);

      try {
        await deleteRelease(client, namespace, ctx.project, ctx.releaseId);
      } catch (error) {
        ctx.log(`Could not delete release ${ctx.releaseId}: ${redact(ctx, (error as Error).message)}`, "warn");
      }
    },

    async verifyLive(ctx): Promise<TargetLiveResult> {
      const { targetConfig, verification } = ctx;
      const url = new URL(verification.path, targetConfig.url).toString();
      let lastError: unknown;

      for (let attempt = 1; attempt <= deps.liveAttempts; attempt++) {
        try {
          const response = await deps.httpGet(url, { timeoutMs: 10_000 });

          if (response.status !== verification.expectStatus) {
            throw new Error(`${url} returned HTTP ${response.status}, expected ${verification.expectStatus}`);
          }

          return {
            url,
            detail: `${url} returned HTTP ${response.status} (the response is not tied to this release; the live Service selector is)`,
          };
        } catch (error) {
          lastError = error;
          if (attempt < deps.liveAttempts) await deps.sleep(deps.liveRetryMs);
        }
      }

      throw lastError instanceof Error ? lastError : new Error(`${url} did not become healthy`);
    },

    liveUrl({ targetConfig }) {
      return targetConfig.url || null;
    },
  };
}

export const kubernetesTarget = createKubernetesTarget();

// Target "docker": run a container image on a separate Docker host over SSH.
//
// Trust model (same as the "ssh" target): the server's host key is pinned in
// configuration and enforced (StrictHostKeyChecking=yes), the connection uses
// a dedicated non-root user that is in the `docker` group, the private key is
// a project secret written to a 0600 temp file for one operation, no agent is
// used or forwarded. Note that docker-group membership is root-equivalent on
// that host; use a host dedicated to ShipFlow deployments.
//
// Layout on the Docker host, per project <p> and release <r>:
//   network    shipflow-<p>                   user-defined bridge network
//   proxy      shipflow-<p>-proxy             nginx, publishes publishPort -> 80
//   candidate  shipflow-<p>-<r>               the release; NO host port published
//   image tag  shipflow/<p>:<r>               tag of the loaded image (identity: digest)
//   files      ~/.shipflow/<p>/conf/default.conf   generated nginx config (mounted read-only)
//              ~/.shipflow/<p>/private/env-<r>     env file, 0600, exists only during `docker run`
//
// Flow:
//   prepare()         `docker version`; stream the stored `docker save` archive
//                     into `docker load` over ssh stdin (skipped when the tag
//                     already points at the expected image); the loaded image ID
//                     MUST equal artifact.digest or the deployment is refused;
//                     prune old releases (best effort); ensure network + proxy;
//                     write the env file (runtime.env + resolved runtime.secrets)
//                     through ssh stdin, `docker run -d` the candidate, delete the
//                     env file. Secret values never appear on a command line.
//   verifyCandidate() polls the candidate over HTTP from inside the proxy
//                     container (`docker exec proxy wget`), so no host port is
//                     needed and no extra image is pulled. It also checks the
//                     container still runs the expected image and is not
//                     crash-looping. On failure the candidate is removed and the
//                     last (redacted) log lines are put in the error.
//   activate()        writes a new nginx config (temp file + mv), runs
//                     `nginx -t`, and only then `nginx -s reload`; a failed test
//                     restores the previous config. Reload switches new
//                     connections atomically. Afterwards the other running
//                     release containers are stopped (kept, not removed).
//   deactivate()      points the proxy at a 503 "no active release" block (only
//                     when the proxy still points at this release) and removes
//                     the candidate.
//   verifyLive()      requests <url><verification.path> from the ShipFlow server.
//
// Rollback = prepare() again for the earlier release (its image is reloaded
// from the artifact store unless the tag still exists, and its container is
// recreated) followed by activate(). Releases' containers are kept stopped for
// KEEP_RELEASES releases; older containers and their image tags are removed by
// the next prepare().
//
// Hardening of release containers: --cap-drop ALL, no-new-privileges, memory /
// cpu / pids limits, user from the image. A read-only root filesystem is NOT
// forced because many applications write to unknown paths; it is a documented
// follow-up (a future runtime option) rather than a default that breaks apps.
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { createReadStream } from "fs";

import { httpGet } from "../verify.js";
import type { ImageArtifact } from "../artifacts.js";
import type { RuntimeConfig } from "../../cli/lib/projectConfig.js";
import type {
  DeploymentTarget,
  DockerTargetConfig,
  TargetCheck,
  TargetContext,
} from "./types.js";

export const PROXY_IMAGE = "nginx:1.27-alpine";
export const KEEP_RELEASES = 3;
export const LIMITS = { memory: "512m", cpus: "1", pids: "256" } as const;

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RELEASE_ID = /^[A-Za-z0-9]{8}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const SSH_USER = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const REMOTE_HOME = /^\/[A-Za-z0-9._/-]{0,200}$/;
const URL_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,500}$/;

const COMMAND_TIMEOUT_MS = 120_000;
const LOAD_TIMEOUT_MS = 600_000;
const VERIFY_WINDOW_MS = 60_000;
const VERIFY_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Validation and quoting

/** Single-quote one shell word. Rejects NUL, which no shell can carry. */
export function shellQuote(value: unknown): string {
  const text = String(value);

  if (text.includes("\0")) throw new Error("Refusing a command argument containing NUL");

  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A fully quoted command line from an argv. */
export function shellCommand(...argv: Array<string | number>): string {
  return argv.map(shellQuote).join(" ");
}

function assertProject(project: string): string {
  if (!PROJECT_NAME.test(project)) throw new Error(`Invalid project name ${JSON.stringify(project)}`);
  return project;
}

function assertRelease(releaseId: string): string {
  if (!RELEASE_ID.test(releaseId)) throw new Error(`Invalid release ID ${JSON.stringify(releaseId)}`);
  return releaseId;
}

function assertPort(port: number, what: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid ${what} ${String(port)}`);
  return port;
}

function assertTarget(config: DockerTargetConfig): void {
  if (!HOST.test(config.host)) throw new Error("Invalid deployment.docker.host");
  if (!SSH_USER.test(config.user)) throw new Error("Invalid deployment.docker.user");
  if (/[\r\n]/.test(config.hostKey) || config.hostKey.trim() === "") {
    throw new Error("Invalid deployment.docker.hostKey");
  }
  assertPort(config.port, "deployment.docker.port");
  assertPort(config.publishPort, "deployment.docker.publishPort");
}

export const networkName = (project: string): string => `shipflow-${assertProject(project)}`;
export const proxyName = (project: string): string => `shipflow-${assertProject(project)}-proxy`;
export const releaseContainerName = (project: string, releaseId: string): string =>
  `shipflow-${assertProject(project)}-${assertRelease(releaseId)}`;
export const imageTag = (project: string, releaseId: string): string =>
  `shipflow/${assertProject(project)}:${assertRelease(releaseId)}`;

// ---------------------------------------------------------------------------
// Pure helpers

export interface Upstream {
  container: string;
  port: number;
  releaseId: string;
}

const UPSTREAM_MARKER = /^# shipflow-upstream: (\S+):(\d+) release=([A-Za-z0-9]{8})$/m;

/**
 * The nginx configuration of the managed proxy: forward everything to the
 * release container, or answer 503 when there is no active release.
 */
export function renderProxyConfig(upstream: Upstream | null): string {
  if (!upstream) {
    return [
      "# managed by ShipFlow; do not edit",
      "# shipflow-upstream: none",
      "server {",
      "  listen 80 default_server;",
      "  server_name _;",
      "  location / {",
      "    default_type text/plain;",
      '    return 503 "No active release\\n";',
      "  }",
      "}",
      "",
    ].join("\n");
  }

  if (!CONTAINER_NAME.test(upstream.container)) throw new Error("Invalid upstream container name");
  assertPort(upstream.port, "upstream port");
  assertRelease(upstream.releaseId);

  return [
    "# managed by ShipFlow; do not edit",
    `# shipflow-upstream: ${upstream.container}:${upstream.port} release=${upstream.releaseId}`,
    "server {",
    "  listen 80 default_server;",
    "  server_name _;",
    "  client_max_body_size 50m;",
    "  location / {",
    `    proxy_pass http://${upstream.container}:${upstream.port};`,
    "    proxy_http_version 1.1;",
    "    proxy_set_header Host $host;",
    "    proxy_set_header X-Real-IP $remote_addr;",
    "    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "    proxy_set_header X-Forwarded-Proto $scheme;",
    "    proxy_read_timeout 60s;",
    "  }",
    "}",
    "",
  ].join("\n");
}

/** The upstream a generated config points at; null for the 503 block or unknown text. */
export function parseActiveUpstream(conf: string): Upstream | null {
  const match = UPSTREAM_MARKER.exec(conf);
  const [, container, port, releaseId] = match ?? [];

  if (!container || !port || !releaseId) return null;

  return { container, port: Number(port), releaseId };
}

/**
 * Environment file content (docker `--env-file` format) for a release:
 * public runtime.env, then the resolved runtime.secrets. PORT defaults to the
 * runtime port. Throws (naming only the variable, never a value) for invalid
 * names, missing secrets or values docker cannot carry on one line.
 */
export function buildEnvFile(runtime: RuntimeConfig, secrets: Record<string, string>): string {
  const values = new Map<string, string>([["PORT", String(runtime.port)]]);

  for (const [name, value] of Object.entries(runtime.env ?? {})) values.set(name, String(value));

  for (const name of runtime.secrets ?? []) {
    const value = secrets[name];

    if (value === undefined) {
      throw new Error(`Runtime secret ${name} is not available; set it with: shipflow secrets set ${name}`);
    }

    values.set(name, value);
  }

  const lines: string[] = [];

  for (const [name, value] of values) {
    if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name ${JSON.stringify(name)}`);
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`Environment variable ${name} contains a newline or NUL, which an env file cannot carry`);
    }
    lines.push(`${name}=${value}`);
  }

  return `${lines.join("\n")}\n`;
}

export interface ReleaseContainer {
  name: string;
  releaseId: string;
}

export interface PruneOptions {
  /** Number of newest release containers to retain. */
  keep: number;
  /** Release the proxy currently serves (always retained). */
  liveReleaseId?: string | null;
  /** Further releases that must survive (e.g. the one being prepared). */
  protectReleaseIds?: string[];
}

/**
 * Which release containers (and, by release ID, image tags) to remove.
 * `containers` is ordered newest first. Retained: the first `keep`, the live
 * release, and every protected release. Everything else is removed.
 */
export function selectContainersToRemove(
  containers: ReleaseContainer[],
  { keep, liveReleaseId = null, protectReleaseIds = [] }: PruneOptions
): ReleaseContainer[] {
  const retained = new Set<string>(protectReleaseIds);

  if (liveReleaseId) retained.add(liveReleaseId);

  containers.slice(0, Math.max(0, keep)).forEach((container) => retained.add(container.releaseId));

  return containers.filter((container) => !retained.has(container.releaseId));
}

/** Parse `name|release` lines from `docker ps`, newest first; ignores anything malformed. */
export function parseReleaseContainers(output: string, project: string): ReleaseContainer[] {
  const result: ReleaseContainer[] = [];

  for (const line of output.split("\n")) {
    const [name, releaseId] = line.trim().split("|");

    if (name && releaseId && RELEASE_ID.test(releaseId) && name === releaseContainerName(project, releaseId)) {
      result.push({ name, releaseId });
    }
  }

  return result;
}

/** Parse an HTTP status out of `wget -S` output; the last status line wins (redirects). */
export function parseWgetStatus(output: string): number | null {
  const matches = [...output.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})/g)];
  const last = matches[matches.length - 1];

  return last?.[1] ? Number(last[1]) : null;
}

/** Remove known secret values from text. */
export function redactValues(text: string, secrets: Record<string, string>): string {
  let result = text;

  for (const value of Object.values(secrets)) {
    if (value.length >= 3) result = result.split(value).join("[REDACTED]");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Remote execution (injectable)

export type RemoteStdin = { text: string } | { file: string };

export interface RemoteExecOptions {
  stdin?: RemoteStdin;
  timeoutMs?: number;
}

export interface RemoteResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export interface DockerRemote {
  /** Run one remote command line (already quoted) and return its result. */
  exec(command: string, options?: RemoteExecOptions): Promise<RemoteResult>;
  close(): Promise<void>;
}

export interface DockerTargetDeps {
  openRemote(ctx: TargetContext<DockerTargetConfig>): Promise<DockerRemote>;
  httpGet: typeof httpGet;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export function explainSshFailure(output: string, config: DockerTargetConfig): string {
  const text = output.trim().split("\n").slice(-5).join(" ").slice(0, 600);

  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) {
    return `Host key of ${config.host} does not match deployment.docker.hostKey. If the server was rebuilt, verify its new key out-of-band and update shipflow.yml. (${text})`;
  }

  if (/Permission denied \(publickey/i.test(text)) {
    return `Server rejected the key for ${config.user}@${config.host}: check the secret ${config.privateKeySecret} and the user's authorized_keys. (${text})`;
  }

  if (/Connection refused|timed out|No route to host|Could not resolve/i.test(text)) {
    return `Cannot connect to ${config.host}:${config.port}. (${text})`;
  }

  return text || "SSH command failed";
}

/** Real ssh: a 0600 key file and a pinned known_hosts file in a private temp dir. */
async function openSshRemote(ctx: TargetContext<DockerTargetConfig>): Promise<DockerRemote> {
  const { targetConfig: config, secrets } = ctx;

  assertTarget(config);

  const key = secrets[config.privateKeySecret];

  if (!key) {
    throw new Error(
      `Secret ${config.privateKeySecret} is not available; set it with: shipflow secrets set ${config.privateKeySecret} --project ${ctx.project}`
    );
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipflow-docker-"));
  const keyFile = path.join(dir, "id");
  const knownHosts = path.join(dir, "known_hosts");
  const hostEntry = config.port === 22 ? config.host : `[${config.host}]:${config.port}`;

  await fs.writeFile(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
  await fs.writeFile(knownHosts, `${hostEntry} ${config.hostKey}\n`, { mode: 0o600 });

  const args = [
    "-i", keyFile,
    "-p", String(config.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "ForwardAgent=no",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "LogLevel=ERROR",
    "-F", "/dev/null",
    "--",
    `${config.user}@${config.host}`,
  ];
  const env = { PATH: process.env.PATH, HOME: dir };

  const exec = (command: string, { stdin, timeoutMs = COMMAND_TIMEOUT_MS }: RemoteExecOptions = {}) =>
    new Promise<RemoteResult>((resolve) => {
      let output = "";
      let timedOut = false;
      const child = spawn("ssh", [...args, command], { env, stdio: ["pipe", "pipe", "pipe"] });
      const append = (chunk: Buffer): void => {
        output = (output + chunk.toString("utf8")).slice(-64 * 1024);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.stdin.on("error", () => undefined); // remote closed early; the exit code tells
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: null, timedOut, output: `${output}\n${error.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, timedOut, output });
      });

      if (stdin && "file" in stdin) {
        const source = createReadStream(stdin.file);
        source.on("error", (error) => {
          output += `\nCannot read ${path.basename(stdin.file)}: ${error.message}`;
          child.kill("SIGKILL");
        });
        source.pipe(child.stdin);
      } else {
        child.stdin.end(stdin?.text ?? "");
      }
    });

  return { exec, close: () => fs.rm(dir, { recursive: true, force: true }) };
}

const defaultDeps: DockerTargetDeps = {
  openRemote: openSshRemote,
  httpGet,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// The adapter

interface Session {
  config: DockerTargetConfig;
  /** Run and return the result; never throws for a non-zero exit. */
  exec(command: string, options?: RemoteExecOptions): Promise<RemoteResult>;
  /** Run and return stdout/stderr; throws a redacted error when it fails. */
  must(label: string, command: string, options?: RemoteExecOptions): Promise<string>;
  /** Run and ignore failure. */
  tryRun(command: string): Promise<void>;
  base: string;
}

function imageOf(ctx: TargetContext<DockerTargetConfig>): { artifact: ImageArtifact; runtime: RuntimeConfig } {
  const { artifact, runtime } = ctx;

  if (!artifact || artifact.type !== "image" || !DIGEST.test(artifact.digest)) {
    throw new Error("The docker target needs an image artifact with a sha256 digest");
  }

  if (!runtime) throw new Error("The docker target needs runtime settings (runtime.port)");

  assertPort(artifact.port, "container port");

  return { artifact, runtime };
}

export function createDockerTarget(overrides: Partial<DockerTargetDeps> = {}): DeploymentTarget<DockerTargetConfig> {
  const deps: DockerTargetDeps = { ...defaultDeps, ...overrides };

  async function withSession<T>(
    ctx: TargetContext<DockerTargetConfig>,
    work: (session: Session) => Promise<T>,
    options: { needsHome?: boolean } = {}
  ): Promise<T> {
    assertProject(ctx.project);
    assertTarget(ctx.targetConfig);

    const remote = await deps.openRemote(ctx);

    try {
      const exec: Session["exec"] = async (command, execOptions) => {
        const result = await remote.exec(command, execOptions);

        return { ...result, output: redactValues(result.output, ctx.secrets) };
      };
      const must: Session["must"] = async (label, command, execOptions) => {
        const result = await exec(command, execOptions);

        if (result.timedOut) throw new Error(`${label} timed out`);
        if (result.exitCode !== 0) {
          throw new Error(`${label} failed: ${explainSshFailure(result.output, ctx.targetConfig)}`);
        }

        return result.output;
      };
      const tryRun: Session["tryRun"] = async (command) => {
        try {
          await exec(command);
        } catch {
          // best effort
        }
      };
      let base = "";

      if (options.needsHome !== false) {
        const home = (await must("Reading the remote home directory", 'printf %s "$HOME"')).trim();

        if (!REMOTE_HOME.test(home)) throw new Error("The remote home directory is not a plain absolute path");

        base = `${home}/.shipflow/${ctx.project}`;
      }

      return await work({ config: ctx.targetConfig, exec, must, tryRun, base });
    } finally {
      await remote.close();
    }
  }

  const docker = (...argv: Array<string | number>): string => shellCommand("docker", ...argv);

  /** Write a file atomically (temp + mv). `private` uses umask 077, otherwise world-readable. */
  async function writeRemoteFile(
    session: Session,
    file: string,
    content: string,
    mode: "public" | "private"
  ): Promise<void> {
    const temp = `${file}.tmp`;

    await session.must(
      `Writing ${path.posix.basename(file)}`,
      `umask ${mode === "private" ? "077" : "022"} && cat > ${shellQuote(temp)} && mv -f ${shellQuote(temp)} ${shellQuote(file)}`,
      { stdin: { text: content } }
    );
  }

  async function readActiveUpstream(session: Session): Promise<Upstream | null> {
    const result = await session.exec(`cat ${shellQuote(`${session.base}/conf/default.conf`)}`);

    return result.exitCode === 0 ? parseActiveUpstream(result.output) : null;
  }

  async function ensureProxy(session: Session, ctx: TargetContext<DockerTargetConfig>): Promise<void> {
    const { project } = ctx;
    const proxy = proxyName(project);
    const confDir = `${session.base}/conf`;

    await session.must(
      "Creating the proxy directories",
      `mkdir -p -m 755 ${shellQuote(confDir)} && mkdir -p -m 700 ${shellQuote(`${session.base}/private`)}`
    );

    const existing = await session.exec(`test -f ${shellQuote(`${confDir}/default.conf`)}`);

    if (existing.exitCode !== 0) {
      await writeRemoteFile(session, `${confDir}/default.conf`, renderProxyConfig(null), "public");
    }

    const network = networkName(project);

    await session.must(
      "Creating the project network",
      `${docker("network", "inspect", network)} >/dev/null 2>&1 || ${docker("network", "create", network)}`
    );

    const inspect = await session.exec(docker("inspect", "-f", "{{.State.Running}}", proxy));

    if (inspect.exitCode !== 0) {
      await session.must(
        "Starting the proxy container",
        docker(
          "run", "-d", "--name", proxy, "--network", network,
          "--restart", "unless-stopped",
          "-p", `${assertPort(session.config.publishPort, "publishPort")}:80`,
          "-v", `${confDir}:/etc/nginx/conf.d:ro`,
          "--cap-drop", "ALL",
          "--cap-add", "CHOWN", "--cap-add", "SETGID", "--cap-add", "SETUID", "--cap-add", "NET_BIND_SERVICE",
          "--security-opt", "no-new-privileges",
          "--memory", "128m", "--pids-limit", "128",
          "--label", `shipflow.project=${project}`,
          "--label", "shipflow.role=proxy",
          PROXY_IMAGE
        )
      );
    } else if (!inspect.output.trim().startsWith("true")) {
      await session.must("Starting the proxy container", docker("start", proxy));
    }
  }

  async function pruneOldReleases(
    session: Session,
    ctx: TargetContext<DockerTargetConfig>
  ): Promise<void> {
    try {
      const listing = await session.exec(
        docker(
          "ps", "-a",
          "--filter", `label=shipflow.project=${ctx.project}`,
          "--filter", "label=shipflow.role=release",
          "--format", '{{.Names}}|{{.Label "shipflow.release"}}'
        )
      );

      if (listing.exitCode !== 0) return;

      const live = await readActiveUpstream(session);
      const remove = selectContainersToRemove(parseReleaseContainers(listing.output, ctx.project), {
        keep: KEEP_RELEASES,
        liveReleaseId: live?.releaseId ?? null,
        protectReleaseIds: [ctx.releaseId],
      });

      for (const container of remove) {
        await session.tryRun(docker("rm", "-f", container.name));
        await session.tryRun(docker("rmi", imageTag(ctx.project, container.releaseId)));
      }
    } catch {
      // pruning is best effort
    }
  }

  async function discardCandidate(session: Session, ctx: TargetContext<DockerTargetConfig>): Promise<void> {
    await session.tryRun(docker("rm", "-f", releaseContainerName(ctx.project, ctx.releaseId)));
  }

  async function logTail(session: Session, name: string): Promise<string> {
    const logs = await session.exec(docker("logs", "--tail", 20, name));
    const text = logs.output.trim().split("\n").slice(-20).join("\n").slice(-2000);

    return text ? ` Last log lines:\n${text}` : "";
  }

  async function setProxyConfig(session: Session, ctx: TargetContext<DockerTargetConfig>, conf: string): Promise<void> {
    const proxy = proxyName(ctx.project);
    const file = `${session.base}/conf/default.conf`;
    const previous = await session.exec(`cat ${shellQuote(file)}`);

    await writeRemoteFile(session, file, conf, "public");

    const restore = async (): Promise<void> => {
      if (previous.exitCode === 0) await writeRemoteFile(session, file, previous.output, "public");
    };

    try {
      await session.must("Testing the proxy configuration (nginx -t)", docker("exec", proxy, "nginx", "-t"));
      await session.must("Reloading the proxy", docker("exec", proxy, "nginx", "-s", "reload"));
    } catch (error) {
      try {
        await restore();
      } catch {
        // the original error matters more
      }
      throw error;
    }
  }

  return {
    name: "docker",
    description: "A container image on your own Docker host over SSH (managed nginx proxy, atomic switch)",
    capabilities: {
      artifactTypes: ["image"],
      candidateVerification: "http",
      atomicActivation: true,
      rollback: true,
    },

    requiredSecrets: (config) => [config.privateKeySecret],

    async check(ctx) {
      const config = ctx.targetConfig;
      const checks: TargetCheck[] = [];

      try {
        return await withSession(
          ctx,
          async (session) => {
            checks.push({ name: "ssh connection", ok: true, detail: `${config.user}@${config.host}:${config.port} (host key pinned)` });

            const daemon = await session.exec(docker("version", "--format", "{{.Server.Version}}"));
            const denied = /permission denied/i.test(daemon.output);

            checks.push({
              name: "docker daemon",
              ok: daemon.exitCode === 0,
              detail: daemon.exitCode === 0 ? `server ${daemon.output.trim()}` : denied ? "not accessible to this user" : daemon.output.trim().slice(-200) || "docker is not running or not installed",
            });
            checks.push({
              name: "docker permission",
              ok: daemon.exitCode === 0,
              detail: daemon.exitCode === 0 ? "ok" : `add ${config.user} to the docker group`,
            });

            const publish = assertPort(config.publishPort, "publishPort");
            const proxy = proxyName(ctx.project);
            const owners = await session.exec(docker("ps", "--filter", `publish=${publish}`, "--format", "{{.Names}}"));
            const names = owners.output.split("\n").map((line) => line.trim()).filter(Boolean);
            const foreign = names.filter((name) => name !== proxy);
            const listening = await session.exec(`(ss -ltn 2>/dev/null || true) | grep -E ${shellQuote(`:${publish}\\s`)}`);
            const busyOutsideDocker = names.length === 0 && listening.exitCode === 0 && listening.output.trim() !== "";

            checks.push({
              name: `port ${publish} free or owned by ${proxy}`,
              ok: foreign.length === 0 && !busyOutsideDocker,
              detail:
                foreign.length > 0
                  ? `published by ${foreign.join(", ")}`
                  : busyOutsideDocker
                    ? "in use by another process"
                    : names.length > 0
                      ? "owned by the ShipFlow proxy"
                      : "free",
            });
          },
          { needsHome: false }
        ).then(() => checks);
      } catch (error) {
        checks.push({ name: checks.length === 0 ? "ssh connection" : "docker host", ok: false, detail: (error as Error).message });

        return checks;
      }
    },

    async prepare(ctx) {
      const { artifact, runtime } = imageOf(ctx);
      const { project, releaseId } = ctx;
      const name = releaseContainerName(project, releaseId);
      const tag = imageTag(project, releaseId);

      return withSession(ctx, async (session) => {
        await session.must("docker is not usable on the host", docker("version", "--format", "{{.Server.Version}}"));

        const present = await session.exec(docker("image", "inspect", "--format", "{{.Id}}", tag));
        let loaded = false;

        if (present.exitCode !== 0 || present.output.trim() !== artifact.digest) {
          const archive = await ctx.ensureImageArchive();

          ctx.log(`Streaming the image (${artifact.sizeBytes} bytes) to ${session.config.host}`);
          await session.must("docker load", docker("load"), { stdin: { file: archive }, timeoutMs: LOAD_TIMEOUT_MS });

          const id = (
            await session.must("Inspecting the loaded image", docker("image", "inspect", "--format", "{{.Id}}", artifact.digest))
          ).trim();

          if (id !== artifact.digest) {
            throw new Error(`Loaded image ${id} does not match the built image ${artifact.digest}; refusing to deploy it`);
          }

          await session.must("Tagging the image", docker("tag", artifact.digest, tag));
          // The archive also carries the worker's temporary build tag; drop it here.
          await session.tryRun(
            `${docker("image", "inspect", "-f", "{{range .RepoTags}}{{println .}}{{end}}", artifact.digest)} | grep '^shipflow-build/' | xargs -r docker rmi`
          );
          loaded = true;
        }

        await pruneOldReleases(session, ctx);
        await ensureProxy(session, ctx);

        const envFile = `${session.base}/private/env-${releaseId}`;
        const network = networkName(project);

        await discardCandidate(session, ctx);

        try {
          await writeRemoteFile(session, envFile, buildEnvFile(runtime, ctx.secrets), "private");
          await session.must(
            "Starting the candidate container",
            docker(
              "run", "-d", "--name", name, "--network", network,
              "--restart", "unless-stopped",
              "--cap-drop", "ALL",
              "--security-opt", "no-new-privileges",
              "--memory", LIMITS.memory, "--cpus", LIMITS.cpus, "--pids-limit", LIMITS.pids,
              "--label", `shipflow.project=${project}`,
              "--label", `shipflow.release=${releaseId}`,
              "--label", "shipflow.role=release",
              "--label", `shipflow.image=${artifact.digest}`,
              "--env-file", envFile,
              tag
            )
          );
        } catch (error) {
          await discardCandidate(session, ctx);
          throw error;
        } finally {
          await session.tryRun(`rm -f ${shellQuote(envFile)}`);
        }

        return {
          detail: `${loaded ? "loaded" : "reused"} image ${artifact.digest.slice(0, 19)}, started ${name} (no host port published)`,
        };
      });
    },

    async verifyCandidate(ctx) {
      const { artifact } = imageOf(ctx);
      const { project, releaseId, verification } = ctx;
      const name = releaseContainerName(project, releaseId);
      const proxy = proxyName(project);

      if (!URL_PATH.test(verification.path)) throw new Error("Invalid verification path");

      return withSession(
        ctx,
        async (session) => {
          const url = `http://${name}:${artifact.port}${verification.path}`;
          const deadline = deps.now() + VERIFY_WINDOW_MS;

          try {
            for (;;) {
              const state = await session.exec(
                docker("inspect", "-f", "{{.Image}}|{{.State.Running}}|{{.State.Restarting}}|{{.RestartCount}}", name)
              );
              const [image, running, restarting, restarts] = state.output.trim().split("|");

              if (state.exitCode !== 0) throw new Error(`Candidate container ${name} does not exist`);
              if (image !== artifact.digest) {
                throw new Error(`Container ${name} runs image ${String(image)}, expected ${artifact.digest}`);
              }
              if (running !== "true" || restarting === "true" || Number(restarts) > 0) {
                throw new Error(
                  `Container ${name} is not staying up (running=${String(running)}, restarts=${String(restarts)}).${await logTail(session, name)}`
                );
              }

              const probe = await session.exec(
                `${docker("exec", proxy, "wget", "-S", "-q", "-O", "/dev/null", "-T", 5, url)} 2>&1`
              );
              const status = parseWgetStatus(probe.output);

              if (status === verification.expectStatus) {
                return { detail: `${verification.path} returned HTTP ${status} inside the Docker network` };
              }

              if (deps.now() >= deadline) {
                throw new Error(
                  `Candidate did not answer ${verification.path} with HTTP ${verification.expectStatus} within ${VERIFY_WINDOW_MS / 1000}s (last: ${status === null ? "no HTTP response" : `HTTP ${status}`}).${await logTail(session, name)}`
                );
              }

              await deps.sleep(VERIFY_INTERVAL_MS);
            }
          } catch (error) {
            await discardCandidate(session, ctx);
            throw error;
          }
        }
      );
    },

    async activate(ctx) {
      const { artifact } = imageOf(ctx);
      const { project, releaseId } = ctx;
      const name = releaseContainerName(project, releaseId);

      await withSession(ctx, async (session) => {
        const state = await session.exec(docker("inspect", "-f", "{{.State.Running}}", name));

        if (state.exitCode !== 0 || !state.output.trim().startsWith("true")) {
          throw new Error(`Container ${name} is not running; it cannot be activated`);
        }

        await setProxyConfig(session, ctx, renderProxyConfig({ container: name, port: artifact.port, releaseId }));

        // Traffic has switched; stop (keep) the other running releases.
        try {
          const running = await session.exec(
            docker(
              "ps",
              "--filter", `label=shipflow.project=${project}`,
              "--filter", "label=shipflow.role=release",
              "--format", "{{.Names}}"
            )
          );

          for (const line of running.output.split("\n")) {
            const other = line.trim();

            if (other && other !== name && other.startsWith(`shipflow-${project}-`) && CONTAINER_NAME.test(other)) {
              await session.tryRun(docker("stop", "-t", 10, other));
            }
          }
        } catch {
          // old containers lingering is harmless
        }
      });
    },

    async deactivate(ctx) {
      const { project, releaseId } = ctx;

      await withSession(ctx, async (session) => {
        const active = await readActiveUpstream(session);

        if (active?.releaseId === releaseId) {
          await setProxyConfig(session, ctx, renderProxyConfig(null));
        }

        await discardCandidate(session, ctx);
      });

      ctx.log(`Stopped serving ${releaseContainerName(project, releaseId)}`);
    },

    async verifyLive(ctx) {
      const { targetConfig, verification } = ctx;

      if (!URL_PATH.test(verification.path)) throw new Error("Invalid verification path");

      const url = new URL(verification.path, targetConfig.url).toString();
      let lastError: unknown;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const response = await deps.httpGet(url, { timeoutMs: 10_000 });

          if (response.status !== verification.expectStatus) {
            throw new Error(`${url} returned HTTP ${String(response.status)}, expected ${verification.expectStatus}`);
          }

          return { url, detail: `${url} returned HTTP ${response.status}` };
        } catch (error) {
          lastError = error;
          if (attempt < 3) await deps.sleep(2000);
        }
      }

      throw lastError;
    },

    liveUrl: ({ targetConfig }) => targetConfig.url,
  };
}

export const dockerTarget: DeploymentTarget<DockerTargetConfig> = createDockerTarget();

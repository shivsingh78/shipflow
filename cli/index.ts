#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import type { ParseArgsConfig } from "util";

type ParseOptions = NonNullable<ParseArgsConfig["options"]>;
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

import type {
  ReleaseRow,
  ReleaseResponse,
  ApiCheck,
  ReadyResponse,
} from "./deploy.js";
import {
  ApiError,
  setConnectionOverrides,
  createRelease,
  getReleaseStatus,
  getAllReleases,
  getReleaseLogs,
  getReleaseEvidence,
  rollbackRelease,
  cancelRelease,
  whoami,
  ready,
  health,
  listProjects,
  getProject,
  putProject,
  listSecrets,
  setSecret,
  deleteSecret,
  checkProjectTarget,
} from "./deploy.js";
import {
  writeCredentials,
  removeCredentials,
  resolveConnection,
  credentialsPath,
  isInsecureRemote,
} from "./lib/credentials.js";
import type { ProjectConfig } from "./lib/projectConfig.js";
import { loadConfigFile, writeConfigFile, DEFAULT_CONFIG_FILE } from "./lib/configFile.js";
import {
  validateProjectConfig,
  requiredSecrets,
  ProjectConfigError,
} from "./lib/projectConfig.js";
import { createPrompter, isInteractive, readSecret } from "./lib/prompt.js";
import { CloudError, UsageError, errorMessage } from "./lib/errors.js";
import { followRelease as followUntilFinal } from "./lib/follow.js";

// Exit codes (stable, for scripts and CI).
export const EXIT = {
  OK: 0,
  FAILED: 1, // the release/operation failed
  USAGE: 2, // bad arguments or invalid shipflow.yml
  UNAVAILABLE: 3, // server unreachable or authentication failed
  TIMEOUT: 4, // gave up waiting for a release
};

const VERSION = (
  JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
  ) as { version: string }
).version;

const USAGE = [
  "Usage:",
  "  shipflow login [--server <url>] [--token-stdin]   Save the server address and API token",
  "  shipflow logout                                  Forget the saved token",
  "  shipflow init [--yes] [options]                  Create shipflow.yml interactively",
  "  shipflow deploy [-c shipflow.yml] [--ref <ref>]  Register the project and deploy it",
  "  shipflow deploy <repoUrl>                        Deploy a repository with default settings",
  "  shipflow status <releaseId>                      Show one release",
  "  shipflow releases [--project <name>]             List recent releases",
  "  shipflow logs <releaseId>                        Show stage logs and notifications",
  "  shipflow diagnose <releaseId>                    Explain what happened to a release (deterministic)",
  "  shipflow rollback <releaseId>                    Make an earlier successful release live",
  "  shipflow cancel <releaseId>                      Stop a queued or running release",
  "  shipflow secrets set|list|rm [NAME]              Manage deployment secrets on the server",
  "  shipflow projects [name]                         List projects or show one",
  "  shipflow targets                                 List supported deployment targets",
  "  shipflow doctor [-c shipflow.yml]                Check configuration, server and target",
  "  shipflow cloud deploy|status|destroy             Temporary AWS EC2 VPS wizard (see: shipflow cloud help)",
  "",
  "Options: --json (machine-readable output), --server <url>, -h/--help, -v/--version",
  "",
  "Environment:",
  "  SHIPFLOW_API_URL    API address (default http://localhost:8000)",
  "  SHIPFLOW_API_TOKEN  API token configured on the server",
  "",
  "Exit codes: 0 ok, 1 failed, 2 usage/config error, 3 server unreachable/unauthorized, 4 timeout",
].join("\n");

let jsonMode = false;

/** Parsed flags: the shared ones are typed, per-command flags are string | boolean. */
interface Values {
  json?: boolean;
  server?: string;
  config?: string;
  project?: string;
  help?: boolean;
  [flag: string]: string | boolean | undefined;
}

/** A string flag's value, or undefined when it was not given. */
const text = (value: string | boolean | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

function out(value: unknown, human?: () => void): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else if (human) {
    human();
  }
}

function parse(
  argv: string[],
  options: ParseOptions = {},
  { positionals = 0 }: { positionals?: number } = {}
): { values: Values; positionals: string[] } {
  let parsed: { values: Values; positionals: string[] };

  try {
    const result = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        server: { type: "string" },
        config: { type: "string", short: "c" },
        project: { type: "string" },
        help: { type: "boolean", short: "h" },
        ...options,
      },
    });
    parsed = { values: result.values, positionals: result.positionals };
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }

  if (parsed.positionals.length > positionals) {
    throw new UsageError(`Unexpected argument: ${parsed.positionals[positionals]}`);
  }

  jsonMode = Boolean(parsed.values.json);
  if (parsed.values.server) setConnectionOverrides({ server: parsed.values.server });

  return parsed;
}

function requireArgument(value: string | undefined, usage: string): string {
  if (!value) {
    throw new UsageError(`Usage: ${usage}`);
  }

  return value;
}

/** The validated local shipflow.yml, or null when there is none. */
function localConfig(values: Values): ProjectConfig | null {
  try {
    return loadConfigFile(values.config ?? DEFAULT_CONFIG_FILE).config;
  } catch {
    return null;
  }
}

/** Project name from --project, or from shipflow.yml when present. */
function projectName(values: Values): string {
  if (values.project) return values.project;

  try {
    return loadConfigFile(values.config ?? DEFAULT_CONFIG_FILE).config.project.name;
  } catch {
    throw new UsageError("Specify --project <name> (or run inside a directory with shipflow.yml)");
  }
}

function printRelease(release: ReleaseRow): void {
  console.log(`Release:    ${release.release_id}${release.is_active ? "  (ACTIVE)" : ""}`);
  if (release.project && release.project !== "default") console.log(`Project:    ${release.project}`);
  console.log(`Repository: ${release.repo_url}`);
  if (release.ref) console.log(`Ref:        ${release.ref}`);
  if (release.mode === "check") console.log("Mode:       check (build and test only)");
  console.log(`Target:     ${release.target ?? "shipflow"}`);
  console.log(`Status:     ${release.status}`);
  console.log(`Stage:      ${release.current_stage}`);

  if (release.commit_sha) console.log(`Commit:     ${release.commit_sha}`);
  if (release.test_status) console.log(`Tests:      ${release.test_status}`);
  if (release.artifact_path) console.log(`Artifact:   ${release.artifact_path}`);

  if (release.is_active && release.public_deployment_url) {
    console.log(`Live URL:   ${release.public_deployment_url}`);
  }

  if (release.error_message) console.log(`Error:      ${release.error_message}`);

  console.log(`Created:    ${release.created_at}`);
  console.log(`Updated:    ${release.updated_at}`);
}

/*
|--------------------------------------------------------------------------
| LOGIN / LOGOUT
|--------------------------------------------------------------------------
*/

async function login(argv: string[]): Promise<number> {
  const { values } = parse(argv, {
    "token-stdin": { type: "boolean" },
    "allow-http": { type: "boolean" },
  });

  let server = values.server;
  let prompter;

  if (!server) {
    if (!isInteractive()) throw new UsageError("Usage: shipflow login --server <url> --token-stdin");
    prompter = createPrompter();
    server = await prompter.ask("ShipFlow server URL", { defaultValue: resolveConnection().url });
    prompter.close();
  }

  server = server.replace(/\/+$/, "");

  try {
    new URL(server);
  } catch {
    throw new UsageError(`Invalid server URL: ${server}`);
  }

  if (isInsecureRemote(server) && !values["allow-http"]) {
    throw new UsageError(
      `Refusing to send the API token over plain HTTP to ${server}. Use https:// (or --allow-http for a trusted network).`
    );
  }

  let token: string;

  if (values["token-stdin"] || !isInteractive()) {
    token = await readSecret("");
  } else {
    token = await readSecret("API token (input hidden): ");
  }

  token = token.trim();
  if (!token) throw new UsageError("No token given");

  setConnectionOverrides({ server, token });
  const info = await whoami();

  const file = writeCredentials({ server, token });

  out({ server, instance: info.instance, credentials: file }, () => {
    console.log(`✅ Logged in to ${server} (instance ${info.instance})`);
    console.log(`Token saved to ${file} (mode 600)`);
  });

  return EXIT.OK;
}

async function logout(argv: string[]): Promise<number> {
  parse(argv);
  removeCredentials();
  out({ removed: credentialsPath() }, () => console.log(`Removed ${credentialsPath()}`));
  return EXIT.OK;
}

/*
|--------------------------------------------------------------------------
| INIT
|--------------------------------------------------------------------------
*/

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** git@github.com:owner/repo.git -> https://github.com/owner/repo */
export function httpsRemote(remote: string): string {
  const ssh = /^git@([^:]+):(.+?)(\.git)?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return remote.replace(/\.git$/, "");
}

function detectDefaults() {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  } = {};

  try {
    pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as typeof pkg;
  } catch {
    // No readable package.json: detect nothing.
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const remote = git(["remote", "get-url", "origin"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

  return {
    name: path
      .basename(process.cwd())
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "my-site",
    repository: remote ? httpsRemote(remote) : "",
    branch: branch && branch !== "HEAD" ? branch : "main",
    output: deps.vite ? "dist" : "auto",
    hasBuildScript: Boolean(pkg.scripts?.build),
  };
}

function scanHostKey(host: string, port: number): { hostKey: string; fingerprint: string } | null {
  let key: string;

  try {
    key = execFileSync("ssh-keyscan", ["-t", "ed25519", "-p", String(port), host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
  } catch {
    return null;
  }

  const line = key.split("\n").find((l) => l && !l.startsWith("#"));
  if (!line) return null;

  const [, type, data] = line.split(/\s+/);
  let fingerprint = "";

  try {
    fingerprint = execFileSync("ssh-keygen", ["-lf", "-"], {
      input: `${host} ${type} ${data}\n`,
      encoding: "utf8",
    }).trim();
  } catch {
    // The fingerprint is informational; the host key is still usable.
  }

  return { hostKey: `${type} ${data}`, fingerprint };
}

async function init(argv: string[]): Promise<number> {
  const { values } = parse(argv, {
    yes: { type: "boolean", short: "y" },
    force: { type: "boolean" },
    name: { type: "string" },
    repo: { type: "string" },
    branch: { type: "string" },
    target: { type: "string" },
    build: { type: "string" },
    output: { type: "string" },
    test: { type: "string" },
    hostname: { type: "string" },
    "ssh-host": { type: "string" },
    "ssh-port": { type: "string" },
    "ssh-user": { type: "string" },
    "ssh-path": { type: "string" },
    "ssh-host-key": { type: "string" },
    "ssh-key-secret": { type: "string" },
    url: { type: "string" },
  });

  const file = values.config ?? DEFAULT_CONFIG_FILE;

  if (fs.existsSync(file) && !values.force) {
    throw new UsageError(`${file} already exists; use --force to overwrite`);
  }

  const detected = detectDefaults();
  const interactive = isInteractive() && !values.yes;

  if (!interactive && !values.yes) {
    throw new UsageError("No terminal: run `shipflow init --yes` with flags (see `shipflow init --help`)");
  }

  const p = interactive ? createPrompter() : null;
  const pick = async (flag: string, question: string, defaultValue: string): Promise<string> =>
    text(values[flag]) ?? (p ? p.ask(question, { defaultValue }) : defaultValue);

  try {
    const name = await pick("name", "Project name", detected.name);
    const repository = await pick("repo", "Git repository (https URL)", detected.repository);
    const branch = await pick("branch", "Branch to deploy", detected.branch);
    const command = await pick(
      "build",
      'Build command ("auto" runs the package.json build script)',
      detected.hasBuildScript ? "auto" : "npm run build"
    );
    const output = await pick("output", 'Build output directory ("auto" tries dist, build, out)', detected.output);
    const test = await pick("test", 'Tests ("auto" = package.json test script, "none", or a command)', "auto");

    const target =
      text(values.target) ??
      (p
        ? await p.choose(
            "Where should ShipFlow deploy this site?",
            [
              { value: "shipflow", description: "served by your ShipFlow server's site port" },
              { value: "ssh", description: "your own server/VPS over SSH (nginx, Caddy, ...)" },
            ],
            "shipflow"
          )
        : "shipflow");

    const deployment: Record<string, unknown> = { target };

    if (target === "shipflow") {
      const hostname = await pick("hostname", "Hostname to serve it on (optional, blank = default site)", "");
      deployment.shipflow = hostname ? { hostname } : {};
    } else if (target === "ssh") {
      const host = await pick("ssh-host", "Server hostname or IP", "");
      const port = Number(await pick("ssh-port", "SSH port", "22"));
      const user = await pick("ssh-user", "Deploy user (not root)", "deploy");
      const dir = await pick("ssh-path", "Directory on the server (releases/ and current go here)", `/srv/${name}`);

      let hostKey = text(values["ssh-host-key"]);

      if (!hostKey && p) {
        const scanned = scanHostKey(host, port);

        if (scanned) {
          console.error(`\nServer host key: ${scanned.fingerprint || scanned.hostKey}`);
          console.error("Compare it with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run ON the server.");
          if (await p.confirm("Does it match?", false)) hostKey = scanned.hostKey;
        }

        hostKey ??= await p.ask('Paste the server public host key ("ssh-ed25519 AAAA...")');
      }

      const privateKeySecret = await pick("ssh-key-secret", "Name of the server-side secret holding the private key", "SSH_PRIVATE_KEY");
      const url = await pick("url", "Public URL of the site (used for the live health check)", "");

      deployment.ssh = { host, port, user, path: dir, hostKey, privateKeySecret, url };
    }

    const raw = {
      version: 1,
      project: { name, repository, branch },
      build: { command, output, test },
      deployment,
    };

    const config = validateProjectConfig(raw);

    if (p && !(await p.confirm(`Write ${file}?`, true))) {
      console.error("Cancelled; nothing written.");
      return EXIT.FAILED;
    }

    const written = writeConfigFile(config, file, { overwrite: Boolean(values.force) });
    const secrets = requiredSecrets(config);

    out({ file: written, config, requiredSecrets: secrets }, () => {
      console.log(`✅ Wrote ${written}`);
      console.log("\nNext steps:");
      let step = 1;
      if (secrets.length) {
        console.log(`  ${step++}. Store the deploy key on the server (never in git):`);
        console.log(`       shipflow secrets set ${secrets[0]} --project ${config.project.name} < ~/.ssh/<deploy-key>`);
      }
      console.log(`  ${step++}. shipflow doctor`);
      console.log(`  ${step}. shipflow deploy`);
    });

    return EXIT.OK;
  } finally {
    p?.close();
  }
}

/*
|--------------------------------------------------------------------------
| DEPLOY
|--------------------------------------------------------------------------
*/

function followRelease(
  release: ReleaseRow,
  { timeoutMs, pollMs }: { timeoutMs: number; pollMs?: number }
) {
  return followUntilFinal(release, {
    timeoutMs,
    pollMs,
    onState: (state) => {
      if (!jsonMode) console.log(`→ ${state}`);
    },
  });
}

async function deploy(argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    {
      ref: { type: "string" },
      "no-wait": { type: "boolean" },
      timeout: { type: "string" },
    },
    { positionals: 1 }
  );

  const timeoutMinutes = Number(text(values.timeout) ?? 30);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new UsageError("--timeout must be a number of minutes");
  }

  let result: ReleaseResponse;

  if (positionals[0]) {
    // Legacy: deploy a repository URL with default settings.
    if (!jsonMode) console.log(`Deploying: ${positionals[0]}`);
    result = await createRelease(positionals[0]);
  } else {
    const { file, config } = loadConfigFile(values.config ?? DEFAULT_CONFIG_FILE);
    const name = config.project.name;

    if (!jsonMode) console.log(`Project ${name} (${path.relative(process.cwd(), file)}) → target ${config.deployment.target}`);

    const registered = await putProject(name, config);

    const missingSecrets = registered.missingSecrets;

    if (missingSecrets?.length) {
      out({ error: "missing secrets", missingSecrets }, () => {
        console.error(`❌ Missing secret(s) on the server: ${missingSecrets.join(", ")}`);
        console.error(`   shipflow secrets set ${missingSecrets[0]} --project ${name} < <file>`);
      });
      return EXIT.USAGE;
    }

    result = await createRelease({ project: name, ref: text(values.ref) });
  }

  const { release } = result;

  if (!jsonMode) console.log(`Release: ${release.release_id}`);

  if (values["no-wait"]) {
    out({ release }, () => console.log(`Queued. Follow it with: shipflow status ${release.release_id}`));
    return EXIT.OK;
  }

  const final = await followRelease(release, { timeoutMs: timeoutMinutes * 60_000 });

  if (!final) {
    out({ release, timedOut: true }, () =>
      console.error(`Timed out waiting for ${release.release_id}; check later with: shipflow status ${release.release_id}`)
    );
    return EXIT.TIMEOUT;
  }

  if (final.status === "SUCCESS") {
    out({ release: final }, () => {
      console.log("");
      console.log("✅ Deployment successful");
      console.log(`Tests: ${final.test_status}`);
      if (final.public_deployment_url) console.log(`URL: ${final.public_deployment_url}`);
    });
    return EXIT.OK;
  }

  out({ release: final }, () => {
    console.error("");
    console.error(final.status === "CANCELLED" ? "⚠️  Deployment cancelled" : "❌ Deployment failed");
    console.error(`Stage: ${final.current_stage}`);
    if (final.error_message) console.error(`Reason: ${final.error_message}`);
    console.error(`Details: shipflow logs ${final.release_id}`);
  });

  return EXIT.FAILED;
}

/*
|--------------------------------------------------------------------------
| STATUS / RELEASES / LOGS / ROLLBACK / CANCEL
|--------------------------------------------------------------------------
*/

async function status(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, {}, { positionals: 1 });
  const { release } = await getReleaseStatus(requireArgument(positionals[0], "shipflow status <releaseId>"));
  out({ release }, () => printRelease(release));
  return EXIT.OK;
}

async function releases(argv: string[]): Promise<number> {
  const { values } = parse(argv);
  const result = await getAllReleases(values.project);

  out({ releases: result.releases }, () => {
    if (result.releases.length === 0) {
      console.log("No releases found.");
      return;
    }

    console.log("RELEASE \tPROJECT     \tSTATUS   \tSTAGE   \tTESTS  \tCREATED");

    for (const release of result.releases) {
      console.log(
        `${release.release_id}\t${(release.project ?? "default").padEnd(12)}\t${release.status.padEnd(9)}\t${release.current_stage.padEnd(8)}\t${(release.test_status || "-").padEnd(7)}\t${release.created_at}${release.is_active ? "\t← active" : ""}`
      );
    }
  });

  return EXIT.OK;
}

async function logs(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, {}, { positionals: 1 });
  const result = await getReleaseLogs(requireArgument(positionals[0], "shipflow logs <releaseId>"));

  out(result, () => {
    console.log(
      `Release ${result.release.release_id}: ${result.release.status} (${result.release.current_stage})`
    );
    console.log("");

    if (result.logs.length === 0) {
      console.log(
        result.release.status === "QUEUED"
          ? "No logs yet: the release is still waiting for a worker."
          : "No logs recorded for this release."
      );
    }

    for (const log of result.logs) {
      console.log(`[${log.stage}] [${log.level}] ${log.message}`);
    }

    if (result.notifications.length > 0) {
      console.log("");
      console.log("Notifications:");

      for (const notification of result.notifications) {
        console.log(`  ${notification.type}: ${notification.message}`);
      }
    }
  });

  return EXIT.OK;
}

async function diagnose(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, {}, { positionals: 1 });
  const { evidence } = await getReleaseEvidence(requireArgument(positionals[0], "shipflow diagnose <releaseId>"));

  out(evidence, () => {
    console.log(`Release ${evidence.releaseId} (${evidence.project}): ${evidence.status} at ${evidence.stage}`);
    console.log(`  target: ${evidence.target}, strategy: ${evidence.buildStrategy ?? "n/a"}, tests: ${evidence.testStatus ?? "n/a"}`);

    if (evidence.artifact) {
      console.log(
        evidence.artifact.type === "image"
          ? `  artifact: image ${evidence.artifact.digest}`
          : `  artifact: static files (${evidence.artifact.path})`
      );
    }

    if (!evidence.failure || !evidence.diagnosis) {
      console.log("  No failure recorded.");
      return;
    }

    console.log("");
    console.log(`Failed during ${evidence.failure.stage}: ${evidence.failure.message}`);
    console.log(`Diagnosis (${evidence.diagnosis.category}): ${evidence.diagnosis.summary}`);

    for (const suggestion of evidence.diagnosis.suggestions) {
      console.log(`  - ${suggestion}`);
    }
  });

  return EXIT.OK;
}

async function rollback(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, {}, { positionals: 1 });
  const result = await rollbackRelease(requireArgument(positionals[0], "shipflow rollback <releaseId>"));
  const { previousReleaseId, targetReleaseId } = result.rollback;

  out(result.rollback, () =>
    console.log(`✅ Rolled back: ${previousReleaseId ?? "(none)"} → ${targetReleaseId}`)
  );
  return EXIT.OK;
}

async function cancel(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, {}, { positionals: 1 });
  const result = await cancelRelease(requireArgument(positionals[0], "shipflow cancel <releaseId>"));

  out(result, () =>
    console.log(
      result.status === "CANCELLED"
        ? `✅ Cancelled ${positionals[0]}`
        : `Cancellation requested; the worker stops ${positionals[0]} before activation.`
    )
  );
  return EXIT.OK;
}

/*
|--------------------------------------------------------------------------
| SECRETS / PROJECTS / TARGETS
|--------------------------------------------------------------------------
*/

async function secrets(argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  const { values, positionals } = parse(rest, { "from-file": { type: "string" } }, { positionals: 1 });

  if (action === "list") {
    const project = projectName(values);
    const result = await listSecrets(project);
    out(result, () => {
      if (result.secrets.length === 0) console.log(`No secrets for ${project}.`);
      for (const secret of result.secrets) console.log(`${secret.name}\t(updated ${secret.updated_at})`);
    });
    return EXIT.OK;
  }

  if (action === "set") {
    const name = requireArgument(positionals[0], "shipflow secrets set <NAME> [--project <p>] [--from-file <path>] (or pipe the value on stdin)");
    const project = projectName(values);
    const fromFile = text(values["from-file"]);
    const value = fromFile
      ? fs.readFileSync(fromFile, "utf8")
      : await readSecret(`Value for ${name} (input hidden): `);

    if (!value) throw new UsageError("Empty secret value");

    try {
      await setSecret(project, name, value);
    } catch (error) {
      // First use: register the project from shipflow.yml, then retry.
      const local = error instanceof ApiError && error.status === 404 ? localConfig(values) : null;
      if (local?.project.name !== project) throw error;
      await putProject(project, local);
      await setSecret(project, name, value);
    }
    out({ project, name }, () => console.log(`✅ Stored ${name} for ${project} (encrypted on the server)`));
    return EXIT.OK;
  }

  if (action === "rm") {
    const name = requireArgument(positionals[0], "shipflow secrets rm <NAME> [--project <p>]");
    const project = projectName(values);
    await deleteSecret(project, name);
    out({ project, name, removed: true }, () => console.log(`Removed ${name} from ${project}`));
    return EXIT.OK;
  }

  throw new UsageError("Usage: shipflow secrets set|list|rm [NAME] [--project <p>]");
}

async function projects(argv: string[]): Promise<number> {
  const { positionals } = parse(argv, {}, { positionals: 1 });

  if (positionals[0]) {
    const result = await getProject(positionals[0]);
    out(result, () => {
      const p = result.project;
      console.log(`Project:  ${p.name}`);
      console.log(`Repo:     ${p.repo_url}`);
      console.log(`Target:   ${p.target}${p.hostname ? ` (${p.hostname})` : ""}`);
      console.log(`Active:   ${result.activeReleaseId ?? "-"}`);
      console.log(`Secrets:  ${result.secrets.map((s) => s.name).join(", ") || "-"}`);
    });
    return EXIT.OK;
  }

  const result = await listProjects();
  out(result, () => {
    if (result.projects.length === 0) console.log("No projects yet. Create one with `shipflow init` and `shipflow deploy`.");
    for (const p of result.projects) console.log(`${p.name.padEnd(24)}${p.target.padEnd(10)}${p.repo_url}`);
  });
  return EXIT.OK;
}

async function targets(argv: string[]): Promise<number> {
  parse(argv);
  const info = await whoami();
  out({ targets: info.targets }, () => {
    for (const t of info.targets) {
      const c = t.capabilities;
      console.log(`${t.name.padEnd(10)} ${t.description}`);
      console.log(`${"".padEnd(10)} candidate check: ${c.candidateVerification}, atomic switch: ${c.atomicActivation ? "yes" : "no"}, rollback: ${c.rollback ? "yes" : "no"}`);
    }
  });
  return EXIT.OK;
}

/*
|--------------------------------------------------------------------------
| DOCTOR
|--------------------------------------------------------------------------
*/

async function cloud(argv: string[]): Promise<number> {
  // Loaded on demand: other commands never load the AWS SDK.
  const { runCloud } = await import("./lib/cloud/commands.js");
  return runCloud(argv);
}

async function doctor(argv: string[]): Promise<number> {
  const { values } = parse(argv);
  const checks: ApiCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const [major = 0] = process.versions.node.split(".").map(Number);
  add("node", major >= 22, `v${process.versions.node}${major >= 22 ? "" : " (ShipFlow needs Node 22+)"}`);

  let config = null;
  const file = values.config ?? DEFAULT_CONFIG_FILE;

  if (fs.existsSync(file) || values.config) {
    try {
      config = loadConfigFile(file).config;
      add(file, true, `project ${config.project.name}, target ${config.deployment.target}`);
    } catch (error) {
      add(file, false, errorMessage(error));
    }
  } else {
    add(file, true, "not present (only needed for project deploys)");
  }

  const connection = resolveConnection();
  add("server address", true, `${connection.url} (token from ${connection.source})`);

  if (isInsecureRemote(connection.url)) {
    add("transport", false, "plain HTTP to a remote server sends the token unencrypted; use https://");
  }

  let reachable = false;

  try {
    await health();
    reachable = true;
    add("server reachable", true, "/health ok");
  } catch (error) {
    add("server reachable", false, errorMessage(error));
  }

  if (reachable) {
    try {
      const info = await whoami();
      add("authentication", true, `instance ${info.instance}, artifacts ${info.artifactStore}`);

      const readiness = await ready().catch((error: unknown): ReadyResponse => (error instanceof ApiError ? error.body : { checks: [] }));
      for (const check of readiness.checks ?? []) add(`server: ${check.name}`, check.ok, check.detail);

      if (config) {
        const missing = requiredSecrets(config);
        try {
          const project = await getProject(config.project.name);
          const present = project.secrets.map((s) => s.name);
          const absent = missing.filter((name) => !present.includes(name));
          add("project registered", true, `${config.project.name} (active release ${project.activeReleaseId ?? "none"})`);
          if (missing.length) {
            add("deploy secrets", absent.length === 0, absent.length ? `missing: ${absent.join(", ")}` : missing.join(", "));
          }
          if (absent.length === 0) {
            const target = await checkProjectTarget(config.project.name).catch((error: unknown): ReadyResponse => (error instanceof ApiError ? error.body : { checks: [] }));
            for (const check of target.checks ?? []) add(`target: ${check.name}`, check.ok, check.detail);
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            add("project registered", true, "not yet; `shipflow deploy` registers it");
            if (missing.length) add("deploy secrets", false, `set before deploying: ${missing.join(", ")}`);
          } else throw error;
        }
      }
    } catch (error) {
      add("authentication", false, errorMessage(error));
    }
  }

  const ok = checks.every((check) => check.ok);

  out({ ok, checks }, () => {
    for (const check of checks) console.log(`${check.ok ? "✔" : "✖"} ${check.name}: ${check.detail}`);
    console.log(ok ? "\nAll checks passed." : "\nSome checks failed.");
  });

  return ok ? EXIT.OK : EXIT.FAILED;
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

const commands: Record<string, (argv: string[]) => Promise<number>> = {
  login,
  logout,
  init,
  deploy,
  status,
  releases,
  logs,
  diagnose,
  rollback,
  cancel,
  secrets,
  projects,
  targets,
  doctor,
  cloud,
};

const [command, ...rest] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(EXIT.OK);
}

if (command === "--version" || command === "-v" || command === "version") {
  console.log(VERSION);
  process.exit(EXIT.OK);
}

const handler = commands[command];

if (!handler) {
  console.error(`Unknown command: ${command}\n`);
  console.error(USAGE);
  process.exit(EXIT.USAGE);
}

if (rest.includes("--help") || rest.includes("-h")) {
  console.log(USAGE);
  process.exit(EXIT.OK);
}

try {
  process.exitCode = await handler(rest);
} catch (error) {
  if (error instanceof UsageError) {
    console.error(error.message);
    process.exitCode = EXIT.USAGE;
  } else if (error instanceof CloudError) {
    out({ error: error.message, hint: error.hint }, () => {
      console.error(`❌ ${error.message}`);
      if (error.hint) console.error(`   ${error.hint}`);
    });
    process.exitCode = error.exitCode;
  } else if (error instanceof ProjectConfigError) {
    out({ error: "invalid configuration", errors: error.errors }, () => console.error(`❌ ${error.message}`));
    process.exitCode = EXIT.USAGE;
  } else if (error instanceof ApiError) {
    out({ error: error.message, status: error.status, details: error.body?.errors }, () => {
      console.error(`❌ ${error.message}`);
      for (const e of error.body?.errors ?? []) console.error(`   - ${e.path}: ${e.message}`);
    });
    process.exitCode = error.status === 0 || error.status === 401 ? EXIT.UNAVAILABLE : EXIT.FAILED;
  } else {
    console.error(`❌ ${errorMessage(error)}`);
    process.exitCode = EXIT.FAILED;
  }
}

process.exit(process.exitCode);

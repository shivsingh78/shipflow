// The interactive AWS EC2 workflows: `cloud deploy`, `cloud status` and
// `cloud destroy`. All side effects (AWS, the ShipFlow API, the file system,
// prompts, clocks) arrive through `deps` and `io`, so tests drive the real
// logic with fakes and never touch AWS.
import path from "path";

import type { ApiCheck, ReadyResponse, ReleaseResponse, ReleaseRow, WhoamiResponse } from "../../deploy.js";
import type { ProjectResponse, ProjectRow } from "../../deploy.js";
import { CloudError, UsageError, errorMessage } from "../errors.js";
import type { Prompter } from "../prompt.js";
import { validateProjectConfig } from "../projectConfig.js";
import type { ProjectConfig } from "../projectConfig.js";
import {
  ACCESS_KEY_ID,
  isRootArn,
  redactSecrets,
  secretsOf,
  verifyIdentity,
} from "./aws.js";
import type { AwsAuth, AwsClients, AwsSdk, Identity } from "./aws.js";
import {
  DISK_GIB,
  InputError,
  parseBranch,
  parseCidr,
  parseDiskSize,
  parseInstanceType,
  parseName,
  parseOutput,
  parseRegion,
  parseRepoUrl,
  MAX_NAME_LENGTH,
} from "./inputs.js";
import { estimateCost } from "./pricing.js";
import type { CostEstimate } from "./pricing.js";
import {
  cleanupPartial,
  createResources,
  createdResources,
  destroyResources,
  inspectDeployment,
  preflight,
  waitFor,
  waitForBootstrap,
  waitForRunning,
  waitForStatusOk,
} from "./provision.js";
import type { ImageChoice, ProvisionPlan, ResourceStatus } from "./provision.js";
import { DEPLOYMENT_ID } from "./store.js";
import type { DeploymentRecord, Store } from "./store.js";
import { buildUserData, DEPLOY_USER, sitePath } from "./userData.js";
import { hostKeyFingerprint } from "./keys.js";

const SECRET_NAME = "SSH_PRIVATE_KEY";
const HOST_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/;
const PROFILE = /^[A-Za-z0-9_.@:/-]{1,128}$/;

/** Flags of `shipflow cloud <deploy|status|destroy>` (parsed by commands.ts). */
export interface CloudFlags {
  server?: string | undefined;
  profile?: string | undefined;
  "default-credentials"?: boolean | undefined;
  help?: boolean | undefined;
  json?: boolean | undefined;
  region?: string | undefined;
  name?: string | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
  output?: string | undefined;
  "instance-type"?: string | undefined;
  "disk-size"?: string | undefined;
  "ssh-cidr"?: string | undefined;
  "config-file"?: string | undefined;
  id?: string | undefined;
}

/** Terminal (or scripted) input and output for the workflows. */
export interface CloudIo {
  interactive: boolean;
  print(line?: string): unknown;
  warn(line: string): unknown;
  json(value: unknown): unknown;
  ask: Prompter["ask"];
  choose: Prompter["choose"];
  confirm: Prompter["confirm"];
  secret(promptText: string): Promise<string>;
  close?(): unknown;
}

export interface RepoCheck {
  status: "ok" | "no-branch" | "unreadable" | "skipped";
  reason?: string;
}

/** Everything with side effects; replaced wholesale in tests. */
export interface CloudDeps {
  api: {
    whoami(): Promise<WhoamiResponse>;
    listProjects(): Promise<{ projects?: ProjectRow[] }>;
    getProject(name: string): Promise<ProjectResponse>;
    putProject(name: string, config: ProjectConfig): Promise<unknown>;
    setSecret(project: string, name: string, value: string): Promise<unknown>;
    createRelease(options: { project: string; ref?: string }): Promise<ReleaseResponse>;
    checkProjectTarget(project: string): Promise<ReadyResponse>;
  };
  serverUrl(): string;
  loadSdk(): Promise<AwsSdk>;
  createAwsClients(args: { sdk: AwsSdk; region: string; auth: AwsAuth }): AwsClients;
  store: Store;
  checkRepo(args: { url: string; branch: string }): Promise<RepoCheck>;
  detectPublicIp(): Promise<string | null>;
  createKeyDir(): Promise<string>;
  generateDeployKey(args: { dir: string; comment: string }): Promise<{ privateKeyPath: string; publicKey: string }>;
  wipeDir(dir: string): Promise<boolean>;
  removeDirSync(dir: string): void;
  registerCleanup(fn: () => void): () => unknown;
  writeConfig(config: ProjectConfig, file: string): Promise<string>;
  fileExists(file: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  followRelease(
    release: { release_id: string },
    options: { timeoutMs: number; onState?: (state: string) => void }
  ): Promise<ReleaseRow | null>;
  randomHex(bytes: number): string;
  sleep(ms: number): Promise<unknown>;
  now(): number;
}

/** Proven AWS access: credentials, identity and clients. */
export interface Session {
  auth: AwsAuth;
  identity: Identity;
  aws: AwsClients;
  secrets: string[];
}

/** Everything decided before the user confirms creation. */
export interface DeploymentPlan extends ProvisionPlan {
  region: string;
  repository: string;
  branch: string;
  output: string;
  configFile: string;
  image: ImageChoice;
  availabilityZone: string | undefined;
}

const asProblem = (parser: (value: string) => unknown) => (value: string): string | null => {
  try {
    parser(value);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
};

/** The region recorded when the deployment was created. */
const recordedRegion = (meta: DeploymentRecord): string => meta.region as string;

/** A free project name: `base`, or `base-xxxx` when `base` is taken. */
export function uniqueProjectName(
  base: string,
  existing: ReadonlySet<string | undefined>,
  randomHex: (bytes: number) => string
): string {
  if (!existing.has(base)) return base;

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${base.slice(0, MAX_NAME_LENGTH)}-${randomHex(2)}`;
    if (!existing.has(candidate)) return candidate;
  }

  throw new CloudError("Could not find a free project name; choose a different one.");
}

// ------------------------------------------------------------------- review

const money = (value: number): string => `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00")}`;
const monthly = (value: number): string => `$${value.toFixed(2)}`;

/** The review screen as text lines (pure, so it can be tested). */
export function formatReview(
  plan: DeploymentPlan,
  estimate: CostEstimate,
  { identity }: { identity: Identity }
): string[] {
  const lines = [
    "",
    "── Review: nothing has been created yet ──────────────────────────",
    `Region:        ${plan.region}`,
    `AWS account:   ${identity.account}`,
    `Instance:      1 × ${plan.instanceType}, Amazon Linux 2023 x86_64 (${plan.image.imageId}, ${plan.image.name})`,
    `Root disk:     ${plan.diskGiB} GiB gp3, deleted when the instance is terminated`,
    `Network:       default VPC ${plan.vpcId}, subnet ${plan.subnetId} (${plan.availabilityZone})`,
    "Public IPv4:   yes, auto-assigned (billed per hour; no Elastic IP is created)",
    `SSH (22):      only from ${plan.sshCidr} (your ShipFlow worker)`,
    "HTTP (80):     open to the internet (the static site, no TLS)",
    "Will create:   1 EC2 instance, 1 security group, 1 key pair (public key only)",
    "Will NOT create: Elastic IP, NAT gateway, load balancer, database or any other resource",
    `Repository:    ${plan.repository} (branch ${plan.branch}, output ${plan.output})`,
    `Project:       ${plan.project}  →  config ${plan.configFile}`,
    `Deployment ID: ${plan.deploymentId}`,
    "",
    `Estimated cost, USD, on-demand (AWS price data checked ${estimate.verifiedAt}; NOT a billing guarantee):`,
  ];

  for (const line of estimate.lines) {
    lines.push(
      `  ${line.label.padEnd(36)} ${money(line.hourly)}/h  ≈ ${monthly(line.monthly)}/month  [${line.basis}]`
    );
  }

  if (estimate.hourly !== null) {
    lines.push(
      `  ${"Total".padEnd(36)} ${money(estimate.hourly)}/h  ≈ ${monthly(estimate.monthly)}/month` +
        (estimate.complete ? "" : "  (INCOMPLETE)")
    );
  }

  for (const note of estimate.notes) lines.push(`  note: ${note}`);

  lines.push(
    "",
    "Warnings:",
    "  • Charges accrue every hour until the instance is terminated: shipflow cloud destroy",
    "  • AWS credits and free-tier offers may not cover every charge (public IPv4, EBS, data transfer, taxes).",
    "  • Data transfer out and any other usage are not included in this estimate.",
    "  • Burstable (t*) instances are launched with standard CPU credits so sustained load throttles instead of billing extra.",
    ""
  );

  return lines;
}

// ----------------------------------------------------------- authentication

async function promptManualCredentials(io: CloudIo): Promise<AwsAuth> {
  io.print(
    "Manual credentials stay in this process's memory only: they are never written to disk, " +
      "environment variables, logs or ShipFlow.\n" +
      "Prefer short-lived credentials (AWS SSO, `aws sts get-session-token`) or a least-privilege IAM user. " +
      "Do not use root access keys."
  );

  const accessKeyId = (
    await io.ask("AWS Access Key ID", {
      validate: (v) => (ACCESS_KEY_ID.test(v) ? null : "That does not look like an access key ID (AKIA… or ASIA…)"),
    })
  ).trim();
  const secretAccessKey = (await io.secret("AWS Secret Access Key (input hidden): ")).trim();

  if (!/^[A-Za-z0-9/+=]{40}$/.test(secretAccessKey)) {
    throw new UsageError("That does not look like an AWS secret access key (40 characters).");
  }

  const temporary = accessKeyId.startsWith("ASIA");
  const sessionToken = (
    await io.secret(
      temporary
        ? "Session token (required for temporary ASIA… keys; input hidden): "
        : "Session token (leave empty if you have none; input hidden): "
    )
  ).trim();

  if (temporary && !sessionToken) {
    throw new UsageError("Temporary credentials (ASIA…) need their session token.");
  }

  if (!temporary) {
    io.warn("Note: AKIA… keys are long-lived. Delete or rotate this key after the test.");
  }

  return { mode: "manual", accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined };
}

/**
 * Choose how to authenticate, then prove it with STS GetCallerIdentity before
 * anything else happens. Returns { auth, identity, aws, secrets }.
 */
export async function authenticate({
  io,
  deps,
  region,
  flags = {},
}: {
  io: CloudIo;
  deps: CloudDeps;
  region: string;
  flags?: CloudFlags;
}): Promise<Session> {
  let auth: AwsAuth;

  if (flags.profile) {
    if (!PROFILE.test(flags.profile)) throw new UsageError("Invalid --profile name.");
    auth = { mode: "profile", profile: flags.profile };
  } else if (flags["default-credentials"]) {
    auth = { mode: "default" };
  } else {
    if (!io.interactive) {
      throw new UsageError("Pass --profile <name> or --default-credentials, or run this in a terminal.");
    }

    const choice = await io.choose(
      "How should ShipFlow authenticate to AWS?",
      [
        { value: "profile", description: "existing AWS profile or default credential chain (aws configure, AWS SSO, environment)" },
        { value: "manual", description: "type an access key now (kept in memory only, never saved)" },
      ],
      "profile"
    );

    if (choice === "manual") {
      auth = await promptManualCredentials(io);
    } else {
      const profile = (
        await io.ask("AWS profile name (empty = default credential chain)", {
          defaultValue: "",
          validate: (v) => (!v || PROFILE.test(v) ? null : "Invalid profile name"),
        })
      ).trim();
      auth = profile ? { mode: "profile", profile } : { mode: "default" };
    }
  }

  const sdk = await deps.loadSdk();
  const aws = deps.createAwsClients({ sdk, region, auth });
  const secrets = secretsOf(auth);
  let identity: Identity;

  try {
    identity = await verifyIdentity(aws.sts);
  } catch (error) {
    throw new CloudError(redactSecrets(errorMessage(error), secrets), {
      exitCode: 3,
      hint:
        auth.mode === "profile" || auth.mode === "default"
          ? "For AWS SSO run: aws sso login --profile <name>"
          : "Check the access key, secret and (for ASIA… keys) the session token.",
    });
  }

  io.print(`Authenticated to AWS account ${identity.account} as ${identity.arn}`);

  if (isRootArn(identity.arn)) {
    io.warn("These are ROOT account credentials. Create a least-privilege IAM user or use SSO instead.");

    if (!io.interactive || !(await io.confirm("Continue with root credentials anyway?", false))) {
      throw new CloudError("Stopped: refusing to continue with root credentials.", { exitCode: 2 });
    }
  }

  return { auth, identity, aws, secrets };
}

// ------------------------------------------------------------------- helpers

async function pick<T>(
  io: CloudIo,
  flags: CloudFlags,
  flag: "region" | "name" | "repo" | "branch" | "output" | "instance-type" | "disk-size",
  question: string,
  { defaultValue, parser }: { defaultValue?: string; parser: (value: string) => T }
): Promise<T> {
  const given = flags[flag];

  if (given !== undefined) {
    try {
      return parser(given);
    } catch (error) {
      if (error instanceof InputError) throw new UsageError(`--${flag}: ${error.message}`);
      throw error;
    }
  }

  const answer = await io.ask(question, { defaultValue, validate: asProblem(parser) });
  return parser(answer);
}

// -------------------------------------------------------------------- deploy

export async function runCloudDeploy({
  flags = {},
  deps,
  io,
}: {
  flags?: CloudFlags;
  deps: CloudDeps;
  io: CloudIo;
}): Promise<number> {
  io.print("ShipFlow → AWS EC2 deployment wizard (one temporary VPS for a static site)\n");
  io.print(
    "The ShipFlow API and worker must stay reachable and running while this wizard runs: " +
      "the worker builds your site and uploads it to the VPS over SSH.\n"
  );

  // 1. The ShipFlow server must be able to do this before AWS is touched.
  const server = await deps.api.whoami();

  if (!server.secretsEnabled) {
    throw new CloudError(
      "The ShipFlow server has no SHIPFLOW_SECRETS_KEY, so it cannot store the VPS deploy key.",
      { hint: "Set SHIPFLOW_SECRETS_KEY in the server's .env and restart it." }
    );
  }

  if (!server.targets?.some((target) => target.name === "ssh")) {
    throw new CloudError("The ShipFlow server does not support the ssh deployment target.");
  }

  io.print(`ShipFlow server: ${deps.serverUrl()} (instance ${server.instance})`);

  // 2. Region, then credentials (proved with STS before anything else).
  const region = await pick(io, flags, "region", "AWS region", { defaultValue: "ap-south-1", parser: parseRegion });
  const session = await authenticate({ io, deps, region, flags });
  const { aws, identity, secrets } = session;

  // 3. What to deploy.
  const nameBase = await pick(io, flags, "name", "Project / deployment name", {
    defaultValue: "my-site",
    parser: parseName,
  });
  const repository = await pick(io, flags, "repo", "Git repository (https URL, public)", {
    parser: (v) => parseRepoUrl(v, { allowedPrefixes: server.allowedRepoPrefixes }),
  });
  const branch = await pick(io, flags, "branch", "Branch", { defaultValue: "main", parser: parseBranch });
  const output = await pick(io, flags, "output", 'Build output directory ("auto" detects dist, build or out)', {
    defaultValue: "auto",
    parser: parseOutput,
  });
  const instanceType = await pick(io, flags, "instance-type", "EC2 instance type", {
    defaultValue: "t3.micro",
    parser: parseInstanceType,
  });
  const diskGiB = await pick(io, flags, "disk-size", `Root disk size in GiB (gp3, ${DISK_GIB.min}-${DISK_GIB.max})`, {
    defaultValue: String(DISK_GIB.default),
    parser: parseDiskSize,
  });

  // 4. The repository must be readable without credentials.
  const repoCheck = await deps.checkRepo({ url: repository, branch });

  if (repoCheck.status === "unreadable") {
    throw new CloudError(
      `Cannot read ${repository} without credentials. It may be private, misspelled, or unreachable from here.`,
      {
        exitCode: 2,
        hint:
          "ShipFlow's worker clones repositories anonymously, and a token must never be placed in the URL, " +
          "so private repositories are not supported yet.",
      }
    );
  }

  if (repoCheck.status === "no-branch") {
    throw new UsageError(`Branch "${branch}" does not exist in ${repository}.`);
  }

  if (repoCheck.status === "skipped") {
    io.warn(`Could not check the repository from this machine (${repoCheck.reason}); continuing.`);
  }

  // 5. Everything AWS can tell us before creating anything.
  io.print("\nChecking the region, instance type, network and AMI...");
  const ready = await preflight(aws.ec2, { region, instanceType, diskGiB });
  ready.notes.forEach((note) => io.warn(note));

  // 6. Who may SSH in: the worker's address, never assumed.
  const sshCidr = await chooseSshCidr({ io, deps, flags });

  // 7. Names that cannot collide with anything that exists.
  const existing = new Set([
    ...((await deps.api.listProjects()).projects ?? []).map((p) => p.name),
    ...deps.store.list().map((d) => d.project),
  ]);
  const project = uniqueProjectName(nameBase, existing, deps.randomHex);

  if (project !== nameBase) io.print(`Project name "${nameBase}" is taken; using "${project}".`);

  let configFile = flags["config-file"] ?? "shipflow.yml";

  if (await deps.fileExists(configFile)) {
    const alternative = `shipflow.${project}.yml`;

    if (flags["config-file"] || (await deps.fileExists(alternative))) {
      throw new UsageError(`${configFile} already exists and will not be overwritten. Choose --config-file <new name>.`);
    }

    io.print(`${configFile} already exists and will not be modified; writing ${alternative} instead.`);
    configFile = alternative;
  }

  let deploymentId: string;

  do {
    deploymentId = `sf-${deps.randomHex(4)}`;
  } while (deps.store.load(deploymentId));

  const plan: DeploymentPlan = {
    deploymentId,
    project,
    region,
    instanceType,
    diskGiB,
    sshCidr,
    repository,
    branch,
    output,
    configFile,
    image: ready.image,
    vpcId: ready.vpcId,
    subnetId: ready.subnetId,
    availabilityZone: ready.availabilityZone,
  };

  // 8. Review and the explicit confirmation. There is deliberately no way to
  //    skip this (no --yes).
  const estimate = estimateCost({ region, instanceType, diskGiB, publicIp: true });
  formatReview(plan, estimate, { identity }).forEach((line) => io.print(line));

  const typed = (await io.ask("Type CREATE to create these billable AWS resources (anything else cancels)")).trim();

  if (typed !== "CREATE") {
    throw new CloudError("Cancelled. Nothing was created.");
  }

  return provisionAndDeploy({ io, deps, session, plan, secrets });
}

async function chooseSshCidr({
  io,
  deps,
  flags,
}: {
  io: CloudIo;
  deps: CloudDeps;
  flags: CloudFlags;
}): Promise<string> {
  const parse = (value: string) => {
    try {
      return parseCidr(value);
    } catch (error) {
      if (error instanceof InputError) throw new UsageError(error.message);
      throw error;
    }
  };

  let parsed: { cidr: string; adjusted: boolean } | undefined;

  if (flags["ssh-cidr"] !== undefined) {
    parsed = parse(flags["ssh-cidr"]);
  } else {
    const detected = await deps.detectPublicIp();

    if (detected) {
      io.print(
        `\nThis machine's public IP looks like ${detected} (via checkip.amazonaws.com). That is only correct if ` +
          "your ShipFlow worker's outbound traffic leaves through the same address, e.g. ShipFlow running " +
          "on this machine or network."
      );

      if (await io.confirm(`Allow SSH from ${detected}/32 only?`, false)) {
        parsed = parse(detected);
      }
    }

    if (!parsed) {
      const answer = await io.ask("Public egress IP or CIDR of the ShipFlow worker (SSH will be limited to it)", {
        validate: asProblem(parseCidr),
      });
      parsed = parse(answer);
    }
  }

  if (parsed.adjusted) {
    io.print(`Using ${parsed.cidr} (the network address of the range you entered).`);
  }

  return parsed.cidr;
}

async function provisionAndDeploy({
  io,
  deps,
  session,
  plan,
  secrets,
}: {
  io: CloudIo;
  deps: CloudDeps;
  session: Session;
  plan: DeploymentPlan;
  secrets: string[];
}): Promise<number> {
  const { aws } = session;
  const { deploymentId, project } = plan;
  const keyDir = await deps.createKeyDir();
  const unregister = deps.registerCleanup(() => deps.removeDirSync(keyDir));
  const clock = { sleep: deps.sleep, now: deps.now };
  const safe = (text: unknown): string => redactSecrets(text, secrets);

  let resources: DeploymentRecord = { id: deploymentId, region: plan.region };

  const remember = (fields: Partial<DeploymentRecord>): void => {
    resources = { ...resources, ...fields };
    deps.store.save(deploymentId, fields);
  };

  try {
    // The key pair is generated locally; only its PUBLIC half goes to AWS.
    const key = await deps.generateDeployKey({ dir: keyDir, comment: `shipflow-${deploymentId}` });
    const userData = buildUserData({ project, deploymentId, publicKey: key.publicKey });

    remember({
      state: "provisioning",
      createdAt: new Date(deps.now()).toISOString(),
      region: plan.region,
      project,
      repository: plan.repository,
      branch: plan.branch,
      configFile: plan.configFile,
      instanceType: plan.instanceType,
      diskGiB: plan.diskGiB,
      sshCidr: plan.sshCidr,
    });

    io.print("\nCreating the key pair, security group and instance...");

    let created: Awaited<ReturnType<typeof createResources>>;

    try {
      created = await createResources(aws.ec2, plan, {
        publicKey: key.publicKey,
        userData,
        onResource: ({ type, id }) => {
          const fields: Record<string, Partial<DeploymentRecord> | undefined> = {
            keyPair: { keyPairName: id },
            securityGroup: { securityGroupId: id },
            instance: { instanceId: id },
          };
          const known = fields[type];
          if (known) remember(known);
        },
      });
    } catch (error) {
      io.warn(`Provisioning failed: ${safe(errorMessage(error))}`);
      io.print("Cleaning up only what this attempt created...");

      const cleanup = await cleanupPartial(aws.ec2, deploymentId, createdResources(error), { ...clock, log: io.print });

      cleanup.removed.forEach((what) => io.print(`  removed ${what}`));

      if (cleanup.failed.length > 0) {
        remember({ state: "failed-partial" });
        cleanup.failed.forEach((f) => io.warn(`  could NOT remove ${f.what}: ${safe(f.error)}`));
        io.warn(
          `Some resources remain and may be billed. Retry: shipflow cloud destroy --id ${deploymentId} ` +
            `(details in ${deps.store.dir}).`
        );
      } else {
        remember({ state: "failed-cleaned" });
        io.print("Everything this attempt created has been removed.");
      }

      throw new CloudError(safe(errorMessage(error)));
    }

    remember({ state: "provisioned" });
    io.print(`Created instance ${created.instanceId}. Waiting for it to start...`);

    const failAfterProvisioning = async (caught: unknown): Promise<never> => {
      const error = caught as Partial<CloudError>; // CloudError, AwsError or any other failure
      return handleFailureAfterProvisioning({
        io,
        deps,
        session,
        deploymentId,
        keyDir,
        error: Object.assign(new CloudError(safe(error.message), { exitCode: error.exitCode ?? 1, hint: error.hint }), {}),
      });
    };

    try {
      const instance = await waitForRunning(aws.ec2, created.instanceId, clock);
      const publicIp = instance.PublicIpAddress;
      remember({ publicIp, url: `http://${publicIp}/`, state: "running" });

      io.print(`Running at ${publicIp}. Waiting for the EC2 health checks...`);
      await waitForStatusOk(aws.ec2, created.instanceId, clock);

      io.print("Waiting for the bootstrap (nginx, deploy user) and the SSH host key...");
      const hostKey = await obtainHostKey({ io, aws, created, deploymentId, publicIp, clock });

      io.print(
        `\nSSH host key of ${publicIp} (ed25519): ${hostKeyFingerprint(hostKey.value)}\n` +
          `Source: ${hostKey.source}\n` +
          "ShipFlow will pin this key: later connections are refused if it ever changes. Trust on first use means " +
          "that if this key is wrong, an attacker who can intercept the worker's connection could impersonate the VPS."
      );

      if (!(await io.confirm("Pin this host key for deployments?", false))) {
        throw new CloudError("The host key was not trusted.");
      }

      const raw = {
        version: 1,
        project: { name: project, repository: plan.repository, branch: plan.branch },
        build: { output: plan.output },
        deployment: {
          target: "ssh",
          ssh: {
            host: publicIp,
            port: 22,
            user: DEPLOY_USER,
            path: sitePath(project),
            hostKey: hostKey.value,
            privateKeySecret: SECRET_NAME,
            url: `http://${publicIp}/`,
          },
        },
      };
      const config = validateProjectConfig(raw);

      const configPath = await deps.writeConfig(config, plan.configFile);
      remember({ configFile: path.basename(configPath) });
      io.print(`Wrote ${plan.configFile} (no secrets in it).`);

      await deps.api.putProject(project, config);
      await deps.api.setSecret(project, SECRET_NAME, await deps.readFile(key.privateKeyPath));
      io.print(`Registered project ${project} and stored the deploy key in ShipFlow's encrypted secret store.`);

      // The private key now only exists on the ShipFlow server.
      await deps.wipeDir(keyDir);

      io.print("Checking that the ShipFlow worker can SSH to the VPS...");
      await checkWorkerAccess({ io, deps, project, plan, clock });

      io.print("\nStarting the ShipFlow release (build, test, upload, verify, activate)...");
      const { release } = await deps.api.createRelease({ project, ref: plan.branch });
      io.print(`Release ${release.release_id}`);

      const final = await deps.followRelease(release, {
        timeoutMs: 30 * 60_000,
        onState: (state) => io.print(`→ ${state}`),
      });

      if (!final) {
        throw new CloudError(`Timed out waiting for release ${release.release_id}; check: shipflow status ${release.release_id}`, { exitCode: 4 });
      }

      if (final.status !== "SUCCESS") {
        throw new CloudError(
          `Release ${final.release_id} ${final.status} at ${final.current_stage}: ${final.error_message ?? "see shipflow logs"} ` +
            `(shipflow logs ${final.release_id})`
        );
      }

      remember({ state: "deployed", releaseId: final.release_id });

      io.print("\n✅ Deployed.");
      io.print(`Release:      ${final.release_id} (${final.status}, tests ${final.test_status ?? "n/a"})`);
      io.print(`Instance:     ${created.instanceId} in ${plan.region}`);
      io.print(`Public IP:    ${publicIp}`);
      io.print(`Site URL:     http://${publicIp}/  (plain HTTP)`);
      io.print(`Project:      ${project}   Deployment: ${deploymentId}`);
      io.print(
        "\nThis VPS is billed by the hour until you terminate it. When you are done:\n" +
          `  shipflow cloud destroy --id ${deploymentId}\n` +
          "AWS credits do not cap spending; check the AWS Billing console. The public IP changes if you " +
          "stop and start the instance."
      );

      return 0;
    } catch (error) {
      return await failAfterProvisioning(error);
    }
  } finally {
    unregister();
    await deps.wipeDir(keyDir);
  }
}

async function obtainHostKey({
  io,
  aws,
  created,
  deploymentId,
  publicIp,
  clock,
}: {
  io: CloudIo;
  aws: AwsClients;
  created: { instanceId: string };
  deploymentId: string;
  publicIp: string | undefined;
  clock: { sleep: CloudDeps["sleep"]; now: CloudDeps["now"] };
}): Promise<{ value: string; source: string }> {
  try {
    const boot = await waitForBootstrap(aws.ec2, created.instanceId, deploymentId, clock);
    return { value: boot.hostKey, source: "the instance's console output, read through the authenticated AWS API" };
  } catch (error) {
    if (!(error instanceof CloudError) || !/Timed out/.test(error.message)) throw error;

    io.warn(
      "The instance console did not report the bootstrap in time (the console can lag). You can read the host key " +
        `yourself, for example: ssh-keyscan -t ed25519 ${publicIp}  (only from an address the security group allows).`
    );

    const pasted = (
      await io.ask('Paste the ed25519 host key ("ssh-ed25519 AAAA…") or press Enter to stop', {
        defaultValue: "",
        validate: (v) => (!v || HOST_KEY.test(v.trim()) ? null : "That is not an ssh-ed25519 public key"),
      })
    ).trim();

    if (!pasted) throw error;

    return { value: pasted, source: "pasted by you (trust on first use)" };
  }
}

async function checkWorkerAccess({
  io,
  deps,
  project,
  plan,
  clock,
}: {
  io: CloudIo;
  deps: CloudDeps;
  project: string;
  plan: DeploymentPlan;
  clock: { sleep: CloudDeps["sleep"]; now: CloudDeps["now"] };
}): Promise<void> {
  let lastChecks: ApiCheck[] = [];

  try {
    await waitFor(
      async () => {
        const result = await deps.api
          .checkProjectTarget(project)
          .catch((error: unknown): ReadyResponse => ({
            checks: [{ name: "target check", ok: false, detail: errorMessage(error) }],
          }));

        lastChecks = result.checks ?? [];
        return { done: lastChecks.length > 0 && lastChecks.every((c) => c.ok) };
      },
      { timeoutMs: 3 * 60_000, intervalMs: 10_000, describe: "the worker to reach the VPS over SSH", ...clock }
    );
  } catch (error) {
    const failing = lastChecks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

    throw new CloudError(
      `The ShipFlow worker cannot use the VPS yet (${failing.join("; ") || errorMessage(error)}).`,
      {
        hint:
          `Most often the worker's outbound IP is not ${plan.sshCidr}, which is the only address the security ` +
          "group lets SSH in from.",
      }
    );
  }

  io.print("The worker can reach the VPS.");
}

async function handleFailureAfterProvisioning({
  io,
  deps,
  session,
  deploymentId,
  keyDir,
  error,
}: {
  io: CloudIo;
  deps: CloudDeps;
  session: Session;
  deploymentId: string;
  keyDir: string;
  error: CloudError;
}): Promise<never> {
  const meta = deps.store.load(deploymentId) as DeploymentRecord; // saved before provisioning started

  // The private key is useless without a registered project; never keep it.
  await deps.wipeDir(keyDir);

  io.warn(`\n❌ ${error.message}`);
  if (error.hint) io.warn(error.hint);
  io.print(
    `The EC2 instance ${meta?.instanceId ?? ""} still exists and is billed until it is terminated. ` +
      "The temporary deploy key has been removed from this machine."
  );

  const choice = await io.choose(
    "What now?",
    [
      { value: "keep", description: "keep the VPS (debug it, then run shipflow cloud destroy)" },
      { value: "destroy", description: "run the controlled cleanup now (asks you to type DESTROY)" },
    ],
    "keep"
  );

  if (choice === "destroy") {
    try {
      await destroyDeployment({ io, deps, session, meta });
    } catch (cleanupError) {
      io.warn(`Cleanup did not finish: ${redactSecrets(errorMessage(cleanupError), session.secrets)}`);
    }
  } else {
    io.print(`Kept. Status: shipflow cloud status --id ${deploymentId}   Remove: shipflow cloud destroy --id ${deploymentId}`);
  }

  throw error;
}

// ------------------------------------------------------------ select helpers

function selectDeployment({
  deps,
  flags,
  includeDestroyed,
}: {
  deps: CloudDeps;
  flags: CloudFlags;
  includeDestroyed: boolean;
}): DeploymentRecord | DeploymentRecord[] | null {
  if (flags.id !== undefined) {
    if (!DEPLOYMENT_ID.test(flags.id)) throw new UsageError("--id must look like sf-1a2b3c4d");

    const meta = deps.store.load(flags.id);

    if (!meta) {
      throw new UsageError(`No deployment ${flags.id} is recorded in ${deps.store.dir}.`);
    }

    return meta;
  }

  const all = deps.store.list().filter((d) => includeDestroyed || d.state !== "destroyed");

  if (all.length === 0) return null;
  if (all.length === 1) return all[0] ?? null;

  return all;
}

async function resolveDeployment({
  io,
  deps,
  flags,
  includeDestroyed,
}: {
  io: CloudIo;
  deps: CloudDeps;
  flags: CloudFlags;
  includeDestroyed: boolean;
}): Promise<DeploymentRecord | null | undefined> {
  const selected = selectDeployment({ deps, flags, includeDestroyed });

  if (!Array.isArray(selected)) return selected;

  if (!io.interactive) {
    throw new UsageError(`Several deployments exist; pass --id. Known: ${selected.map((d) => d.id).join(", ")}`);
  }

  const id = await io.choose(
    "Which deployment?",
    selected.map((d) => ({
      value: d.id,
      description: `${d.project}  ${d.region}  ${d.publicIp ?? "no IP"}  ${d.state}`,
    })),
    selected[0]?.id
  );

  return selected.find((d) => d.id === id);
}

// -------------------------------------------------------------------- status

export async function runCloudStatus({
  flags = {},
  deps,
  io,
}: {
  flags?: CloudFlags;
  deps: CloudDeps;
  io: CloudIo;
}): Promise<number> {
  const meta = await resolveDeployment({ io, deps, flags, includeDestroyed: true });

  if (!meta) {
    io.print(`No ShipFlow cloud deployments are recorded in ${deps.store.dir}.`);
    return 0;
  }

  const session = await authenticate({ io, deps, region: recordedRegion(meta), flags });
  const report = await inspectDeployment(session.aws.ec2, meta);

  let release: { activeReleaseId: string | null | undefined } | null = null;

  if (meta.project && deps.api) {
    release = await deps.api
      .getProject(meta.project)
      .then((r) => ({ activeReleaseId: r.activeReleaseId }))
      .catch(() => null);
  }

  const instance: ResourceStatus = report.instance ?? { exists: false };
  const view = {
    id: meta.id,
    project: meta.project,
    region: meta.region,
    recordedState: meta.state,
    instanceId: meta.instanceId ?? null,
    instanceState: instance.exists ? instance.state : "not found",
    publicIp: instance.exists ? instance.publicIp : null,
    url: instance.exists && instance.publicIp ? `http://${instance.publicIp}/` : null,
    instanceType: instance.instanceType ?? meta.instanceType,
    managedByShipFlow: instance.exists ? instance.owned : null,
    securityGroupId: meta.securityGroupId ?? null,
    keyPairName: meta.keyPairName ?? null,
    sshAllowedFrom: meta.sshCidr ?? null,
    releaseId: meta.releaseId ?? null,
    activeReleaseId: release?.activeReleaseId ?? null,
    createdAt: meta.createdAt,
  };

  if (flags.json) {
    io.json(view);
    return 0;
  }

  io.print(`Deployment:   ${view.id}  (recorded as ${view.recordedState})`);
  io.print(`Project:      ${view.project}`);
  io.print(`Region:       ${view.region}`);
  io.print(`Instance:     ${view.instanceId ?? "-"}  ${view.instanceState}${view.instanceType ? `  (${view.instanceType})` : ""}`);
  io.print(`Public IP:    ${view.publicIp ?? "-"}`);
  io.print(`URL:          ${view.url ?? "-"}`);
  io.print(`SSH allowed:  ${view.sshAllowedFrom ?? "-"}`);
  io.print(`Release:      ${view.releaseId ?? "-"}${view.activeReleaseId ? `  (live in ShipFlow: ${view.activeReleaseId})` : ""}`);
  io.print(`Created:      ${view.createdAt}`);

  if (instance.exists && !instance.owned) {
    io.warn("Warning: this instance is not tagged as belonging to this ShipFlow deployment.");
  }

  if (instance.exists && instance.state !== "terminated") {
    io.print(`\nBilling continues while the instance exists. Remove it: shipflow cloud destroy --id ${view.id}`);
  }

  return 0;
}

// ------------------------------------------------------------------- destroy

export async function runCloudDestroy({
  flags = {},
  deps,
  io,
}: {
  flags?: CloudFlags;
  deps: CloudDeps;
  io: CloudIo;
}): Promise<number> {
  if (!io.interactive) {
    throw new UsageError("cloud destroy asks for confirmation and must run in a terminal.");
  }

  const meta = await resolveDeployment({ io, deps, flags, includeDestroyed: false });

  if (!meta) {
    io.print(`No active ShipFlow cloud deployments are recorded in ${deps.store.dir}.`);
    return 0;
  }

  if (meta.state === "destroyed") {
    io.print(`Deployment ${meta.id} was already destroyed${meta.destroyedAt ? ` (${meta.destroyedAt})` : ""}.`);
    return 0;
  }

  const session = await authenticate({ io, deps, region: recordedRegion(meta), flags });

  return destroyDeployment({ io, deps, session, meta });
}

/**
 * Terminate one deployment's instance and remove its security group and key
 * pair, after verifying ownership and typing DESTROY.
 */
export async function destroyDeployment({
  io,
  deps,
  session,
  meta,
}: {
  io: CloudIo;
  deps: CloudDeps;
  session: Session;
  meta: DeploymentRecord;
}): Promise<number> {
  const { aws, secrets } = session;
  const report = await inspectDeployment(aws.ec2, meta);

  if (report.instance?.exists && !report.instance.owned) {
    throw new CloudError(
      `Instance ${meta.instanceId} is not tagged as ShipFlow deployment ${meta.id}; refusing to touch it.`,
      { exitCode: 2 }
    );
  }

  const describe = (label: string, entry: ResourceStatus | null | undefined, id: string | undefined): string | null =>
    id ? `  ${label} ${id}: ${!entry?.exists ? "already gone" : entry.owned === false ? "NOT owned by this deployment, will be left alone" : "will be removed"}` : null;

  io.print(`\nDeployment ${meta.id} (project ${meta.project}) in ${meta.region}:`);
  [
    describe("EC2 instance", report.instance && { ...report.instance, exists: report.instance.exists && report.instance.state !== "terminated" }, meta.instanceId),
    describe("security group", report.securityGroup, meta.securityGroupId),
    describe("key pair", report.keyPair, meta.keyPairName),
  ]
    .filter((line): line is string => line !== null)
    .forEach((line) => io.print(line));
  io.print(
    "Only these resources are touched. ShipFlow's project, releases, logs and your repository are kept.\n"
  );

  const typed = (await io.ask("Type DESTROY to terminate this deployment (anything else cancels)")).trim();

  if (typed !== "DESTROY") {
    throw new CloudError("Cancelled. Nothing was destroyed.");
  }

  const clock = { sleep: deps.sleep, now: deps.now };
  const result = await destroyResources(
    aws.ec2,
    {
      deploymentId: meta.id,
      instanceId: meta.instanceId,
      securityGroupId: meta.securityGroupId,
      keyPairName: meta.keyPairName,
    },
    { ...clock, log: io.print }
  );

  result.removed.forEach((what) => io.print(`  removed ${what}`));
  result.skipped.forEach((what) => io.print(`  skipped ${what}`));

  if (result.failed.length > 0) {
    deps.store.save(meta.id, { state: "failed-partial" });
    result.failed.forEach((f) => io.warn(`  FAILED ${f.what}: ${redactSecrets(f.error, secrets)}`));
    throw new CloudError(
      `Some resources could not be removed; they may still be billed. Run \`shipflow cloud destroy --id ${meta.id}\` again.`
    );
  }

  deps.store.save(meta.id, { state: "destroyed", destroyedAt: new Date(deps.now()).toISOString() });

  io.print(`\n✅ Destroyed ${meta.id}. AWS stops billing for these resources once they are gone.`);
  io.print(
    `The ShipFlow project "${meta.project}" still points at the deleted server. To remove its stored deploy key: ` +
      `shipflow secrets rm ${SECRET_NAME} --project ${meta.project}`
  );

  return 0;
}

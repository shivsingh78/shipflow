// Test harness for the AWS wizard: a small stateful fake of EC2/STS, scripted
// prompts, a fake clock and fake ShipFlow API. Nothing here can reach AWS.
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";

import { renderConfig } from "../../../cli/dist/lib/configFile.js";
import { AwsError, toAwsError } from "../../../cli/dist/lib/cloud/aws.js";
import { createStore } from "../../../cli/dist/lib/cloud/store.js";
import { createKeyDir, wipeDir } from "../../../cli/dist/lib/cloud/keys.js";

export const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl shipflow-test";
/** A structurally valid ssh-ed25519 public key built from a seed byte. */
export function fakeEd25519(seed) {
  const field = (buf) => Buffer.concat([Buffer.from([0, 0, 0, buf.length]), buf]);
  const blob = Buffer.concat([field(Buffer.from("ssh-ed25519")), field(Buffer.alloc(32, seed))]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

export const HOST_KEY = fakeEd25519(7);
export const PRIVATE_KEY_TEXT =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEPRIVATEKEYMATERIALFORTESTSONLY\n-----END OPENSSH PRIVATE KEY-----\n";
export const PUBLIC_IP = "203.0.113.50";

/** Credentials that must never appear anywhere. */
export const FAKE_CREDENTIALS = {
  accessKeyId: "AKIAFAKEFAKEFAKE1234",
  secretAccessKey: `FakeSecret/${"x".repeat(40)}`.slice(0, 40),
  sessionToken: `FQoGZXIvYXdzFAKETOKEN${"y".repeat(120)}`,
};

export function awsError(code, message = code) {
  return Object.assign(new Error(message), { name: code, code });
}

/** What the real createApi() seam does to every SDK failure. */
const asSeamError = (error, name) => (error instanceof AwsError ? error : toAwsError(error, [], name));

// ------------------------------------------------------------------- clock

export function createClock() {
  let t = 1_700_000_000_000;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

// ----------------------------------------------------------------- fake STS

export function createFakeSts({
  account = "123456789012",
  arn = "arn:aws:iam::123456789012:user/shipflow-test",
  error = null,
  log = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async call(name) {
      calls.push(name);
      log?.push(`sts:${name}`);
      if (error) throw asSeamError(error, name);
      return { Account: account, Arn: arn, UserId: "AIDAFAKE" };
    },
  };
}

// ----------------------------------------------------------------- fake EC2

const imageList = () => [
  {
    ImageId: "ami-old",
    Name: "al2023-ami-2023.5.20240101.0-kernel-6.1-x86_64",
    CreationDate: "2024-01-01T00:00:00.000Z",
    ImageOwnerAlias: "amazon",
    RootDeviceName: "/dev/xvda",
    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 8 } }],
  },
  {
    ImageId: "ami-new",
    Name: "al2023-ami-2023.6.20250101.0-kernel-6.1-x86_64",
    CreationDate: "2025-01-01T00:00:00.000Z",
    ImageOwnerAlias: "amazon",
    RootDeviceName: "/dev/xvda",
    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 8 } }],
  },
  {
    ImageId: "ami-minimal",
    Name: "al2023-ami-minimal-2023.7.20260101.0-kernel-6.1-x86_64",
    CreationDate: "2026-01-01T00:00:00.000Z",
    ImageOwnerAlias: "amazon",
    RootDeviceName: "/dev/xvda",
    BlockDeviceMappings: [],
  },
  {
    ImageId: "ami-lookalike",
    Name: "al2023-ami-2023.9.20270101.0-kernel-6.1-x86_64",
    CreationDate: "2027-01-01T00:00:00.000Z",
    ImageOwnerAlias: undefined, // not Amazon's
    RootDeviceName: "/dev/xvda",
    BlockDeviceMappings: [],
  },
];

const instanceTypes = {
  "t3.micro": { vcpus: 2, memory: 1024, arch: ["x86_64"] },
  "t3.small": { vcpus: 2, memory: 2048, arch: ["x86_64"] },
  "t4g.micro": { vcpus: 2, memory: 1024, arch: ["arm64"] },
  "m5.16xlarge": { vcpus: 64, memory: 262144, arch: ["x86_64"] },
};

/**
 * Stateful fake EC2. `overrides[Operation](input, world, original)` replaces
 * or wraps a handler (to inject failures).
 */
export function createFakeEc2({
  overrides = {},
  runningAfter = 1,
  statusOkAfter = 1,
  consoleReadyAfter = 1,
  terminateAfter = 1,
  dependencyViolations = 0,
  consoleText = null,
  vpcs = [{ VpcId: "vpc-default" }],
  log = null,
} = {}) {
  const world = {
    seq: 0,
    instances: new Map(),
    groups: new Map(),
    keyPairs: new Map(),
    depViolationsLeft: dependencyViolations,
  };
  const calls = [];
  const next = (prefix) => `${prefix}-${String(++world.seq).padStart(4, "0")}`;
  const tagsFor = (specs, type) => (specs ?? []).find((s) => s.ResourceType === type)?.Tags ?? [];
  const tagValue = (tags, key) => tags.find((t) => t.Key === key)?.Value;
  const notFound = (code) => awsError(code, `${code}: does not exist`);

  const advance = (instance) => {
    instance.polls += 1;
    if (instance.State.Name === "pending" && instance.polls >= runningAfter) {
      instance.State = { Name: "running" };
      instance.PublicIpAddress = PUBLIC_IP;
    } else if (instance.State.Name === "shutting-down" && instance.polls >= terminateAfter) {
      instance.State = { Name: "terminated" };
    }
  };

  const handlers = {
    DescribeRegions: ({ RegionNames }) => ({ Regions: RegionNames.map((RegionName) => ({ RegionName })) }),

    DescribeInstanceTypes: ({ InstanceTypes }) => {
      const info = instanceTypes[InstanceTypes[0]];
      if (!info) throw awsError("InvalidInstanceType", "The instance type does not exist");
      return {
        InstanceTypes: [
          {
            InstanceType: InstanceTypes[0],
            ProcessorInfo: { SupportedArchitectures: info.arch },
            VCpuInfo: { DefaultVCpus: info.vcpus },
            MemoryInfo: { SizeInMiB: info.memory },
            SupportedUsageClasses: ["on-demand", "spot"],
            BareMetal: false,
          },
        ],
      };
    },

    DescribeInstanceTypeOfferings: () => ({
      InstanceTypeOfferings: [{ Location: "ap-south-1a" }, { Location: "ap-south-1b" }],
    }),

    DescribeVpcs: () => ({ Vpcs: vpcs }),

    DescribeSubnets: () => ({
      Subnets: [
        { SubnetId: "subnet-c", AvailabilityZone: "ap-south-1c" }, // not offered the type
        { SubnetId: "subnet-b", AvailabilityZone: "ap-south-1b" },
        { SubnetId: "subnet-a", AvailabilityZone: "ap-south-1a" },
      ],
    }),

    DescribeImages: () => ({ Images: imageList() }),

    ImportKeyPair: (input) => {
      world.keyPairs.set(input.KeyName, { KeyName: input.KeyName, Tags: tagsFor(input.TagSpecifications, "key-pair") });
      return { KeyName: input.KeyName, KeyPairId: next("key") };
    },

    CreateSecurityGroup: (input) => {
      const id = next("sg");
      world.groups.set(id, {
        GroupId: id,
        GroupName: input.GroupName,
        Tags: tagsFor(input.TagSpecifications, "security-group"),
        rules: [],
      });
      return { GroupId: id };
    },

    AuthorizeSecurityGroupIngress: ({ GroupId, IpPermissions }) => {
      world.groups.get(GroupId).rules.push(...IpPermissions);
      return { Return: true };
    },

    RunInstances: (input) => {
      const id = next("i");
      world.instances.set(id, {
        InstanceId: id,
        InstanceType: input.InstanceType,
        State: { Name: "pending" },
        Tags: tagsFor(input.TagSpecifications, "instance"),
        polls: 0,
        statusPolls: 0,
        consolePolls: 0,
        input,
      });
      return { Instances: [{ InstanceId: id }] };
    },

    DescribeInstances: ({ InstanceIds }) => {
      const instances = InstanceIds.map((id) => {
        const instance = world.instances.get(id);
        if (!instance) throw notFound("InvalidInstanceID.NotFound");
        advance(instance);
        return { ...instance };
      });
      return { Reservations: [{ Instances: instances }] };
    },

    DescribeInstanceStatus: ({ InstanceIds }) => {
      const instance = world.instances.get(InstanceIds[0]);
      instance.statusPolls += 1;
      const ok = instance.State.Name === "running" && instance.statusPolls >= statusOkAfter;
      return {
        InstanceStatuses: [
          {
            InstanceStatus: { Status: ok ? "ok" : "initializing" },
            SystemStatus: { Status: ok ? "ok" : "initializing" },
          },
        ],
      };
    },

    GetConsoleOutput: ({ InstanceId }) => {
      const instance = world.instances.get(InstanceId);
      instance.consolePolls += 1;
      const deploymentId = tagValue(instance.Tags, "ShipFlowDeployment");
      const text =
        instance.consolePolls < consoleReadyAfter
          ? "[    0.5] booting"
          : (consoleText ??
            `cloud-init finished\nSHIPFLOW-HOSTKEY-BEGIN\n${HOST_KEY}\nSHIPFLOW-HOSTKEY-END\nSHIPFLOW-BOOTSTRAP-COMPLETE ${deploymentId}\n`);
      return { Output: Buffer.from(text).toString("base64") };
    },

    TerminateInstances: ({ InstanceIds }) => {
      for (const id of InstanceIds) {
        const instance = world.instances.get(id);
        if (!instance) throw notFound("InvalidInstanceID.NotFound");
        instance.State = { Name: "shutting-down" };
        instance.polls = 0;
      }
      return {};
    },

    DescribeSecurityGroups: ({ GroupIds }) => {
      const group = world.groups.get(GroupIds[0]);
      if (!group) throw notFound("InvalidGroup.NotFound");
      return { SecurityGroups: [group] };
    },

    DeleteSecurityGroup: ({ GroupId }) => {
      if (world.depViolationsLeft > 0) {
        world.depViolationsLeft -= 1;
        throw awsError("DependencyViolation", "resource sg has a dependent object");
      }
      if (!world.groups.delete(GroupId)) throw notFound("InvalidGroup.NotFound");
      return {};
    },

    DescribeKeyPairs: ({ KeyNames }) => {
      const pair = world.keyPairs.get(KeyNames[0]);
      if (!pair) throw notFound("InvalidKeyPair.NotFound");
      return { KeyPairs: [pair] };
    },

    DeleteKeyPair: ({ KeyName }) => {
      world.keyPairs.delete(KeyName);
      return {};
    },
  };

  return {
    calls,
    world,
    names: () => calls.map((c) => c.name),
    count: (name) => calls.filter((c) => c.name === name).length,
    input: (name) => calls.find((c) => c.name === name)?.input,
    async call(name, input = {}) {
      calls.push({ name, input: structuredClone(input) });
      log?.push(`ec2:${name}`);
      const original = (i = input) => handlers[name](i, world);
      if (!handlers[name]) throw new Error(`fake EC2 has no handler for ${name}`);

      try {
        return overrides[name] ? await overrides[name](input, world, original) : original();
      } catch (error) {
        throw asSeamError(error, name);
      }
    },
  };
}

/** Resources another ShipFlow deployment and an unrelated project own. */
export function seedNeighbours(world) {
  const own = (id) => [
    { Key: "ManagedBy", Value: "ShipFlow" },
    { Key: "ShipFlowDeployment", Value: id },
  ];
  world.instances.set("i-other", {
    InstanceId: "i-other",
    State: { Name: "running" },
    Tags: own("sf-0000beef"),
    PublicIpAddress: "203.0.113.99",
    polls: 9,
  });
  world.groups.set("sg-other", { GroupId: "sg-other", GroupName: "shipflow-sf-0000beef", Tags: own("sf-0000beef") });
  world.keyPairs.set("shipflow-sf-0000beef", { KeyName: "shipflow-sf-0000beef", Tags: own("sf-0000beef") });
  world.instances.set("i-unrelated", {
    InstanceId: "i-unrelated",
    State: { Name: "running" },
    Tags: [{ Key: "Name", Value: "prod-db" }],
    PublicIpAddress: "203.0.113.77",
    polls: 9,
  });
  world.groups.set("sg-unrelated", { GroupId: "sg-unrelated", GroupName: "prod-db", Tags: [] });
  world.keyPairs.set("prod-key", { KeyName: "prod-key", Tags: [] });
}

// ------------------------------------------------------------------ prompts

/**
 * Scripted prompts. `answers` maps a substring of the question to a string (or
 * a function returning one). An unscripted prompt fails the test.
 */
export function createFakeIo({ answers = {}, interactive = true } = {}) {
  const output = [];
  const prompts = [];
  const lookup = (question, extra) => {
    prompts.push(question);
    const key = Object.keys(answers).find((k) => question.includes(k));
    if (key === undefined) return extra;
    const value = answers[key];
    return typeof value === "function" ? value(question) : value;
  };

  return {
    interactive,
    output,
    prompts,
    print: (line = "") => output.push(String(line)),
    warn: (line) => output.push(String(line)),
    json: (value) => output.push(JSON.stringify(value)),
    text: () => output.join("\n"),
    async ask(question, { defaultValue = "", validate } = {}) {
      const scripted = lookup(question, undefined);
      if (scripted === undefined && !defaultValue) throw new Error(`Unscripted prompt: ${question}`);
      const value = String(scripted ?? defaultValue).trim() || defaultValue;
      const problem = validate?.(value);
      if (problem) throw new Error(`Scripted answer for "${question}" was rejected: ${problem}`);
      return value;
    },
    async choose(question, choices, defaultValue) {
      const value = lookup(question, defaultValue);
      if (!choices.some((c) => c.value === value)) throw new Error(`Invalid choice "${value}" for ${question}`);
      return value;
    },
    async confirm(question, defaultYes = true) {
      const scripted = lookup(question, undefined);
      if (scripted === undefined) return defaultYes;
      return scripted === true || /^y/i.test(String(scripted));
    },
    async secret(promptText) {
      const value = lookup(promptText, undefined);
      if (value === undefined) throw new Error(`Unscripted secret prompt: ${promptText}`);
      return String(value);
    },
  };
}

// --------------------------------------------------------------------- deps

/**
 * Everything the workflows need, faked. Returns { deps, ... } with handles to
 * inspect what happened. `cwd` is a throw-away directory.
 */
export async function createFakeDeps({
  log = [],
  ec2 = createFakeEc2({ log }),
  sts = createFakeSts({ log }),
  apiOverrides = {},
  repoStatus = "ok",
  publicIp = "198.51.100.7",
  releaseResult = null,
  existingFiles = [],
  generateKeyOverride = null,
  sharedStore = null,
} = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sf-cloud-test-"));
  const cwd = path.join(root, "project");
  await fsp.mkdir(cwd);

  for (const file of existingFiles) await fsp.writeFile(path.join(cwd, file), "# existing\n");

  const clock = createClock();
  const apiCalls = [];
  const record = (name, result) => async (...args) => {
    apiCalls.push({ name, args });
    log.push(`api:${name}`);
    return typeof result === "function" ? result(...args) : result;
  };
  const cleanups = new Set();
  const keyDirs = [];
  let hex = 0;

  const api = {
    whoami: record("whoami", {
      secretsEnabled: true,
      targets: [{ name: "shipflow" }, { name: "ssh" }],
      instance: "test-server",
      allowedRepoPrefixes: ["https://github.com/"],
    }),
    listProjects: record("listProjects", { projects: [] }),
    getProject: record("getProject", { activeReleaseId: "Rel00001" }),
    putProject: record("putProject", { success: true }),
    setSecret: record("setSecret", { success: true }),
    createRelease: record("createRelease", { release: { release_id: "Rel00001" } }),
    checkProjectTarget: record("checkProjectTarget", { checks: [{ name: "ssh connection", ok: true, detail: "ok" }] }),
    ...Object.fromEntries(Object.entries(apiOverrides).map(([name, fn]) => [name, record(name, fn)])),
  };

  const store = sharedStore ?? createStore({ dir: path.join(root, "config", "cloud") });
  const authCalls = [];
  const auths = [];

  const deps = {
    api,
    serverUrl: () => "https://shipflow.example.test",
    loadSdk: async () => ({ fake: true }),
    createAwsClients: ({ region, auth }) => {
      authCalls.push({ region, mode: auth.mode });
      auths.push(auth);
      return { ec2, sts };
    },
    store,
    checkRepo: async () => ({ status: repoStatus, reason: "fake" }),
    detectPublicIp: async () => publicIp,
    createKeyDir: async () => {
      const dir = await createKeyDir();
      keyDirs.push(dir);
      return dir;
    },
    generateDeployKey:
      generateKeyOverride ??
      (async ({ dir }) => {
        const privateKeyPath = path.join(dir, "id_ed25519");
        await fsp.writeFile(privateKeyPath, PRIVATE_KEY_TEXT, { mode: 0o600 });
        return { privateKeyPath, publicKey: PUBLIC_KEY };
      }),
    wipeDir,
    removeDirSync: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    registerCleanup: (fn) => {
      cleanups.add(fn);
      return () => cleanups.delete(fn);
    },
    writeConfig: async (config, file) => {
      const full = path.join(cwd, file);
      if (fs.existsSync(full)) throw new Error(`${file} already exists`);
      await fsp.writeFile(full, renderConfig(config));
      return full;
    },
    fileExists: async (file) => fs.existsSync(path.join(cwd, file)),
    readFile: (file) => fsp.readFile(file, "utf8"),
    followRelease: async (release, { onState }) => {
      onState?.("BUILD (RUNNING)");
      return (
        releaseResult ?? {
          release_id: release.release_id,
          status: "SUCCESS",
          current_stage: "ACTIVATE",
          test_status: "PASSED",
        }
      );
    },
    randomHex: (bytes) => String(++hex).padStart(bytes * 2, "0").slice(-bytes * 2),
    sleep: clock.sleep,
    now: clock.now,
  };

  return { deps, root, cwd, api, apiCalls, store, authCalls, auths, keyDirs, cleanups, ec2, sts, clock, log };
}

/** Every file under `dir`, as text. */
export function readTree(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ file: full, text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

/** The default answers of a complete, valid wizard run. */
export const HAPPY_ANSWERS = {
  "AWS region": "ap-south-1",
  "How should ShipFlow authenticate": "profile",
  "AWS profile name": "",
  "Project / deployment name": "portfolio",
  "Git repository": "https://github.com/octocat/hello-world",
  Branch: "main",
  "Build output directory": "auto",
  "EC2 instance type": "t3.micro",
  "Root disk size": "8",
  "Allow SSH from": "yes",
  "Type CREATE": "CREATE",
  "Pin this host key": "yes",
};

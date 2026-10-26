// EC2 provisioning and teardown for one deployment: exactly one instance, one
// security group and one imported key pair, all tagged so ownership can be
// verified before anything is deleted.
//
// Every function takes `ec2`, an object with `call(operation, input)`.
import type { _InstanceType, Instance, InstanceTypeInfo, ResourceType, Tag, TagSpecification } from "@aws-sdk/client-ec2";

import { CloudError, errorCode, errorMessage } from "../errors.js";
import type { Ec2Api } from "./aws.js";
import { LIMITS } from "./inputs.js";
import { parseConsoleOutput } from "./userData.js";

type Sleep = (ms: number) => Promise<unknown>;

/** A resource created by one provisioning attempt. */
export interface CreatedResource {
  type: string;
  id: string | undefined;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs?: number;
  describe: string;
  sleep?: Sleep;
  now?: () => number;
}

/** What preflight decided about the AMI. */
export interface ImageChoice {
  imageId: string | undefined;
  name: string | undefined;
  creationDate: string | undefined;
  rootDeviceName: string | undefined;
  minDiskGiB: number;
}

/** What createResources needs to know about the deployment. */
export interface ProvisionPlan {
  deploymentId: string;
  project: string;
  vpcId: string | undefined;
  subnetId: string | undefined;
  sshCidr: string;
  instanceType: string;
  diskGiB: number;
  image: Pick<ImageChoice, "imageId" | "rootDeviceName">;
}

/** Whether a resource exists and, if so, whether this deployment owns it. */
export interface ResourceStatus {
  exists: boolean;
  owned?: boolean;
  state?: string | undefined;
  publicIp?: string | null;
  instanceType?: string | undefined;
}

export interface DeploymentReport {
  instance: ResourceStatus | null;
  securityGroup: ResourceStatus | null;
  keyPair: ResourceStatus | null;
}

/** The AWS resources of one deployment, as recorded locally. */
export interface DeploymentResources {
  deploymentId: string;
  instanceId?: string | undefined;
  securityGroupId?: string | undefined;
  keyPairName?: string | undefined;
}

export interface DestroyResult {
  removed: string[];
  skipped: string[];
  failed: { what: string; error: string }[];
}

export interface DestroyOptions {
  sleep?: Sleep;
  now?: () => number;
  log?: (line: string) => void;
  timeouts?: Partial<WaitOptions>;
}

export const TAG_MANAGED_BY = "ManagedBy";
export const TAG_DEPLOYMENT = "ShipFlowDeployment";
export const TAG_PROJECT = "ShipFlowProject";

export function tagsFor({ deploymentId, project }: { deploymentId: string; project: string }): Tag[] {
  return [
    { Key: TAG_MANAGED_BY, Value: "ShipFlow" },
    { Key: TAG_DEPLOYMENT, Value: deploymentId },
    { Key: TAG_PROJECT, Value: project },
    { Key: "Name", Value: `shipflow-${project}` },
  ];
}

/** True only for resources ShipFlow created for exactly this deployment. */
export function isOwned(tags: Tag[] | undefined, deploymentId: string): boolean {
  const get = (key: string) => (tags ?? []).find((tag) => tag.Key === key)?.Value;
  return get(TAG_MANAGED_BY) === "ShipFlow" && get(TAG_DEPLOYMENT) === deploymentId;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `check()` (returns { done, value }) until done or `timeoutMs` passes.
 */
export async function waitFor<T>(
  check: () => Promise<{ done: boolean; value?: T }>,
  { timeoutMs, intervalMs = 5000, describe, sleep = defaultSleep, now = Date.now }: WaitOptions
): Promise<T> {
  const startedAt = now();

  for (;;) {
    const result = await check();

    if (result.done) return result.value as T; // callers that wait for completion only supply a value when done

    if (now() - startedAt >= timeoutMs) {
      throw new CloudError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${describe}.`);
    }

    await sleep(intervalMs);
  }
}

const NOT_FOUND = new Set([
  "InvalidInstanceID.NotFound",
  "InvalidGroup.NotFound",
  "InvalidKeyPair.NotFound",
  "InvalidGroupId.NotFound",
]);

const isNotFound = (error: unknown): boolean => {
  const code = errorCode(error);
  return code !== undefined && NOT_FOUND.has(code);
};
const isPermission = (error: unknown): boolean => {
  const code = errorCode(error);
  return code !== undefined && ["UnauthorizedOperation", "AccessDenied", "AccessDeniedException"].includes(code);
};

// ---------------------------------------------------------------- preflight

/**
 * Validate everything that can be validated without creating anything:
 * region, instance type (x86_64, on-demand, size limits, offered), default VPC
 * and subnet, and the current official Amazon Linux 2023 AMI.
 */
export async function preflight(
  ec2: Ec2Api,
  { region, instanceType, diskGiB }: { region: string; instanceType: string; diskGiB: number }
): Promise<{
  notes: string[];
  image: ImageChoice;
  vpcId: string | undefined;
  subnetId: string | undefined;
  availabilityZone: string | undefined;
  instanceType: { vcpus: number; memoryMiB: number };
}> {
  const notes: string[] = [];

  try {
    const regions = await ec2.call("DescribeRegions", { RegionNames: [region] });

    if (!regions.Regions?.length) {
      throw new CloudError(`Region ${region} is not available to this AWS account.`);
    }
  } catch (error) {
    if (error instanceof CloudError) throw error;

    if (errorCode(error) === "InvalidParameterValue") {
      throw new CloudError(`Region ${region} is not recognised or is not enabled for this AWS account.`, {
        hint: "Enable opt-in regions in the AWS console (Account → AWS Regions).",
      });
    }

    if (!isPermission(error)) throw error;
    notes.push("Could not check the region (no ec2:DescribeRegions permission); continuing.");
  }

  let typeInfo: InstanceTypeInfo | undefined;

  try {
    typeInfo = (await ec2.call("DescribeInstanceTypes", { InstanceTypes: [instanceType as _InstanceType] })).InstanceTypes?.[0];
  } catch (error) {
    if (errorCode(error) !== "InvalidInstanceType") throw error;
  }

  if (!typeInfo) {
    throw new CloudError(`Instance type ${instanceType} does not exist in ${region}.`);
  }

  if (!typeInfo.ProcessorInfo?.SupportedArchitectures?.includes("x86_64")) {
    throw new CloudError(`${instanceType} is not an x86_64 instance type; this version deploys to x86_64 only.`);
  }

  if (typeInfo.SupportedUsageClasses && !typeInfo.SupportedUsageClasses.includes("on-demand")) {
    throw new CloudError(`${instanceType} cannot be launched on-demand.`);
  }

  const vcpus = typeInfo.VCpuInfo?.DefaultVCpus ?? 0;
  const memoryMiB = typeInfo.MemoryInfo?.SizeInMiB ?? 0;

  if (typeInfo.BareMetal || vcpus > LIMITS.maxVcpus || memoryMiB > LIMITS.maxMemoryMiB) {
    throw new CloudError(
      `${instanceType} (${vcpus} vCPU, ${Math.round(memoryMiB / 1024)} GiB) is larger than this test ` +
        `workflow allows (${LIMITS.maxVcpus} vCPU, ${LIMITS.maxMemoryMiB / 1024} GiB, no bare metal).`,
      { exitCode: 2 }
    );
  }

  const offerings = await ec2.call("DescribeInstanceTypeOfferings", {
    LocationType: "availability-zone",
    Filters: [{ Name: "instance-type", Values: [instanceType] }],
  });
  const offeredZones = new Set((offerings.InstanceTypeOfferings ?? []).map((o) => o.Location));

  if (offeredZones.size === 0) {
    throw new CloudError(`${instanceType} is not offered in any availability zone of ${region}.`);
  }

  const vpcs = await ec2.call("DescribeVpcs", { Filters: [{ Name: "isDefault", Values: ["true"] }] });
  const vpc = vpcs.Vpcs?.[0];

  if (!vpc) {
    throw new CloudError(`There is no default VPC in ${region}, and this version only uses the default VPC.`, {
      hint: `Create one with: aws ec2 create-default-vpc --region ${region}  (or pick a region that has one).`,
    });
  }

  const subnets = await ec2.call("DescribeSubnets", {
    Filters: [
      { Name: "vpc-id", Values: [vpc.VpcId as string] }, // AWS always returns the ID
      { Name: "default-for-az", Values: ["true"] },
      { Name: "state", Values: ["available"] },
    ],
  });
  const subnet = (subnets.Subnets ?? [])
    .filter((s) => offeredZones.has(s.AvailabilityZone))
    .sort((a, b) => (a.AvailabilityZone ?? "").localeCompare(b.AvailabilityZone ?? ""))[0];

  if (!subnet) {
    throw new CloudError(
      `The default VPC in ${region} has no available default subnet in an availability zone that offers ${instanceType}.`,
      { hint: "Pick another instance type or region." }
    );
  }

  const image = await findAmi(ec2, region);

  if (diskGiB < image.minDiskGiB) {
    throw new CloudError(`The AMI needs a root disk of at least ${image.minDiskGiB} GiB.`, { exitCode: 2 });
  }

  return {
    notes,
    image,
    vpcId: vpc.VpcId,
    subnetId: subnet.SubnetId,
    availabilityZone: subnet.AvailabilityZone,
    instanceType: { vcpus, memoryMiB },
  };
}

/**
 * The newest official Amazon Linux 2023 x86_64 AMI in the region, found by
 * querying Amazon's own images (never a hard-coded ID).
 */
export async function findAmi(ec2: Ec2Api, region: string): Promise<ImageChoice> {
  const result = await ec2.call("DescribeImages", {
    Owners: ["amazon"],
    Filters: [
      { Name: "name", Values: ["al2023-ami-2023.*-x86_64"] },
      { Name: "architecture", Values: ["x86_64"] },
      { Name: "state", Values: ["available"] },
      { Name: "root-device-type", Values: ["ebs"] },
      { Name: "virtualization-type", Values: ["hvm"] },
    ],
  });

  const image = (result.Images ?? [])
    .filter(
      (i) =>
        i.ImageOwnerAlias === "amazon" &&
        /^al2023-ami-2023\.[\d.]+-kernel-[\d.]+-x86_64$/.test(i.Name ?? "")
    )
    .sort((a, b) => String(b.CreationDate).localeCompare(String(a.CreationDate)))[0];

  if (!image) {
    throw new CloudError(`No official Amazon Linux 2023 x86_64 AMI is available in ${region}.`);
  }

  const root = (image.BlockDeviceMappings ?? []).find((m) => m.DeviceName === image.RootDeviceName);

  return {
    imageId: image.ImageId,
    name: image.Name,
    creationDate: image.CreationDate,
    rootDeviceName: image.RootDeviceName,
    minDiskGiB: root?.Ebs?.VolumeSize ?? 8,
  };
}

// ------------------------------------------------------------------ create

const BURSTABLE = /^t\d/;

/**
 * Create the key pair, security group and instance. Records each resource in
 * `onResource` as soon as it exists. If anything fails, the thrown error has
 * `.created`: the resources created by THIS attempt (and only those).
 */
export async function createResources(
  ec2: Ec2Api,
  plan: ProvisionPlan,
  {
    publicKey,
    userData,
    onResource = () => {},
  }: { publicKey: string; userData: string; onResource?: (resource: CreatedResource) => void }
): Promise<{
  instanceId: string;
  securityGroupId: string;
  keyPairName: string;
  created: CreatedResource[];
}> {
  const created: CreatedResource[] = [];
  const record = (type: string, id: string | undefined): void => {
    created.push({ type, id });
    onResource({ type, id });
  };
  const tags = tagsFor(plan);
  const tagSpec = (ResourceType: ResourceType): TagSpecification => ({ ResourceType, Tags: tags });
  const keyPairName = `shipflow-${plan.deploymentId}`;

  try {
    await ec2.call("ImportKeyPair", {
      KeyName: keyPairName,
      PublicKeyMaterial: Buffer.from(publicKey),
      TagSpecifications: [tagSpec("key-pair")],
    });
    record("keyPair", keyPairName);

    const group = await ec2.call("CreateSecurityGroup", {
      GroupName: `shipflow-${plan.deploymentId}`,
      Description: `ShipFlow ${plan.deploymentId} (${plan.project})`,
      VpcId: plan.vpcId,
      TagSpecifications: [tagSpec("security-group")],
    });
    const securityGroupId = group.GroupId as string; // AWS always returns the ID
    record("securityGroup", securityGroupId);

    await ec2.call("AuthorizeSecurityGroupIngress", {
      GroupId: securityGroupId,
      IpPermissions: [
        {
          IpProtocol: "tcp",
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: plan.sshCidr, Description: "ShipFlow worker SSH" }],
        },
        {
          IpProtocol: "tcp",
          FromPort: 80,
          ToPort: 80,
          IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "Public HTTP" }],
        },
      ],
    });

    const run = await ec2.call("RunInstances", {
      ImageId: plan.image.imageId,
      InstanceType: plan.instanceType as _InstanceType, // validated by parseInstanceType
      MinCount: 1,
      MaxCount: 1,
      KeyName: keyPairName,
      UserData: Buffer.from(userData).toString("base64"),
      ClientToken: plan.deploymentId,
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: plan.subnetId,
          AssociatePublicIpAddress: true,
          DeleteOnTermination: true,
          Groups: [securityGroupId],
        },
      ],
      BlockDeviceMappings: [
        {
          DeviceName: plan.image.rootDeviceName,
          Ebs: { VolumeSize: plan.diskGiB, VolumeType: "gp3", DeleteOnTermination: true },
        },
      ],
      MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled", HttpPutResponseHopLimit: 1 },
      // Burstable instances default to "unlimited" CPU credits, which can bill
      // extra; "standard" throttles instead.
      ...(BURSTABLE.test(plan.instanceType) ? { CreditSpecification: { CpuCredits: "standard" } } : {}),
      TagSpecifications: [tagSpec("instance"), tagSpec("volume"), tagSpec("network-interface")],
    });

    // Record every instance in the response so none can be orphaned.
    const instances = run.Instances ?? [];
    instances.forEach((instance) => record("instance", instance.InstanceId));

    if (instances.length !== 1) {
      throw new CloudError(`Expected exactly one instance but AWS returned ${instances.length}.`);
    }

    // AWS always returns the instance ID.
    return { instanceId: instances[0]?.InstanceId as string, securityGroupId, keyPairName, created };
  } catch (error) {
    if (typeof error === "object" && error !== null) Object.assign(error, { created });
    throw error;
  }
}

/** The resources a failed createResources() had already created. */
export function createdResources(error: unknown): CreatedResource[] {
  if (typeof error !== "object" || error === null || !("created" in error)) return [];
  return (error.created as CreatedResource[] | undefined) ?? [];
}

// -------------------------------------------------------------------- wait

export async function describeInstance(ec2: Ec2Api, instanceId: string): Promise<Instance | null> {
  const result = await ec2.call("DescribeInstances", { InstanceIds: [instanceId] });
  return result.Reservations?.flatMap((r) => r.Instances ?? [])[0] ?? null;
}

export async function waitForRunning(ec2: Ec2Api, instanceId: string, opts: Partial<WaitOptions> = {}) {
  return waitFor(
    async () => {
      const instance = await describeInstance(ec2, instanceId);
      const state = instance?.State?.Name;

      if (state !== undefined && ["terminated", "shutting-down", "stopped", "stopping"].includes(state)) {
        throw new CloudError(`The instance entered the "${state}" state instead of running.`);
      }

      // `done` requires a running instance, so the value is only used when it exists.
      return { done: state === "running" && Boolean(instance?.PublicIpAddress), value: instance as Instance };
    },
    { timeoutMs: 5 * 60_000, intervalMs: 5000, describe: "the instance to start running", ...opts }
  );
}

export async function waitForStatusOk(ec2: Ec2Api, instanceId: string, opts: Partial<WaitOptions> = {}) {
  return waitFor(
    async () => {
      const result = await ec2.call("DescribeInstanceStatus", { InstanceIds: [instanceId], IncludeAllInstances: true });
      const status = result.InstanceStatuses?.[0];
      const ok = status?.InstanceStatus?.Status === "ok" && status?.SystemStatus?.Status === "ok";

      return { done: ok, value: status };
    },
    { timeoutMs: 10 * 60_000, intervalMs: 10_000, describe: "the instance health checks to pass", ...opts }
  );
}

/**
 * Wait for the bootstrap script to report completion and its SSH host key on
 * the instance console (read through the authenticated EC2 API).
 */
export async function waitForBootstrap(
  ec2: Ec2Api,
  instanceId: string,
  deploymentId: string,
  opts: Partial<WaitOptions> = {}
) {
  return waitFor(
    async () => {
      const result = await ec2.call("GetConsoleOutput", { InstanceId: instanceId, Latest: true });
      const parsed = parseConsoleOutput(result.Output, deploymentId);

      // `done` requires a host key, so the value is only used when it is present.
      return { done: parsed.complete && Boolean(parsed.hostKey), value: parsed as { complete: boolean; hostKey: string } };
    },
    { timeoutMs: 12 * 60_000, intervalMs: 15_000, describe: "the VPS bootstrap to finish", ...opts }
  );
}

// ---------------------------------------------------------------- teardown

/**
 * Read-only look at a deployment's resources and whether ShipFlow owns them.
 */
export async function inspectDeployment(
  ec2: Ec2Api,
  meta: { id: string; instanceId?: string | undefined; securityGroupId?: string | undefined; keyPairName?: string | undefined }
): Promise<DeploymentReport> {
  const report: DeploymentReport = { instance: null, securityGroup: null, keyPair: null };

  if (meta.instanceId) {
    try {
      const instance = await describeInstance(ec2, meta.instanceId);
      report.instance = instance
        ? {
            exists: true,
            state: instance.State?.Name,
            publicIp: instance.PublicIpAddress ?? null,
            instanceType: instance.InstanceType,
            owned: isOwned(instance.Tags, meta.id),
          }
        : { exists: false };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      report.instance = { exists: false };
    }
  }

  if (meta.securityGroupId) {
    try {
      const group = (await ec2.call("DescribeSecurityGroups", { GroupIds: [meta.securityGroupId] })).SecurityGroups?.[0];
      report.securityGroup = group
        ? { exists: true, owned: isOwned(group.Tags, meta.id) && /^shipflow-/.test(group.GroupName ?? "") }
        : { exists: false };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      report.securityGroup = { exists: false };
    }
  }

  if (meta.keyPairName) {
    try {
      const pair = (await ec2.call("DescribeKeyPairs", { KeyNames: [meta.keyPairName] })).KeyPairs?.[0];
      report.keyPair = pair
        ? { exists: true, owned: isOwned(pair.Tags, meta.id) }
        : { exists: false };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      report.keyPair = { exists: false };
    }
  }

  return report;
}

/**
 * Terminate the instance and delete the security group and key pair of ONE
 * deployment. Each resource is verified (tags ManagedBy=ShipFlow and
 * ShipFlowDeployment=<id>) before it is touched; anything else is left alone.
 *
 * @returns {{ removed: string[], skipped: string[], failed: {what, error}[] }}
 */
export async function destroyResources(
  ec2: Ec2Api,
  resources: DeploymentResources,
  { sleep = defaultSleep, now = Date.now, log = () => {}, timeouts = {} }: DestroyOptions = {}
): Promise<DestroyResult> {
  const meta = { id: resources.deploymentId, ...resources };
  const result: DestroyResult = { removed: [], skipped: [], failed: [] };
  const report = await inspectDeployment(ec2, meta);

  if (report.instance?.exists && !report.instance.owned) {
    throw new CloudError(
      `Instance ${resources.instanceId} is not tagged as ShipFlow deployment ${resources.deploymentId}; refusing to touch it.`
    );
  }

  const attempt = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
      result.removed.push(what);
    } catch (error) {
      result.failed.push({ what, error: errorMessage(error) });
    }
  };

  if (report.instance?.exists && report.instance.state !== "terminated") {
    const instanceState = report.instance.state;
    const instanceId = resources.instanceId as string; // an instance is only reported when an ID was given

    await attempt(`instance ${instanceId}`, async () => {
      if (instanceState !== "shutting-down") {
        log(`Terminating ${instanceId}...`);
        await ec2.call("TerminateInstances", { InstanceIds: [instanceId] });
      }

      await waitFor(
        async () => {
          const instance = await describeInstance(ec2, instanceId);
          return { done: !instance || instance.State?.Name === "terminated", value: true };
        },
        { timeoutMs: 5 * 60_000, intervalMs: 5000, describe: "the instance to terminate", sleep, now, ...timeouts }
      );
    });
  } else if (resources.instanceId) {
    result.skipped.push(`instance ${resources.instanceId} (already gone)`);
  }

  // Only delete dependent resources once the instance is no longer using them.
  const instanceGone = !result.failed.some((f) => f.what.startsWith("instance"));

  const securityGroupId = resources.securityGroupId;

  if (securityGroupId) {
    const what = `security group ${securityGroupId}`;

    if (!instanceGone) {
      result.skipped.push(`${what} (instance still present)`);
    } else if (!report.securityGroup?.exists) {
      result.skipped.push(`${what} (already gone)`);
    } else if (!report.securityGroup.owned) {
      result.skipped.push(`${what} (not tagged for this deployment; left untouched)`);
    } else {
      await attempt(what, async () => {
        // The network interface can outlive the instance for a short while.
        for (let tries = 1; ; tries++) {
          try {
            await ec2.call("DeleteSecurityGroup", { GroupId: securityGroupId });
            return;
          } catch (error) {
            if (isNotFound(error)) return;
            if (errorCode(error) !== "DependencyViolation" || tries >= 18) throw error;
            await sleep(10_000);
          }
        }
      });
    }
  }

  const keyPairName = resources.keyPairName;

  if (keyPairName) {
    const what = `key pair ${keyPairName}`;

    if (!instanceGone) {
      result.skipped.push(`${what} (instance still present)`);
    } else if (!report.keyPair?.exists) {
      result.skipped.push(`${what} (already gone)`);
    } else if (!report.keyPair.owned) {
      result.skipped.push(`${what} (not tagged for this deployment; left untouched)`);
    } else {
      await attempt(what, () => ec2.call("DeleteKeyPair", { KeyName: keyPairName }));
    }
  }

  return result;
}

/**
 * Remove what a failed provisioning attempt created. `created` is the list
 * from createResources (error.created).
 */
export async function cleanupPartial(
  ec2: Ec2Api,
  deploymentId: string,
  created: CreatedResource[],
  opts: DestroyOptions = {}
): Promise<DestroyResult> {
  const pick = (type: string) => created.find((c) => c.type === type)?.id;
  const instances = created.filter((c) => c.type === "instance");

  const results: DestroyResult[] = [];

  for (const instance of instances.length ? instances : [null]) {
    results.push(
      await destroyResources(
        ec2,
        {
          deploymentId,
          instanceId: instance?.id,
          // Dependent resources are removed once, with the last instance.
          securityGroupId: instance === instances.at(-1) || !instance ? pick("securityGroup") : undefined,
          keyPairName: instance === instances.at(-1) || !instance ? pick("keyPair") : undefined,
        },
        opts
      )
    );
  }

  return {
    removed: results.flatMap((r) => r.removed),
    skipped: results.flatMap((r) => r.skipped),
    failed: results.flatMap((r) => r.failed),
  };
}

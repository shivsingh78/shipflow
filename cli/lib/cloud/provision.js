// EC2 provisioning and teardown for one deployment: exactly one instance, one
// security group and one imported key pair, all tagged so ownership can be
// verified before anything is deleted.
//
// Every function takes `ec2`, an object with `call(operation, input)`.
import { CloudError } from "../errors.js";
import { LIMITS } from "./inputs.js";
import { parseConsoleOutput } from "./userData.js";

export const TAG_MANAGED_BY = "ManagedBy";
export const TAG_DEPLOYMENT = "ShipFlowDeployment";
export const TAG_PROJECT = "ShipFlowProject";

export function tagsFor({ deploymentId, project }) {
  return [
    { Key: TAG_MANAGED_BY, Value: "ShipFlow" },
    { Key: TAG_DEPLOYMENT, Value: deploymentId },
    { Key: TAG_PROJECT, Value: project },
    { Key: "Name", Value: `shipflow-${project}` },
  ];
}

/** True only for resources ShipFlow created for exactly this deployment. */
export function isOwned(tags, deploymentId) {
  const get = (key) => (tags ?? []).find((tag) => tag.Key === key)?.Value;
  return get(TAG_MANAGED_BY) === "ShipFlow" && get(TAG_DEPLOYMENT) === deploymentId;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `check()` (returns { done, value }) until done or `timeoutMs` passes.
 */
export async function waitFor(
  check,
  { timeoutMs, intervalMs = 5000, describe, sleep = defaultSleep, now = Date.now }
) {
  const startedAt = now();

  for (;;) {
    const result = await check();

    if (result.done) return result.value;

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

const isNotFound = (error) => NOT_FOUND.has(error?.code);
const isPermission = (error) =>
  ["UnauthorizedOperation", "AccessDenied", "AccessDeniedException"].includes(error?.code);

// ---------------------------------------------------------------- preflight

/**
 * Validate everything that can be validated without creating anything:
 * region, instance type (x86_64, on-demand, size limits, offered), default VPC
 * and subnet, and the current official Amazon Linux 2023 AMI.
 */
export async function preflight(ec2, { region, instanceType, diskGiB }) {
  const notes = [];

  try {
    const regions = await ec2.call("DescribeRegions", { RegionNames: [region] });

    if (!regions.Regions?.length) {
      throw new CloudError(`Region ${region} is not available to this AWS account.`);
    }
  } catch (error) {
    if (error instanceof CloudError) throw error;

    if (error.code === "InvalidParameterValue") {
      throw new CloudError(`Region ${region} is not recognised or is not enabled for this AWS account.`, {
        hint: "Enable opt-in regions in the AWS console (Account → AWS Regions).",
      });
    }

    if (!isPermission(error)) throw error;
    notes.push("Could not check the region (no ec2:DescribeRegions permission); continuing.");
  }

  let typeInfo;

  try {
    typeInfo = (await ec2.call("DescribeInstanceTypes", { InstanceTypes: [instanceType] })).InstanceTypes?.[0];
  } catch (error) {
    if (error.code !== "InvalidInstanceType") throw error;
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
      { Name: "vpc-id", Values: [vpc.VpcId] },
      { Name: "default-for-az", Values: ["true"] },
      { Name: "state", Values: ["available"] },
    ],
  });
  const subnet = (subnets.Subnets ?? [])
    .filter((s) => offeredZones.has(s.AvailabilityZone))
    .sort((a, b) => a.AvailabilityZone.localeCompare(b.AvailabilityZone))[0];

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
export async function findAmi(ec2, region) {
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
export async function createResources(ec2, plan, { publicKey, userData, onResource = () => {} }) {
  const created = [];
  const record = (type, id) => {
    created.push({ type, id });
    onResource({ type, id });
  };
  const tags = tagsFor(plan);
  const tagSpec = (ResourceType) => ({ ResourceType, Tags: tags });
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
    const securityGroupId = group.GroupId;
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
      InstanceType: plan.instanceType,
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

    return { instanceId: instances[0].InstanceId, securityGroupId, keyPairName, created };
  } catch (error) {
    error.created = created;
    throw error;
  }
}

// -------------------------------------------------------------------- wait

export async function describeInstance(ec2, instanceId) {
  const result = await ec2.call("DescribeInstances", { InstanceIds: [instanceId] });
  return result.Reservations?.flatMap((r) => r.Instances ?? [])[0] ?? null;
}

export async function waitForRunning(ec2, instanceId, opts = {}) {
  return waitFor(
    async () => {
      const instance = await describeInstance(ec2, instanceId);
      const state = instance?.State?.Name;

      if (["terminated", "shutting-down", "stopped", "stopping"].includes(state)) {
        throw new CloudError(`The instance entered the "${state}" state instead of running.`);
      }

      return { done: state === "running" && Boolean(instance.PublicIpAddress), value: instance };
    },
    { timeoutMs: 5 * 60_000, intervalMs: 5000, describe: "the instance to start running", ...opts }
  );
}

export async function waitForStatusOk(ec2, instanceId, opts = {}) {
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
export async function waitForBootstrap(ec2, instanceId, deploymentId, opts = {}) {
  return waitFor(
    async () => {
      const result = await ec2.call("GetConsoleOutput", { InstanceId: instanceId, Latest: true });
      const parsed = parseConsoleOutput(result.Output, deploymentId);

      return { done: parsed.complete && Boolean(parsed.hostKey), value: parsed };
    },
    { timeoutMs: 12 * 60_000, intervalMs: 15_000, describe: "the VPS bootstrap to finish", ...opts }
  );
}

// ---------------------------------------------------------------- teardown

/**
 * Read-only look at a deployment's resources and whether ShipFlow owns them.
 */
export async function inspectDeployment(ec2, meta) {
  const report = { instance: null, securityGroup: null, keyPair: null };

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
  ec2,
  resources,
  { sleep = defaultSleep, now = Date.now, log = () => {}, timeouts = {} } = {}
) {
  const meta = { id: resources.deploymentId, ...resources };
  const result = { removed: [], skipped: [], failed: [] };
  const report = await inspectDeployment(ec2, meta);

  if (report.instance?.exists && !report.instance.owned) {
    throw new CloudError(
      `Instance ${resources.instanceId} is not tagged as ShipFlow deployment ${resources.deploymentId}; refusing to touch it.`
    );
  }

  const attempt = async (what, work) => {
    try {
      await work();
      result.removed.push(what);
    } catch (error) {
      result.failed.push({ what, error: error.message });
    }
  };

  if (report.instance?.exists && report.instance.state !== "terminated") {
    await attempt(`instance ${resources.instanceId}`, async () => {
      if (report.instance.state !== "shutting-down") {
        log(`Terminating ${resources.instanceId}...`);
        await ec2.call("TerminateInstances", { InstanceIds: [resources.instanceId] });
      }

      await waitFor(
        async () => {
          const instance = await describeInstance(ec2, resources.instanceId);
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

  if (resources.securityGroupId) {
    const what = `security group ${resources.securityGroupId}`;

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
            await ec2.call("DeleteSecurityGroup", { GroupId: resources.securityGroupId });
            return;
          } catch (error) {
            if (isNotFound(error)) return;
            if (error.code !== "DependencyViolation" || tries >= 18) throw error;
            await sleep(10_000);
          }
        }
      });
    }
  }

  if (resources.keyPairName) {
    const what = `key pair ${resources.keyPairName}`;

    if (!instanceGone) {
      result.skipped.push(`${what} (instance still present)`);
    } else if (!report.keyPair?.exists) {
      result.skipped.push(`${what} (already gone)`);
    } else if (!report.keyPair.owned) {
      result.skipped.push(`${what} (not tagged for this deployment; left untouched)`);
    } else {
      await attempt(what, () => ec2.call("DeleteKeyPair", { KeyName: resources.keyPairName }));
    }
  }

  return result;
}

/**
 * Remove what a failed provisioning attempt created. `created` is the list
 * from createResources (error.created).
 */
export async function cleanupPartial(ec2, deploymentId, created, opts = {}) {
  const pick = (type) => created.find((c) => c.type === type)?.id;
  const instances = created.filter((c) => c.type === "instance");

  const results = [];

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

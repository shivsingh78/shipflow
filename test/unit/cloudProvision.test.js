import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanupPartial,
  createResources,
  destroyResources,
  inspectDeployment,
  isOwned,
  preflight,
  waitForBootstrap,
  waitForRunning,
  waitForStatusOk,
} from "../../cli/lib/cloud/provision.js";
import { buildUserData } from "../../cli/lib/cloud/userData.js";
import {
  PUBLIC_IP,
  PUBLIC_KEY,
  awsError,
  createClock,
  createFakeEc2,
  seedNeighbours,
} from "./helpers/cloudHarness.js";

const ID = "sf-0000abcd";
const basePlan = (extra = {}) => ({
  deploymentId: ID,
  project: "portfolio",
  instanceType: "t3.micro",
  diskGiB: 8,
  sshCidr: "198.51.100.7/32",
  vpcId: "vpc-default",
  subnetId: "subnet-a",
  image: { imageId: "ami-new", rootDeviceName: "/dev/xvda" },
  ...extra,
});
const userData = buildUserData({ project: "portfolio", deploymentId: ID, publicKey: PUBLIC_KEY });
const create = (ec2, plan = basePlan()) => createResources(ec2, plan, { publicKey: PUBLIC_KEY, userData });

// ---------------------------------------------------------------- preflight

test("preflight: picks the newest official AL2023 AMI, an offered AZ's default subnet, and checks the type", async () => {
  const ec2 = createFakeEc2();
  const ready = await preflight(ec2, { region: "ap-south-1", instanceType: "t3.micro", diskGiB: 8 });

  assert.equal(ready.image.imageId, "ami-new", "newest; not minimal, not a lookalike without the Amazon alias");
  assert.equal(ready.image.rootDeviceName, "/dev/xvda");
  assert.equal(ready.vpcId, "vpc-default");
  assert.equal(ready.subnetId, "subnet-a", "deterministic: first AZ that offers the type (not subnet-c)");
  assert.equal(ready.availabilityZone, "ap-south-1a");

  const images = ec2.input("DescribeImages");
  assert.deepEqual(images.Owners, ["amazon"], "official images only; no hard-coded AMI ID");
  assert.ok(images.Filters.some((f) => f.Name === "architecture" && f.Values[0] === "x86_64"));
  assert.equal(ec2.count("RunInstances"), 0, "preflight creates nothing");
  assert.ok(ec2.names().every((name) => name.startsWith("Describe")), ec2.names().join());
});

test("preflight: refuses what cannot or should not run", async () => {
  const check = (options, overrides, pattern) =>
    assert.rejects(
      preflight(createFakeEc2({ overrides }), { region: "ap-south-1", instanceType: "t3.micro", diskGiB: 8, ...options }),
      pattern
    );

  await check({ instanceType: "nope.large" }, {}, /does not exist in ap-south-1/);
  await check({ instanceType: "t4g.micro" }, {}, /not an x86_64/);
  await check({ instanceType: "m5.16xlarge" }, {}, /larger than this test workflow allows/);
  await check({}, { DescribeInstanceTypeOfferings: () => ({ InstanceTypeOfferings: [] }) }, /not offered in any availability zone/);
  await check({}, { DescribeVpcs: () => ({ Vpcs: [] }) }, /no default VPC/);
  await check({}, { DescribeSubnets: () => ({ Subnets: [{ SubnetId: "s", AvailabilityZone: "ap-south-1z" }] }) }, /no available default subnet/);
  await check({}, { DescribeImages: () => ({ Images: [] }) }, /No official Amazon Linux 2023/);
  await check({}, { DescribeRegions: () => ({ Regions: [] }) }, /not available to this AWS account/);
  await check({}, { DescribeRegions: () => { throw awsError("InvalidParameterValue"); } }, /not recognised or is not enabled/);
});

test("preflight: a missing DescribeRegions permission is tolerated and noted", async () => {
  const ec2 = createFakeEc2({ overrides: { DescribeRegions: () => { throw awsError("UnauthorizedOperation", "not allowed"); } } });
  const ready = await preflight(ec2, { region: "ap-south-1", instanceType: "t3.micro", diskGiB: 8 });
  assert.match(ready.notes[0], /Could not check the region/);
});

test("preflight: the disk must fit the AMI", async () => {
  const ec2 = createFakeEc2({
    overrides: {
      DescribeImages: (_i, _w, original) => {
        const result = original();
        result.Images.forEach((i) => i.BlockDeviceMappings.forEach((m) => (m.Ebs.VolumeSize = 30)));
        return result;
      },
    },
  });
  await assert.rejects(preflight(ec2, { region: "ap-south-1", instanceType: "t3.micro", diskGiB: 8 }), /at least 30 GiB/);
});

// ------------------------------------------------------------------- create

test("create: exactly one instance, one security group (SSH only from the CIDR, HTTP public), tagged, volume deleted on termination", async () => {
  const ec2 = createFakeEc2();
  const created = await create(ec2);

  assert.equal(ec2.count("RunInstances"), 1);
  assert.equal(ec2.world.instances.size, 1);
  assert.equal(ec2.world.groups.size, 1);
  assert.equal(ec2.world.keyPairs.size, 1);
  assert.deepEqual(created.created.map((c) => c.type), ["keyPair", "securityGroup", "instance"]);

  const group = [...ec2.world.groups.values()][0];
  assert.deepEqual(
    group.rules.map((r) => [r.IpProtocol, r.FromPort, r.ToPort, r.IpRanges.map((x) => x.CidrIp)]),
    [["tcp", 22, 22, ["198.51.100.7/32"]], ["tcp", 80, 80, ["0.0.0.0/0"]]],
    "no other ports, and 0.0.0.0/0 only on 80"
  );

  const run = ec2.input("RunInstances");
  assert.equal(run.MinCount, 1);
  assert.equal(run.MaxCount, 1);
  assert.equal(run.NetworkInterfaces[0].AssociatePublicIpAddress, true);
  assert.deepEqual(run.NetworkInterfaces[0].Groups, [created.securityGroupId]);
  assert.equal(run.BlockDeviceMappings[0].Ebs.DeleteOnTermination, true);
  assert.equal(run.BlockDeviceMappings[0].Ebs.VolumeType, "gp3");
  assert.equal(run.MetadataOptions.HttpTokens, "required");
  assert.equal(run.CreditSpecification.CpuCredits, "standard");
  assert.equal(run.ClientToken, ID, "retries cannot create a second instance");
  assert.equal(run.ImageId, "ami-new");

  for (const resource of [[...ec2.world.instances.values()][0], group, [...ec2.world.keyPairs.values()][0]]) {
    assert.equal(isOwned(resource.Tags, ID), true);
  }

  // No Elastic IP, NAT gateway, load balancer or volume is created separately.
  assert.deepEqual(
    [...new Set(ec2.names())].sort(),
    ["AuthorizeSecurityGroupIngress", "CreateSecurityGroup", "ImportKeyPair", "RunInstances"]
  );
  assert.ok(!JSON.stringify(ec2.calls).includes("PRIVATE KEY"));
});

test("create: non-burstable instances get no credit specification", async () => {
  const ec2 = createFakeEc2();
  await create(ec2, basePlan({ instanceType: "m5.large" }));
  assert.equal(ec2.input("RunInstances").CreditSpecification, undefined);
});

test("partial failure at RunInstances: only this attempt's key pair and security group are removed", async () => {
  const ec2 = createFakeEc2({ overrides: { RunInstances: () => { throw awsError("InsufficientInstanceCapacity", "no capacity"); } } });
  seedNeighbours(ec2.world);
  const before = { i: ec2.world.instances.size, g: ec2.world.groups.size, k: ec2.world.keyPairs.size };

  const error = await create(ec2).catch((e) => e);
  assert.equal(error.code, "InsufficientInstanceCapacity");
  assert.deepEqual(error.created.map((c) => c.type), ["keyPair", "securityGroup"]);

  const cleanup = await cleanupPartial(ec2, ID, error.created, createClock());

  assert.deepEqual(cleanup.failed, []);
  assert.equal(cleanup.removed.length, 2);
  assert.deepEqual({ i: ec2.world.instances.size, g: ec2.world.groups.size, k: ec2.world.keyPairs.size }, before, "neighbours untouched");
  assert.ok(ec2.world.groups.has("sg-other") && ec2.world.groups.has("sg-unrelated"));
  assert.equal(ec2.count("TerminateInstances"), 0);
});

test("partial failure after the instance exists: it is terminated before its group is deleted", async () => {
  const ec2 = createFakeEc2({
    dependencyViolations: 2,
    overrides: {
      // Fail right after the instance was created (e.g. the response was lost).
      RunInstances: (input, world, original) => {
        const result = original();
        result.Instances.push({ InstanceId: "i-ghost" });
        world.instances.set("i-ghost", { InstanceId: "i-ghost", State: { Name: "running" }, polls: 0, Tags: [...world.instances.values()][0].Tags });
        return result;
      },
    },
  });

  const error = await create(ec2).catch((e) => e);
  assert.match(error.message, /Expected exactly one instance but AWS returned 2/);
  assert.deepEqual(error.created.map((c) => c.type), ["keyPair", "securityGroup", "instance", "instance"], "every returned instance is recorded");

  const cleanup = await cleanupPartial(ec2, ID, error.created, createClock());

  assert.deepEqual(cleanup.failed, []);
  assert.equal(ec2.world.groups.size, 0, "group removed after DependencyViolation retries");
  assert.equal(ec2.world.keyPairs.size, 0);
  assert.ok([...ec2.world.instances.values()].every((i) => i.State.Name === "terminated"));
  const names = ec2.names();
  assert.ok(names.lastIndexOf("TerminateInstances") < names.indexOf("DeleteSecurityGroup"));
});

test("partial failure at CreateSecurityGroup: only the key pair exists to remove", async () => {
  const ec2 = createFakeEc2({ overrides: { CreateSecurityGroup: () => { throw awsError("VpcLimitExceeded"); } } });
  const error = await create(ec2).catch((e) => e);
  assert.deepEqual(error.created.map((c) => c.type), ["keyPair"]);

  const cleanup = await cleanupPartial(ec2, ID, error.created, createClock());
  assert.deepEqual(cleanup.removed, [`key pair shipflow-${ID}`]);
  assert.equal(ec2.world.keyPairs.size, 0);
});

test("cleanup that cannot finish reports exactly what remains", async () => {
  const ec2 = createFakeEc2({
    overrides: {
      RunInstances: () => { throw awsError("InsufficientInstanceCapacity"); },
      DeleteSecurityGroup: () => { throw awsError("UnauthorizedOperation", "not allowed"); },
    },
  });
  const error = await create(ec2).catch((e) => e);
  const cleanup = await cleanupPartial(ec2, ID, error.created, createClock());

  assert.equal(cleanup.failed.length, 1);
  assert.match(cleanup.failed[0].what, /^security group sg-/);
  assert.deepEqual(cleanup.removed, [`key pair shipflow-${ID}`]);
});

// ----------------------------------------------------------------------- waits

test("waits: running with a public IP, status checks, bootstrap with host key", async () => {
  const ec2 = createFakeEc2({ runningAfter: 3, statusOkAfter: 2, consoleReadyAfter: 3 });
  const clock = createClock();
  const { instanceId } = await create(ec2);

  const instance = await waitForRunning(ec2, instanceId, clock);
  assert.equal(instance.PublicIpAddress, PUBLIC_IP);

  await waitForStatusOk(ec2, instanceId, clock);
  const boot = await waitForBootstrap(ec2, instanceId, ID, clock);
  assert.equal(boot.complete, true);
  assert.match(boot.hostKey, /^ssh-ed25519 /);
  assert.ok(ec2.count("GetConsoleOutput") >= 3);
});

test("waits time out with a useful message, and a terminated instance fails fast", async () => {
  const slow = createFakeEc2({ runningAfter: 10_000 });
  const { instanceId } = await create(slow);
  await assert.rejects(waitForRunning(slow, instanceId, createClock()), /Timed out after 300s waiting for the instance to start running/);

  const silent = createFakeEc2({ consoleText: "nothing useful" });
  const created = await create(silent);
  await assert.rejects(waitForBootstrap(silent, created.instanceId, ID, createClock()), /Timed out after 720s waiting for the VPS bootstrap/);

  const dead = createFakeEc2();
  const d = await create(dead);
  dead.world.instances.get(d.instanceId).State = { Name: "terminated" };
  await assert.rejects(waitForRunning(dead, d.instanceId, createClock()), /entered the "terminated" state/);
});

// -------------------------------------------------------------------- teardown

async function twoDeployments() {
  const ec2 = createFakeEc2();
  seedNeighbours(ec2.world);
  const created = await create(ec2);
  return { ec2, created, resources: { deploymentId: ID, instanceId: created.instanceId, securityGroupId: created.securityGroupId, keyPairName: created.keyPairName } };
}

test("destroy: removes only this deployment's instance, group and key pair", async () => {
  const { ec2, resources } = await twoDeployments();
  const result = await destroyResources(ec2, resources, createClock());

  assert.deepEqual(result.failed, []);
  assert.equal(result.removed.length, 3);
  assert.equal(ec2.world.instances.get(resources.instanceId).State.Name, "terminated");
  assert.equal(ec2.world.groups.has(resources.securityGroupId), false);
  assert.equal(ec2.world.keyPairs.has(resources.keyPairName), false);

  // Everything else survives, including another ShipFlow deployment.
  assert.equal(ec2.world.instances.get("i-other").State.Name, "running");
  assert.equal(ec2.world.instances.get("i-unrelated").State.Name, "running");
  for (const id of ["sg-other", "sg-unrelated"]) assert.ok(ec2.world.groups.has(id), id);
  for (const name of ["shipflow-sf-0000beef", "prod-key"]) assert.ok(ec2.world.keyPairs.has(name), name);

  const terminated = ec2.calls.filter((c) => c.name === "TerminateInstances").flatMap((c) => c.input.InstanceIds);
  assert.deepEqual(terminated, [resources.instanceId]);
  const deletedGroups = ec2.calls.filter((c) => c.name === "DeleteSecurityGroup").map((c) => c.input.GroupId);
  assert.deepEqual(deletedGroups, [resources.securityGroupId]);
});

test("destroy refuses an instance tagged for a different deployment, touching nothing", async () => {
  const { ec2, resources } = await twoDeployments();

  for (const target of ["i-other", "i-unrelated"]) {
    await assert.rejects(
      destroyResources(ec2, { ...resources, instanceId: target }, createClock()),
      /not tagged as ShipFlow deployment sf-0000abcd; refusing/,
      target
    );
  }

  assert.equal(ec2.count("TerminateInstances"), 0);
  assert.equal(ec2.count("DeleteSecurityGroup"), 0);
  assert.equal(ec2.count("DeleteKeyPair"), 0);
});

test("destroy leaves a security group or key pair that is not tagged for this deployment", async () => {
  const { ec2, resources } = await twoDeployments();
  const result = await destroyResources(ec2, { ...resources, securityGroupId: "sg-unrelated", keyPairName: "prod-key" }, createClock());

  assert.deepEqual(result.failed, []);
  assert.ok(result.skipped.some((s) => /sg-unrelated.*left untouched/.test(s)));
  assert.ok(result.skipped.some((s) => /prod-key.*left untouched/.test(s)));
  assert.ok(ec2.world.groups.has("sg-unrelated") && ec2.world.keyPairs.has("prod-key"));
  assert.equal(ec2.count("DeleteSecurityGroup"), 0);
  assert.equal(ec2.count("DeleteKeyPair"), 0);

  // A group that merely carries our tags but a foreign name is also left alone.
  ec2.world.groups.set("sg-spoof", { GroupId: "sg-spoof", GroupName: "prod-db", Tags: ec2.world.groups.get(resources.securityGroupId).Tags });
  const spoof = await destroyResources(ec2, { ...resources, securityGroupId: "sg-spoof" }, createClock());
  assert.ok(spoof.skipped.some((s) => /sg-spoof.*left untouched/.test(s)));
  assert.ok(ec2.world.groups.has("sg-spoof"));
});

test("destroy is idempotent: already-gone resources are skipped, not errors", async () => {
  const { ec2, resources } = await twoDeployments();
  await destroyResources(ec2, resources, createClock());

  const again = await destroyResources(ec2, resources, createClock());
  assert.deepEqual(again.failed, []);
  assert.equal(again.removed.length, 0);
  assert.equal(again.skipped.length, 3);
});

test("destroy keeps the security group and key pair while the instance may still exist", async () => {
  const ec2 = createFakeEc2({ terminateAfter: 1_000_000 });
  const created = await create(ec2);
  const resources = { deploymentId: ID, instanceId: created.instanceId, securityGroupId: created.securityGroupId, keyPairName: created.keyPairName };

  const result = await destroyResources(ec2, resources, { ...createClock(), timeouts: { timeoutMs: 1 } });

  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].what, /^instance i-/);
  assert.match(result.failed[0].error, /Timed out/);
  assert.ok(result.skipped.some((s) => /^security group .*instance still present/.test(s)));
  assert.ok(result.skipped.some((s) => /^key pair .*instance still present/.test(s)));
  assert.equal(ec2.world.groups.has(created.securityGroupId), true);
  assert.equal(ec2.world.keyPairs.has(created.keyPairName), true);
  assert.equal(ec2.count("DeleteSecurityGroup"), 0);
  assert.equal(ec2.count("DeleteKeyPair"), 0);
});

test("inspect reports ownership without changing anything", async () => {
  const { ec2, resources } = await twoDeployments();
  const before = ec2.calls.length;
  const report = await inspectDeployment(ec2, { id: ID, instanceId: resources.instanceId, securityGroupId: resources.securityGroupId, keyPairName: resources.keyPairName });

  assert.equal(report.instance.owned, true);
  assert.equal(report.securityGroup.owned, true);
  assert.equal(report.keyPair.owned, true);

  const foreign = await inspectDeployment(ec2, { id: ID, instanceId: "i-other", securityGroupId: "sg-unrelated", keyPairName: "prod-key" });
  assert.deepEqual([foreign.instance.owned, foreign.securityGroup.owned, foreign.keyPair.owned], [false, false, false]);

  const gone = await inspectDeployment(ec2, { id: ID, instanceId: "i-nope", securityGroupId: "sg-nope", keyPairName: "nope" });
  assert.deepEqual([gone.instance.exists, gone.securityGroup.exists, gone.keyPair.exists], [false, false, false]);

  assert.ok(ec2.calls.slice(before).every((c) => c.name.startsWith("Describe")));
});

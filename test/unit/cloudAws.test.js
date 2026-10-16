import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "stream";

import {
  AwsError,
  clientConfig,
  createApi,
  createAwsClients,
  isRootArn,
  redactSecrets,
  secretsOf,
  toAwsError,
  verifyIdentity,
} from "../../cli/lib/cloud/aws.js";
import { createResources } from "../../cli/lib/cloud/provision.js";
import { buildUserData } from "../../cli/lib/cloud/userData.js";
import { FAKE_CREDENTIALS, PUBLIC_KEY, awsError, createFakeSts } from "./helpers/cloudHarness.js";

const manual = { mode: "manual", ...FAKE_CREDENTIALS };

test("redaction removes secret values, access key IDs and credential-looking fields", () => {
  const text = `bad key ${FAKE_CREDENTIALS.accessKeyId} secret ${FAKE_CREDENTIALS.secretAccessKey} token ${FAKE_CREDENTIALS.sessionToken}; aws_secret_access_key=abc123def456 {"SessionToken": "xyz"}`;
  const redacted = redactSecrets(text, secretsOf(manual));

  for (const value of Object.values(FAKE_CREDENTIALS)) assert.doesNotMatch(redacted, new RegExp(value.replace(/[/+]/g, ".")));
  assert.doesNotMatch(redacted, /abc123def456|"xyz"/);
  assert.match(redacted, /\[REDACTED/);
});

test("client configuration: manual credentials only in memory-config; profile and default never carry keys", () => {
  assert.deepEqual(clientConfig("ap-south-1", manual), { region: "ap-south-1", credentials: FAKE_CREDENTIALS });
  assert.deepEqual(clientConfig("ap-south-1", { mode: "manual", accessKeyId: "AKIAX", secretAccessKey: "s" }).credentials, {
    accessKeyId: "AKIAX",
    secretAccessKey: "s",
  });
  assert.deepEqual(clientConfig("eu-west-1", { mode: "profile", profile: "work" }), { region: "eu-west-1", profile: "work" });
  assert.deepEqual(clientConfig("eu-west-1", { mode: "default" }), { region: "eu-west-1" });
});

test("SDK errors become actionable messages without credentials", () => {
  const leaky = (name, extra = "") =>
    Object.assign(new Error(`${extra} key=${FAKE_CREDENTIALS.accessKeyId} secret=${FAKE_CREDENTIALS.secretAccessKey}`), { name });
  const secrets = secretsOf(manual);

  const cases = {
    CredentialsProviderError: /No usable AWS credentials.*aws sso login/,
    TokenProviderError: /No usable AWS credentials/,
    InvalidClientTokenId: /rejected the credentials/,
    ExpiredToken: /session token has not expired|expired/,
    UnauthorizedOperation: /not permitted.*IAM permissions/,
    SomethingElse: /failed \(SomethingElse\)/,
  };

  for (const [name, pattern] of Object.entries(cases)) {
    const error = toAwsError(leaky(name), secrets, "RunInstances");
    assert.ok(error instanceof AwsError);
    assert.equal(error.code, name);
    assert.match(error.message, pattern, name);
    assert.doesNotMatch(error.message, /AKIAFAKE|FakeSecret|FQoGZXIv/, `${name} leaked a credential`);
  }

  assert.match(toAwsError(Object.assign(new Error("x"), { code: "ENOTFOUND" })).message, /Cannot reach AWS/);
});

test("createApi wraps failures, redacts them and rejects unknown operations", async () => {
  const client = { send: async () => { throw leakyError(); } };
  const api = createApi(client, { FooCommand: class { constructor(input) { this.input = input; } } }, { secrets: secretsOf(manual) });

  function leakyError() {
    return Object.assign(new Error(`denied for ${FAKE_CREDENTIALS.secretAccessKey}`), { name: "AccessDenied" });
  }

  await assert.rejects(api.call("Foo", {}), (error) => {
    assert.ok(error instanceof AwsError);
    assert.doesNotMatch(error.message, /FakeSecret/);
    return true;
  });
  await assert.rejects(api.call("Bar", {}), /Unknown AWS operation Bar/);
});

test("STS identity check", async () => {
  const sts = createFakeSts({ arn: "arn:aws:iam::123456789012:root" });
  const identity = await verifyIdentity(sts);

  assert.equal(identity.account, "123456789012");
  assert.equal(isRootArn(identity.arn), true);
  assert.equal(isRootArn("arn:aws:iam::123456789012:user/me"), false);

  await assert.rejects(verifyIdentity(createFakeSts({ error: awsError("InvalidClientTokenId") })), (e) => e.code === "InvalidClientTokenId");
});

// ---------------------------------------------------------------------------
// The real AWS SDK serializes our requests; only the network is stubbed.

const XML_NS = 'xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"';
const RESPONSES = {
  ImportKeyPair: `<ImportKeyPairResponse ${XML_NS}><requestId>r</requestId><keyFingerprint>f</keyFingerprint><keyName>k</keyName><keyPairId>key-1</keyPairId></ImportKeyPairResponse>`,
  CreateSecurityGroup: `<CreateSecurityGroupResponse ${XML_NS}><requestId>r</requestId><return>true</return><groupId>sg-1111</groupId></CreateSecurityGroupResponse>`,
  AuthorizeSecurityGroupIngress: `<AuthorizeSecurityGroupIngressResponse ${XML_NS}><requestId>r</requestId><return>true</return></AuthorizeSecurityGroupIngressResponse>`,
  RunInstances: `<RunInstancesResponse ${XML_NS}><requestId>r</requestId><reservationId>r-1</reservationId><ownerId>123456789012</ownerId><instancesSet><item><instanceId>i-2222</instanceId></item></instancesSet></RunInstancesResponse>`,
};

function parseBody(body) {
  const params = new URLSearchParams(body);
  return { get: (key) => params.get(key), entries: [...params.entries()], action: params.get("Action") };
}

test("real SDK serialization: restricted SSH, public HTTP, public IP, volume, tags, IMDSv2, user-data", async () => {
  const sdk = { ec2: await import("@aws-sdk/client-ec2"), sts: await import("@aws-sdk/client-sts") };
  const captured = [];
  const client = new sdk.ec2.EC2Client({
    region: "ap-south-1",
    credentials: FAKE_CREDENTIALS,
    maxAttempts: 1,
    requestHandler: {
      async handle(request) {
        const action = new URLSearchParams(request.body).get("Action");
        captured.push({ request, body: parseBody(request.body) });
        return {
          response: {
            statusCode: 200,
            reason: "OK",
            headers: { "content-type": "text/xml;charset=UTF-8" },
            body: Readable.from([Buffer.from(RESPONSES[action])]),
          },
        };
      },
      destroy() {},
      updateHttpClientConfig() {},
      httpHandlerConfigs: () => ({}),
    },
  });

  const ec2 = createApi(client, sdk.ec2, { secrets: secretsOf(manual) });
  const plan = {
    deploymentId: "sf-0000abcd",
    project: "portfolio",
    instanceType: "t3.micro",
    diskGiB: 8,
    sshCidr: "198.51.100.7/32",
    vpcId: "vpc-1",
    subnetId: "subnet-1",
    image: { imageId: "ami-123", rootDeviceName: "/dev/xvda" },
  };
  const userData = buildUserData({ project: plan.project, deploymentId: plan.deploymentId, publicKey: PUBLIC_KEY });

  const created = await createResources(ec2, plan, { publicKey: PUBLIC_KEY, userData });

  assert.deepEqual(captured.map((c) => c.body.action), ["ImportKeyPair", "CreateSecurityGroup", "AuthorizeSecurityGroupIngress", "RunInstances"]);
  assert.deepEqual(
    created.created.map((c) => c.type),
    ["keyPair", "securityGroup", "instance"]
  );

  const get = (action) => captured.find((c) => c.body.action === action).body;

  // Only the public key reaches AWS, base64-encoded.
  const key = get("ImportKeyPair");
  assert.equal(Buffer.from(key.get("PublicKeyMaterial"), "base64").toString(), PUBLIC_KEY);
  assert.equal(key.get("TagSpecification.1.ResourceType"), "key-pair");

  // Firewall: SSH from exactly one CIDR, HTTP from anywhere, nothing else.
  const ingress = get("AuthorizeSecurityGroupIngress");
  const ports = ingress.entries.filter(([k]) => /^IpPermissions\.\d+\.FromPort$/.test(k));
  assert.deepEqual(ports.map(([, v]) => v), ["22", "80"]);
  assert.equal(ingress.get("IpPermissions.1.IpRanges.1.CidrIp"), "198.51.100.7/32");
  assert.equal(ingress.get("IpPermissions.2.IpRanges.1.CidrIp"), "0.0.0.0/0");
  assert.equal(ingress.entries.filter(([k]) => /CidrIp$/.test(k)).length, 2);
  assert.equal(ingress.entries.filter(([k]) => /CidrIpv6$/.test(k)).length, 0);

  const run = get("RunInstances");
  assert.equal(run.get("ImageId"), "ami-123");
  assert.equal(run.get("InstanceType"), "t3.micro");
  assert.equal(run.get("MinCount"), "1");
  assert.equal(run.get("MaxCount"), "1");
  assert.equal(run.get("KeyName"), "shipflow-sf-0000abcd");
  assert.equal(run.get("ClientToken"), "sf-0000abcd");
  assert.equal(run.get("NetworkInterface.1.AssociatePublicIpAddress"), "true");
  assert.equal(run.get("NetworkInterface.1.SecurityGroupId.1"), "sg-1111");
  assert.equal(run.get("NetworkInterface.1.SubnetId"), "subnet-1");
  assert.equal(run.get("BlockDeviceMapping.1.DeviceName"), "/dev/xvda");
  assert.equal(run.get("BlockDeviceMapping.1.Ebs.VolumeSize"), "8");
  assert.equal(run.get("BlockDeviceMapping.1.Ebs.VolumeType"), "gp3");
  assert.equal(run.get("BlockDeviceMapping.1.Ebs.DeleteOnTermination"), "true");
  assert.equal(run.get("MetadataOptions.HttpTokens"), "required");
  assert.equal(run.get("CreditSpecification.CpuCredits"), "standard");

  const tagTypes = run.entries.filter(([k]) => /^TagSpecification\.\d+\.ResourceType$/.test(k)).map(([, v]) => v);
  assert.deepEqual(tagTypes, ["instance", "volume", "network-interface"]);
  assert.ok(run.entries.some(([k, v]) => /Tag\.\d+\.Key$/.test(k) && v === "ManagedBy"));
  assert.ok(run.entries.some(([k, v]) => /Tag\.\d+\.Value$/.test(k) && v === "ShipFlow"));
  assert.ok(run.entries.some(([k, v]) => /Tag\.\d+\.Value$/.test(k) && v === "sf-0000abcd"));

  // User-data: base64 script with the PUBLIC key and no private material.
  const script = Buffer.from(run.get("UserData"), "base64").toString();
  assert.match(script, /useradd/);
  assert.ok(script.includes(PUBLIC_KEY));
  assert.doesNotMatch(script, /PRIVATE KEY/);

  // No credentials in any request body (they only sign the headers).
  for (const { body } of captured) {
    const text = body.entries.map(([k, v]) => `${k}=${v}`).join("&");
    assert.doesNotMatch(text, /AKIAFAKE|FakeSecret|FQoGZXIv/);
  }

  // createAwsClients builds real clients without touching the network.
  const clients = createAwsClients({ sdk, region: "ap-south-1", auth: manual });
  assert.equal(typeof clients.ec2.call, "function");
  assert.equal(typeof clients.sts.call, "function");
});

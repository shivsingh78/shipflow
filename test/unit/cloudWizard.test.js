// The `cloud deploy` wizard end to end against a stateful fake EC2/STS, fake
// ShipFlow API and scripted prompts. No test here can reach AWS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";

import { CloudError, UsageError } from "../../cli/dist/lib/errors.js";
import { requiredSecrets, validateProjectConfig } from "../../cli/dist/lib/projectConfig.js";
import { sshTarget } from "../../dist/src/targets/ssh.js";
import { hostKeyFingerprint } from "../../cli/dist/lib/cloud/keys.js";
import { formatReview, runCloudDeploy } from "../../cli/dist/lib/cloud/wizard.js";
import { estimateCost } from "../../cli/dist/lib/cloud/pricing.js";
import {
  FAKE_CREDENTIALS,
  HAPPY_ANSWERS,
  HOST_KEY,
  PRIVATE_KEY_TEXT,
  PUBLIC_IP,
  awsError,
  createFakeDeps,
  createFakeEc2,
  createFakeIo,
  createFakeSts,
  fakeEd25519,
  readTree,
  seedNeighbours,
} from "./helpers/cloudHarness.js";

async function runDeploy({ answers = {}, flags = {}, harness = {} } = {}) {
  const h = await createFakeDeps(harness);
  const io = createFakeIo({ answers: { ...HAPPY_ANSWERS, ...answers } });
  let result;
  let error;

  try {
    result = await runCloudDeploy({ flags, deps: h.deps, io });
  } catch (e) {
    error = e;
  }

  return { h, io, result, error };
}

const CREATE_CALLS = ["ImportKeyPair", "CreateSecurityGroup", "AuthorizeSecurityGroupIngress", "RunInstances"];
const createdAnything = (h) => CREATE_CALLS.some((name) => h.ec2.count(name) > 0);
const keyDirsGone = (h) => h.keyDirs.every((dir) => !fs.existsSync(dir));

// ------------------------------------------------------------------ the happy path

test("happy path: validated, reviewed, confirmed, provisioned, registered and deployed through the existing pipeline", async () => {
  const log = [];
  const sawReviewBeforeCreate = [];
  const ec2 = createFakeEc2({ log });
  const { h, io, result, error } = await runDeploy({
    harness: { log, ec2 },
    answers: {
      "Type CREATE": (_question) => {
        // Nothing may exist yet when the confirmation is requested.
        sawReviewBeforeCreate.push(CREATE_CALLS.map((name) => ec2.count(name)));
        return "CREATE";
      },
    },
  });

  assert.equal(error, undefined, error?.message);
  assert.equal(result, 0);
  assert.deepEqual(sawReviewBeforeCreate, [[0, 0, 0, 0]]);

  // Credentials are proved with STS before anything else, and before any create.
  assert.equal(log.indexOf("sts:GetCallerIdentity") < log.indexOf("ec2:ImportKeyPair"), true);
  assert.ok(log.indexOf("api:whoami") < log.indexOf("sts:GetCallerIdentity"), "the ShipFlow server is checked first");

  // Strict ordering of the workflow.
  const order = ["ec2:ImportKeyPair", "ec2:CreateSecurityGroup", "ec2:RunInstances", "ec2:GetConsoleOutput", "api:putProject", "api:setSecret", "api:checkProjectTarget", "api:createRelease"];
  const positions = order.map((name) => log.indexOf(name));
  assert.ok(positions.every((p) => p >= 0), `missing step in ${log.join(",")}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "steps ran out of order");

  // Existing project API and SSH target are reused.
  const [name, config] = h.apiCalls.find((c) => c.name === "putProject").args;
  assert.equal(name, "portfolio");
  assert.equal(config.project.name, "portfolio");
  assert.equal(config.project.repository, "https://github.com/octocat/hello-world");
  assert.equal(config.project.branch, "main");
  assert.equal(config.deployment.target, "ssh");
  assert.deepEqual(config.deployment.ssh, {
    host: PUBLIC_IP,
    port: 22,
    user: "shipflow-deploy",
    path: "/srv/shipflow/portfolio",
    hostKey: HOST_KEY,
    privateKeySecret: "SSH_PRIVATE_KEY",
    url: `http://${PUBLIC_IP}/`,
  });
  const normalized = validateProjectConfig(JSON.parse(JSON.stringify(config)));
  assert.ok(normalized, "config passes the existing schema");

  // ...and is exactly what the existing SSH adapter consumes: no new deployment path.
  assert.deepEqual(sshTarget.requiredSecrets(normalized.deployment.ssh), ["SSH_PRIVATE_KEY"]);
  assert.deepEqual(requiredSecrets(normalized), ["SSH_PRIVATE_KEY"]);
  assert.equal(sshTarget.liveUrl({ targetConfig: normalized.deployment.ssh }), `http://${PUBLIC_IP}/`);
  assert.deepEqual(sshTarget.capabilities, { artifactTypes: ["static"], candidateVerification: "checksum", atomicActivation: true, rollback: true });

  // The private key goes only to the encrypted secret API.
  const [project, secretName, secretValue] = h.apiCalls.find((c) => c.name === "setSecret").args;
  assert.deepEqual([project, secretName, secretValue], ["portfolio", "SSH_PRIVATE_KEY", PRIVATE_KEY_TEXT]);
  assert.deepEqual(h.apiCalls.find((c) => c.name === "createRelease").args, [{ project: "portfolio", ref: "main" }]);

  // Temporary key material is gone; the config file has no secrets.
  assert.ok(h.keyDirs.length === 1 && keyDirsGone(h));
  const written = fs.readFileSync(path.join(h.cwd, "shipflow.yml"), "utf8");
  assert.match(written, /target: ssh/);
  assert.ok(written.includes(HOST_KEY));
  assert.doesNotMatch(written, /PRIVATE KEY|FAKEPRIVATE/);

  // Non-secret metadata is recorded for status/destroy.
  const [meta] = h.store.list();
  assert.equal(meta.state, "deployed");
  assert.equal(meta.region, "ap-south-1");
  assert.equal(meta.project, "portfolio");
  assert.equal(meta.releaseId, "Rel00001");
  assert.match(meta.instanceId, /^i-/);
  assert.match(meta.securityGroupId, /^sg-/);
  assert.match(meta.keyPairName, /^shipflow-sf-/);
  assert.equal(meta.sshCidr, "198.51.100.7/32");
  assert.equal(meta.publicIp, PUBLIC_IP);

  // The summary and cleanup instructions.
  const text = io.text();
  assert.match(text, /Release:\s+Rel00001 \(SUCCESS/);
  assert.match(text, new RegExp(`Instance:\\s+${meta.instanceId}`));
  assert.match(text, new RegExp(`Public IP:\\s+${PUBLIC_IP.replace(/\./g, "\\.")}`));
  assert.match(text, /Site URL:\s+http:\/\/203\.0\.113\.50\//);
  assert.match(text, new RegExp(`shipflow cloud destroy --id ${meta.id}`));
  assert.match(text, /AWS credits do not cap spending/);
  assert.match(text, /API and worker must stay reachable/);

  assert.equal(h.cleanups.size, 0, "the interrupt cleanup was unregistered");
  assert.equal(h.ec2.count("TerminateInstances"), 0);
});

test("the SSH ingress uses the confirmed worker CIDR, never the whole internet, and HTTP is the only public port", async () => {
  const { h } = await runDeploy();
  const [group] = [...h.ec2.world.groups.values()];

  assert.deepEqual(group.rules.map((r) => [r.FromPort, r.IpRanges[0].CidrIp]), [[22, "198.51.100.7/32"], [80, "0.0.0.0/0"]]);
});

test("the review screen shows what will be created, the estimate and the warnings", async () => {
  const { io } = await runDeploy();
  const review = io.text();

  for (const expected of [
    "Review: nothing has been created yet",
    "ap-south-1",
    "1 × t3.micro, Amazon Linux 2023 x86_64 (ami-new",
    "8 GiB gp3, deleted when the instance is terminated",
    "Public IPv4:   yes, auto-assigned",
    "SSH (22):      only from 198.51.100.7/32",
    "HTTP (80):     open to the internet",
    "1 EC2 instance, 1 security group, 1 key pair (public key only)",
    "Will NOT create: Elastic IP, NAT gateway, load balancer",
    "NOT a billing guarantee",
    "price data checked 2026-10-15",
    "UNVERIFIED assumption",
    "AWS credits and free-tier offers may not cover every charge",
    "Charges accrue every hour",
  ]) {
    assert.ok(review.includes(expected), `review is missing: ${expected}`);
  }

  const lines = formatReview(
    { region: "eu-west-1", instanceType: "c5.large", diskGiB: 8, image: { imageId: "a", name: "b" }, sshCidr: "1.2.3.4/32", repository: "r", branch: "b", output: "auto", project: "p", configFile: "f", deploymentId: "d", vpcId: "v", subnetId: "s", availabilityZone: "z" },
    estimateCost({ region: "eu-west-1", instanceType: "c5.large", diskGiB: 8 }),
    { identity: { account: "1" } }
  ).join("\n");
  assert.match(lines, /No built-in price table for eu-west-1/, "no invented prices for unknown regions");
});

// ------------------------------------------------------------------ the gate

test("nothing is created unless CREATE is typed exactly", async () => {
  for (const typed of ["", "create", "Create", "yes", "y", "CREATE ME", "DESTROY"]) {
    const { h, io, error } = await runDeploy({ answers: { "Type CREATE": typed } });

    assert.ok(error instanceof CloudError, `"${typed}" should cancel`);
    assert.match(error.message, /Cancelled\. Nothing was created/);
    assert.equal(createdAnything(h), false, `"${typed}" created resources`);
    assert.equal(h.keyDirs.length, 0, "no key was even generated");
    assert.deepEqual(h.store.list(), []);
    assert.equal(h.apiCalls.some((c) => ["putProject", "setSecret", "createRelease"].includes(c.name)), false);
    assert.ok(io.text().includes("Review: nothing has been created yet"));
  }
});

// ---------------------------------------------------------------- credentials

test("failed STS authentication stops everything, with exit code 3 and no credential in the message", async () => {
  const leaky = awsError("InvalidClientTokenId", `The security token included in the request is invalid ${FAKE_CREDENTIALS.accessKeyId}`);
  const { h, io, error } = await runDeploy({
    harness: { sts: createFakeSts({ error: leaky }) },
    answers: {
      "How should ShipFlow authenticate": "manual",
      "AWS Access Key ID": FAKE_CREDENTIALS.accessKeyId,
      "AWS Secret Access Key": FAKE_CREDENTIALS.secretAccessKey,
      "Session token": "",
    },
  });

  assert.ok(error instanceof CloudError);
  assert.equal(error.exitCode, 3);
  assert.match(error.message, /InvalidClientTokenId/);
  assert.match(error.hint, /access key, secret/);
  assert.equal(h.ec2.calls.length, 0, "no EC2 call was made");
  assert.equal(h.apiCalls.some((c) => c.name === "putProject"), false);
  for (const text of [error.message, error.hint, io.text()]) {
    assert.doesNotMatch(text, /AKIAFAKE|FakeSecret/);
  }
});

test("profile and SSO failures point at `aws sso login`", async () => {
  const { error } = await runDeploy({
    harness: { sts: createFakeSts({ error: Object.assign(new Error("Token is expired"), { name: "TokenProviderError" }) }) },
    answers: { "AWS profile name": "work-sso" },
  });

  assert.equal(error.exitCode, 3);
  assert.match(error.message, /No usable AWS credentials/);
  assert.match(error.hint, /aws sso login --profile/);
});

test("named profile is passed to the SDK layer, not the keys", async () => {
  const { h, error } = await runDeploy({ answers: { "AWS profile name": "work-sso" } });
  assert.equal(error, undefined);
  assert.deepEqual(h.auths[0], { mode: "profile", profile: "work-sso" });
});

test("manual credentials (with a session token) reach the AWS clients and are never persisted, printed or logged anywhere", async () => {
  const before = { ...process.env };
  const { h, io, error } = await runDeploy({
    answers: {
      "How should ShipFlow authenticate": "manual",
      "AWS Access Key ID": FAKE_CREDENTIALS.accessKeyId,
      "AWS Secret Access Key": FAKE_CREDENTIALS.secretAccessKey,
      "Session token": FAKE_CREDENTIALS.sessionToken,
    },
  });

  assert.equal(error, undefined, error?.message);

  // They did reach the (fake) SDK client builder, in memory.
  assert.equal(h.auths[0].mode, "manual");
  assert.equal(h.auths[0].secretAccessKey, FAKE_CREDENTIALS.secretAccessKey);
  assert.equal(h.auths[0].sessionToken, FAKE_CREDENTIALS.sessionToken);

  const needles = Object.values(FAKE_CREDENTIALS);
  const surfaces = {
    "terminal output": io.text(),
    "prompts": io.prompts.join("\n"),
    "ShipFlow API calls": JSON.stringify(h.apiCalls.map((c) => c.args)).replace(PRIVATE_KEY_TEXT.replace(/\n/g, "\\n"), ""),
    "AWS API inputs": JSON.stringify(h.ec2.calls),
    "STS calls": JSON.stringify(h.sts.calls),
    ...Object.fromEntries(readTree(h.root).map(({ file, text }) => [`file ${path.relative(h.root, file)}`, text])),
  };

  for (const [where, text] of Object.entries(surfaces)) {
    for (const needle of needles) assert.ok(!text.includes(needle), `credential found in ${where}`);
  }

  // Not in the environment either.
  assert.deepEqual(process.env.AWS_ACCESS_KEY_ID, before.AWS_ACCESS_KEY_ID);
  assert.equal(process.env.AWS_SECRET_ACCESS_KEY, before.AWS_SECRET_ACCESS_KEY);
  assert.equal(process.env.AWS_SESSION_TOKEN, before.AWS_SESSION_TOKEN);
  assert.ok(!JSON.stringify(process.env).includes(FAKE_CREDENTIALS.secretAccessKey));

  assert.match(io.text(), /Do not use root access keys/);
  assert.match(io.text(), /AKIA… keys are long-lived/);
});

test("manual credentials are validated without echoing what was typed", async () => {
  const manual = (extra) => ({
    "How should ShipFlow authenticate": "manual",
    "AWS Access Key ID": FAKE_CREDENTIALS.accessKeyId,
    "AWS Secret Access Key": FAKE_CREDENTIALS.secretAccessKey,
    "Session token": "",
    ...extra,
  });

  const shortSecret = await runDeploy({ answers: manual({ "AWS Secret Access Key": "tooshort-secret" }) });
  assert.ok(shortSecret.error instanceof UsageError);
  assert.doesNotMatch(shortSecret.error.message, /tooshort/);
  assert.equal(shortSecret.h.ec2.calls.length, 0);

  const temporaryWithoutToken = await runDeploy({ answers: manual({ "AWS Access Key ID": "ASIAFAKEFAKEFAKE1234" }) });
  assert.ok(temporaryWithoutToken.error instanceof UsageError);
  assert.match(temporaryWithoutToken.error.message, /need their session token/);

  const badId = await runDeploy({ answers: manual({ "AWS Access Key ID": "not-a-key" }) });
  assert.match(badId.error.message, /does not look like an access key ID/);
  assert.equal(badId.h.authCalls.length, 0);
});

test("root credentials are refused unless explicitly accepted", async () => {
  const root = createFakeSts({ arn: "arn:aws:iam::123456789012:root" });

  const refused = await runDeploy({ harness: { sts: root } });
  assert.ok(refused.error instanceof CloudError);
  assert.match(refused.error.message, /refusing to continue with root credentials/);
  assert.equal(createdAnything(refused.h), false);
  assert.match(refused.io.text(), /ROOT account credentials/);

  const accepted = await runDeploy({ harness: { sts: createFakeSts({ arn: "arn:aws:iam::123456789012:root" }) }, answers: { "Continue with root": "yes" } });
  assert.equal(accepted.error, undefined);
});

// --------------------------------------------------------------------- inputs

test("invalid inputs given as flags fail before any AWS call, naming the flag", async () => {
  const bad = {
    region: "mars-1",
    name: "Bad Name!",
    repo: "http://github.com/a/b",
    branch: "../x",
    output: "/etc",
    "instance-type": "huge",
    "disk-size": "1000",
    "ssh-cidr": "0.0.0.0/0",
  };

  for (const [flag, value] of Object.entries(bad)) {
    const { h, error } = await runDeploy({ flags: { [flag]: value } });
    assert.ok(error instanceof UsageError, `--${flag}=${value} should be rejected (got ${error})`);
    assert.match(error.message, flag === "ssh-cidr" ? /whole internet/ : new RegExp(`--${flag}`), flag);
    assert.equal(createdAnything(h), false, flag);
  }
});

test("interactive answers go through the same validators", async () => {
  const cases = [
    ["AWS region", "atlantis", /standard AWS region/],
    ["Git repository", "https://user:tok@github.com/a/b", /must not contain credentials/],
    ["Public egress IP", "10.0.0.5", /private, loopback/],
    ["Root disk size", "9000", /between 8 and 100/],
  ];

  for (const [key, value, pattern] of cases) {
    const answers = { [key]: value };
    if (key === "Public egress IP") answers["Allow SSH from"] = "no";
    const { h, error } = await runDeploy({ answers });

    assert.ok(error, `${key}=${value} should fail`);
    if (pattern) assert.match(error.message, pattern);
    assert.equal(createdAnything(h), false);
  }

  // A repository outside the server's allowlist is rejected with the allowed prefixes.
  const outside = await runDeploy({ answers: { "Git repository": "https://gitlab.com/a/b" } });
  assert.match(outside.error.message, /only deploys repositories under: https:\/\/github.com\//);
});

test("the SSH source is never assumed: a detected IP needs confirmation, otherwise it is asked for", async () => {
  // Declined: the user types the worker's CIDR instead.
  const declined = await runDeploy({ answers: { "Allow SSH from": "no", "Public egress IP": "203.0.113.0/24" } });
  assert.equal(declined.error, undefined);
  assert.equal([...declined.h.ec2.world.groups.values()][0].rules[0].IpRanges[0].CidrIp, "203.0.113.0/24");
  assert.match(declined.io.text(), /only correct if your ShipFlow worker's outbound traffic leaves through the same address/);

  // The confirmation defaults to "no".
  const defaulted = await runDeploy({ answers: { "Allow SSH from": undefined, "Public egress IP": "203.0.113.9" } });
  assert.equal([...defaulted.h.ec2.world.groups.values()][0].rules[0].IpRanges[0].CidrIp, "203.0.113.9/32");
  assert.ok(defaulted.io.prompts.some((p) => p.includes("Public egress IP")));

  // No detection possible: still asked.
  const undetected = await runDeploy({ harness: { publicIp: null }, answers: { "Public egress IP": "203.0.113.20" } });
  assert.equal([...undetected.h.ec2.world.groups.values()][0].rules[0].IpRanges[0].CidrIp, "203.0.113.20/32");

  // A host-bits CIDR is normalized and the user is told.
  const adjusted = await runDeploy({ answers: { "Allow SSH from": "no", "Public egress IP": "203.0.113.77/24" } });
  assert.equal([...adjusted.h.ec2.world.groups.values()][0].rules[0].IpRanges[0].CidrIp, "203.0.113.0/24");
  assert.match(adjusted.io.text(), /Using 203\.0\.113\.0\/24/);
});

// ------------------------------------------------- repository and server checks

test("private or unreadable repositories stop the wizard before AWS is used", async () => {
  const { h, error } = await runDeploy({ harness: { repoStatus: "unreadable" } });

  assert.ok(error instanceof CloudError);
  assert.equal(error.exitCode, 2);
  assert.match(error.message, /Cannot read https:\/\/github.com\/octocat\/hello-world without credentials/);
  assert.match(error.hint, /private repositories are not supported yet/);
  assert.match(error.hint, /token must never be placed in the URL/);
  assert.equal(h.ec2.calls.length, 0);
});

test("a missing branch is reported; an inconclusive check only warns", async () => {
  const missing = await runDeploy({ harness: { repoStatus: "no-branch" } });
  assert.ok(missing.error instanceof UsageError);
  assert.match(missing.error.message, /Branch "main" does not exist/);

  const skipped = await runDeploy({ harness: { repoStatus: "skipped" } });
  assert.equal(skipped.error, undefined);
  assert.match(skipped.io.text(), /Could not check the repository from this machine/);
});

test("the ShipFlow server must support the ssh target and store secrets, checked before AWS", async () => {
  const noSecrets = await runDeploy({ harness: { apiOverrides: { whoami: async () => ({ secretsEnabled: false, targets: [{ name: "ssh" }], instance: "x" }) } } });
  assert.match(noSecrets.error.message, /no SHIPFLOW_SECRETS_KEY/);
  assert.equal(noSecrets.h.authCalls.length, 0);

  const noSsh = await runDeploy({ harness: { apiOverrides: { whoami: async () => ({ secretsEnabled: true, targets: [{ name: "shipflow" }], instance: "x" }) } } });
  assert.match(noSsh.error.message, /does not support the ssh deployment target/);
  assert.equal(noSsh.h.ec2.calls.length, 0);

  const unreachable = await runDeploy({ harness: { apiOverrides: { whoami: async () => { throw Object.assign(new Error("Cannot reach ShipFlow API"), { status: 0 }); } } } });
  assert.match(unreachable.error.message, /Cannot reach ShipFlow API/);
  assert.equal(unreachable.h.authCalls.length, 0);
});

test("project names and config files never collide or get overwritten", async () => {
  const taken = await runDeploy({ harness: { apiOverrides: { listProjects: async () => ({ projects: [{ name: "portfolio" }] }) } } });
  assert.equal(taken.error, undefined);
  const [name, config] = taken.h.apiCalls.find((c) => c.name === "putProject").args;
  assert.match(name, /^portfolio-[0-9a-f]{4}$/);
  assert.equal(config.deployment.ssh.path, `/srv/shipflow/${name}`);
  assert.match(taken.io.text(), /Project name "portfolio" is taken/);

  const existing = await runDeploy({ harness: { existingFiles: ["shipflow.yml"] } });
  assert.equal(existing.error, undefined);
  assert.equal(fs.readFileSync(path.join(existing.h.cwd, "shipflow.yml"), "utf8"), "# existing\n", "untouched");
  assert.ok(fs.existsSync(path.join(existing.h.cwd, "shipflow.portfolio.yml")));
  assert.match(existing.io.text(), /will not be modified; writing shipflow\.portfolio\.yml/);

  const explicit = await runDeploy({ harness: { existingFiles: ["mine.yml"] }, flags: { "config-file": "mine.yml" } });
  assert.ok(explicit.error instanceof UsageError);
  assert.match(explicit.error.message, /will not be overwritten/);
  assert.equal(createdAnything(explicit.h), false);

  const nameLocal = await runDeploy({ harness: { existingFiles: ["shipflow.yml"] }, flags: { name: "other" }, answers: {} });
  assert.equal(nameLocal.error, undefined);
});

// ------------------------------------------------------------ provisioning errors

test("provisioning failure cleans up exactly what this attempt created and leaves neighbours alone", async () => {
  const ec2 = createFakeEc2({ overrides: { RunInstances: () => { throw awsError("InsufficientInstanceCapacity", "no capacity"); } } });
  seedNeighbours(ec2.world);
  const neighbours = { i: ec2.world.instances.size, g: ec2.world.groups.size, k: ec2.world.keyPairs.size };
  const { h, io, error } = await runDeploy({ harness: { ec2 } });

  assert.ok(error instanceof CloudError);
  assert.match(error.message, /RunInstances failed \(InsufficientInstanceCapacity\)|InsufficientInstanceCapacity/);
  assert.deepEqual({ i: ec2.world.instances.size, g: ec2.world.groups.size, k: ec2.world.keyPairs.size }, neighbours);
  assert.equal(ec2.count("TerminateInstances"), 0);
  assert.match(io.text(), /Everything this attempt created has been removed/);
  assert.equal(h.store.list()[0].state, "failed-cleaned");
  assert.ok(keyDirsGone(h));
  assert.equal(h.apiCalls.some((c) => c.name === "putProject"), false, "nothing was registered");
});

test("when cleanup itself fails, the remaining resources are named and the state records it", async () => {
  const ec2 = createFakeEc2({
    overrides: {
      RunInstances: () => { throw awsError("InsufficientInstanceCapacity"); },
      DeleteSecurityGroup: () => { throw awsError("UnauthorizedOperation", "not allowed"); },
    },
  });
  const { h, io, error } = await runDeploy({ harness: { ec2 } });

  assert.ok(error);
  assert.equal(h.store.list()[0].state, "failed-partial");
  assert.match(io.text(), /could NOT remove security group sg-/);
  assert.match(io.text(), /shipflow cloud destroy --id sf-/);
});

// -------------------------------------------------- failures after the VM exists

const afterVm = async (extra) => {
  const log = [];
  const result = await runDeploy({ harness: { log, ec2: createFakeEc2({ log }), ...extra.harness }, answers: extra.answers, flags: extra.flags });
  return result;
};

test("an untrusted host key stops the wizard; the VM can be kept", async () => {
  const { h, io, error } = await afterVm({ answers: { "Pin this host key": "no", "What now?": "keep" } });

  assert.match(error.message, /host key was not trusted/);
  const [meta] = h.store.list();
  assert.equal(meta.state, "running");
  assert.equal(h.ec2.world.instances.get(meta.instanceId).State.Name, "running", "kept, not terminated");
  assert.equal(h.ec2.count("TerminateInstances"), 0);
  assert.equal(h.apiCalls.some((c) => c.name === "putProject"), false);
  assert.ok(keyDirsGone(h), "the private key is gone");
  assert.match(io.text(), /still exists and is billed/);
  assert.match(io.text(), new RegExp(`shipflow cloud destroy --id ${meta.id}`));

  // The fingerprint and the trust-on-first-use caveat were shown before the question.
  assert.ok(io.text().includes(hostKeyFingerprint(HOST_KEY)));
  assert.match(io.text(), /Trust on first use/);
  assert.match(io.text(), /read through the authenticated AWS API/);
  assert.equal(io.prompts.some((p) => p.includes("Pin this host key")), true);
});

test("choosing cleanup after a failure runs the controlled destroy, which still needs DESTROY", async () => {
  const wrong = await afterVm({ answers: { "Pin this host key": "no", "What now?": "destroy", "Type DESTROY": "destroy" } });
  const [kept] = wrong.h.store.list();
  assert.equal(wrong.h.ec2.world.instances.get(kept.instanceId).State.Name, "running", "a wrong confirmation destroys nothing");
  assert.match(wrong.io.text(), /Cleanup did not finish: Cancelled\. Nothing was destroyed/);

  const right = await afterVm({ answers: { "Pin this host key": "no", "What now?": "destroy", "Type DESTROY": "DESTROY" } });
  const [meta] = right.h.store.list();
  assert.equal(meta.state, "destroyed");
  assert.equal(right.h.ec2.world.instances.get(meta.instanceId).State.Name, "terminated");
  assert.equal(right.h.ec2.world.groups.size, 0);
  assert.equal(right.h.ec2.world.keyPairs.size, 0);
});

test("a failed release leaves the VM for debugging by default and keeps the original error", async () => {
  const { h, error } = await afterVm({
    harness: { releaseResult: { release_id: "Rel00001", status: "FAILED", current_stage: "BUILD", error_message: "Build failed with exit code 1" } },
    answers: { "What now?": "keep" },
  });

  assert.ok(error instanceof CloudError);
  assert.match(error.message, /Release Rel00001 FAILED at BUILD: Build failed with exit code 1 \(shipflow logs Rel00001\)/);
  const [meta] = h.store.list();
  assert.equal(meta.state, "running", "not marked deployed");
  assert.equal(h.ec2.world.instances.get(meta.instanceId).State.Name, "running");
  assert.ok(keyDirsGone(h));
  assert.equal(h.apiCalls.filter((c) => c.name === "setSecret").length, 1, "the key had already been registered");
});

test("a release that times out exits with code 4", async () => {
  const { error } = await afterVm({ harness: { apiOverrides: {} }, answers: { "What now?": "keep" } , flags: {} }).then(async () => {
    const h = await createFakeDeps();
    h.deps.followRelease = async () => null;
    const io = createFakeIo({ answers: { ...HAPPY_ANSWERS, "What now?": "keep" } });
    return runCloudDeploy({ flags: {}, deps: h.deps, io }).then(() => ({}), (e) => ({ error: e }));
  });

  assert.equal(error.exitCode, 4);
  assert.match(error.message, /Timed out waiting for release/);
});

test("the worker must be able to SSH to the VPS before a release starts; the hint names the CIDR", async () => {
  const { h, error } = await afterVm({
    harness: { apiOverrides: { checkProjectTarget: async () => ({ checks: [{ name: "ssh connection", ok: false, detail: "Cannot connect to 203.0.113.50:22" }] }) } },
    answers: { "What now?": "keep" },
  });

  assert.match(error.message, /worker cannot use the VPS yet \(ssh connection: Cannot connect to 203\.0\.113\.50:22\)/);
  assert.match(error.hint, /198\.51\.100\.7\/32/);
  assert.equal(h.apiCalls.some((c) => c.name === "createRelease"), false);
  assert.ok(keyDirsGone(h));
});

test("the private key is removed even when registering it fails", async () => {
  const { h, error } = await afterVm({
    harness: { apiOverrides: { setSecret: async () => { throw Object.assign(new Error("server unavailable"), { status: 503 }); } } },
    answers: { "What now?": "keep" },
  });

  assert.match(error.message, /server unavailable/);
  assert.ok(h.keyDirs.length === 1 && keyDirsGone(h));
  assert.equal(h.cleanups.size, 0);
});

test("if the console is silent the host key can be pasted; without one the wizard stops", async () => {
  const silent = () => createFakeEc2({ consoleText: "no markers here" });
  const other = fakeEd25519(9);

  const pasted = await afterVm({ harness: { ec2: silent() }, answers: { "Paste the ed25519 host key": other } });
  assert.equal(pasted.error, undefined, pasted.error?.message);
  const config = pasted.h.apiCalls.find((c) => c.name === "putProject").args[1];
  assert.equal(config.deployment.ssh.hostKey, other);
  assert.match(pasted.io.text(), /Source: pasted by you \(trust on first use\)/);

  const nothing = await afterVm({ harness: { ec2: silent() }, answers: { "Paste the ed25519 host key": "", "What now?": "keep" } });
  assert.match(nothing.error.message, /Timed out/);

  const garbage = await afterVm({ harness: { ec2: silent() }, answers: { "Paste the ed25519 host key": "ssh-rsa AAAA" } });
  assert.match(garbage.error.message, /rejected: That is not an ssh-ed25519 public key/);
});

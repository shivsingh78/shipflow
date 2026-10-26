// `cloud status` and `cloud destroy` against the fake EC2 world.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CloudError, UsageError } from "../../cli/dist/lib/errors.js";
import { runCloudDeploy, runCloudDestroy, runCloudStatus } from "../../cli/dist/lib/cloud/wizard.js";
import {
  FAKE_CREDENTIALS,
  HAPPY_ANSWERS,
  PUBLIC_IP,
  awsError,
  createFakeDeps,
  createFakeEc2,
  createFakeIo,
  createFakeSts,
  seedNeighbours,
} from "./helpers/cloudHarness.js";

/** Deploy once (successfully) and return the harness that holds the result. */
async function deployOnce({ ec2 = createFakeEc2(), sharedStore, name = "portfolio" } = {}) {
  const h = await createFakeDeps({ ec2, sharedStore });
  const io = createFakeIo({ answers: { ...HAPPY_ANSWERS, "Project / deployment name": name } });
  await runCloudDeploy({ flags: {}, deps: h.deps, io });
  return h;
}

const asUser = (h, answers = {}, { interactive = true } = {}) => ({
  io: createFakeIo({ answers: { "How should ShipFlow authenticate": "profile", "AWS profile name": "", ...answers }, interactive }),
  deps: h.deps,
});

const terminatedCalls = (ec2) => ec2.calls.filter((c) => c.name === "TerminateInstances").flatMap((c) => c.input.InstanceIds);

// ------------------------------------------------------------------- status

test("status shows the instance state and IP, and the deployment's recorded details", async () => {
  const h = await deployOnce();
  const { io, deps } = asUser(h);

  assert.equal(await runCloudStatus({ flags: {}, deps, io }), 0);

  const [meta] = h.store.list();
  const text = io.text();
  assert.match(text, new RegExp(`Deployment:\\s+${meta.id}`));
  assert.match(text, new RegExp(`Instance:\\s+${meta.instanceId}\\s+running`));
  assert.match(text, new RegExp(`Public IP:\\s+${PUBLIC_IP.replace(/\./g, "\\.")}`));
  assert.match(text, /URL:\s+http:\/\/203\.0\.113\.50\//);
  assert.match(text, /SSH allowed:\s+198\.51\.100\.7\/32/);
  assert.match(text, /Billing continues while the instance exists/);
  assert.match(text, new RegExp(`shipflow cloud destroy --id ${meta.id}`));
});

test("status --json is machine-readable and contains no secrets", async () => {
  const h = await deployOnce();
  const { io, deps } = asUser(h);

  await runCloudStatus({ flags: { json: true }, deps, io });

  const json = JSON.parse(io.output.filter((line) => line.startsWith("{")).at(-1));
  assert.equal(json.instanceState, "running");
  assert.equal(json.publicIp, PUBLIC_IP);
  assert.equal(json.managedByShipFlow, true);
  assert.equal(json.activeReleaseId, "Rel00001");
  assert.doesNotMatch(JSON.stringify(json), /PRIVATE KEY|AKIA|secret/i);
});

test("status works non-interactively with --profile and says when nothing is recorded", async () => {
  const h = await deployOnce();
  const io = createFakeIo({ interactive: false });
  assert.equal(await runCloudStatus({ flags: { profile: "ci" }, deps: h.deps, io }), 0);
  assert.deepEqual(h.auths.at(-1), { mode: "profile", profile: "ci" });

  const empty = await createFakeDeps();
  const emptyIo = createFakeIo({ interactive: false });
  assert.equal(await runCloudStatus({ flags: {}, deps: empty.deps, io: emptyIo }), 0);
  assert.match(emptyIo.text(), /No ShipFlow cloud deployments are recorded/);
  assert.equal(empty.authCalls.length, 0, "no AWS access when there is nothing to inspect");

  const noAuth = await runCloudStatus({ flags: {}, deps: h.deps, io: createFakeIo({ interactive: false }) }).catch((e) => e);
  assert.ok(noAuth instanceof UsageError);
  assert.match(noAuth.message, /--profile <name> or --default-credentials/);
});

test("status reflects a terminated instance and warns about instances not tagged for the deployment", async () => {
  const h = await deployOnce();
  const [meta] = h.store.list();
  h.ec2.world.instances.get(meta.instanceId).State = { Name: "terminated" };
  delete h.ec2.world.instances.get(meta.instanceId).PublicIpAddress;

  const gone = asUser(h);
  await runCloudStatus({ flags: {}, deps: gone.deps, io: gone.io });
  assert.match(gone.io.text(), /terminated/);
  assert.doesNotMatch(gone.io.text(), /Billing continues/);

  h.ec2.world.instances.get(meta.instanceId).State = { Name: "running" };
  h.ec2.world.instances.get(meta.instanceId).Tags = [];
  const stranger = asUser(h);
  await runCloudStatus({ flags: {}, deps: stranger.deps, io: stranger.io });
  assert.match(stranger.io.text(), /not tagged as belonging to this ShipFlow deployment/);
});

test("status selection: --id, a prompt when several exist, an error when it cannot ask", async () => {
  const ec2 = createFakeEc2();
  const first = await deployOnce({ ec2, name: "alpha" });
  const second = await deployOnce({ ec2, sharedStore: first.store, name: "beta" });
  const newest = first.store.list().find((d) => d.project === "beta");
  const oldest = first.store.list().find((d) => d.project === "alpha");
  assert.equal(first.store.list().length, 2);

  const unknown = asUser(second);
  await assert.rejects(runCloudStatus({ flags: { id: "sf-ffffffff" }, deps: unknown.deps, io: unknown.io }), /No deployment sf-ffffffff is recorded/);
  await assert.rejects(runCloudStatus({ flags: { id: "../x" }, deps: unknown.deps, io: unknown.io }), /--id must look like/);

  const explicit = asUser(second);
  await runCloudStatus({ flags: { id: oldest.id }, deps: explicit.deps, io: explicit.io });
  assert.match(explicit.io.text(), new RegExp(`Deployment:\\s+${oldest.id}`));

  const chosen = asUser(second, { "Which deployment?": newest.id });
  await runCloudStatus({ flags: {}, deps: chosen.deps, io: chosen.io });
  assert.match(chosen.io.text(), new RegExp(`Deployment:\\s+${newest.id}`));

  const headless = createFakeIo({ interactive: false });
  await assert.rejects(runCloudStatus({ flags: { profile: "p" }, deps: second.deps, io: headless }), (e) => e instanceof UsageError && e.message.includes(newest.id) && e.message.includes(oldest.id));
});

// ------------------------------------------------------------------ destroy

test("destroy needs a terminal", async () => {
  const h = await deployOnce();
  const { deps } = asUser(h);
  await assert.rejects(runCloudDestroy({ flags: {}, deps, io: createFakeIo({ interactive: false }) }), /must run in a terminal/);
  assert.equal(terminatedCalls(h.ec2).length, 0);
});

test("destroy does nothing unless DESTROY is typed exactly", async () => {
  const h = await deployOnce();
  const [meta] = h.store.list();

  for (const typed of ["", "destroy", "yes", "Destroy", "DESTROY!"]) {
    const { io, deps } = asUser(h, { "Type DESTROY": typed });
    const error = await runCloudDestroy({ flags: {}, deps, io }).catch((e) => e);

    assert.ok(error instanceof CloudError, `"${typed}" should cancel`);
    assert.match(error.message, /Cancelled\. Nothing was destroyed/);
  }

  assert.equal(terminatedCalls(h.ec2).length, 0);
  assert.equal(h.ec2.count("DeleteSecurityGroup"), 0);
  assert.equal(h.store.load(meta.id).state, "deployed");
});

test("destroy terminates only the selected deployment and its own resources; history is kept", async () => {
  const ec2 = createFakeEc2();
  seedNeighbours(ec2.world);
  const first = await deployOnce({ ec2, name: "alpha" });
  const second = await deployOnce({ ec2, sharedStore: first.store, name: "beta" });
  const byProject = (project) => first.store.list().find((d) => d.project === project);
  const alpha = byProject("alpha");
  const beta = byProject("beta");
  assert.notEqual(alpha.id, beta.id);
  const apiCallsBefore = second.apiCalls.length;

  const { io, deps } = asUser(second, { "Type DESTROY": "DESTROY" });
  const code = await runCloudDestroy({ flags: { id: alpha.id }, deps, io });
  assert.equal(code, 0);

  // alpha: gone
  assert.equal(ec2.world.instances.get(alpha.instanceId).State.Name, "terminated");
  assert.equal(ec2.world.groups.has(alpha.securityGroupId), false);
  assert.equal(ec2.world.keyPairs.has(alpha.keyPairName), false);

  // everything else: untouched, including the other deployment and unrelated resources
  assert.equal(ec2.world.instances.get(beta.instanceId).State.Name, "running");
  assert.equal(ec2.world.groups.has(beta.securityGroupId), true);
  assert.equal(ec2.world.keyPairs.has(beta.keyPairName), true);
  for (const id of ["i-other", "i-unrelated"]) assert.equal(ec2.world.instances.get(id).State.Name, "running", id);
  for (const id of ["sg-other", "sg-unrelated"]) assert.ok(ec2.world.groups.has(id), id);
  for (const name of ["shipflow-sf-0000beef", "prod-key"]) assert.ok(ec2.world.keyPairs.has(name), name);

  assert.deepEqual(terminatedCalls(ec2), [alpha.instanceId]);
  assert.deepEqual(ec2.calls.filter((c) => c.name === "DeleteSecurityGroup").map((c) => c.input.GroupId), [alpha.securityGroupId]);
  assert.deepEqual(ec2.calls.filter((c) => c.name === "DeleteKeyPair").map((c) => c.input.KeyName), [alpha.keyPairName]);

  // metadata, ShipFlow project and releases
  const recorded = first.store.load(alpha.id);
  assert.equal(recorded.state, "destroyed");
  assert.match(recorded.destroyedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(first.store.load(beta.id).state, "deployed");
  assert.equal(second.apiCalls.length, apiCallsBefore, "no ShipFlow API call: project, releases and logs are kept");
  assert.match(io.text(), /Only these resources are touched/);
  assert.match(io.text(), /project, releases, logs and your repository are kept/);
  assert.match(io.text(), /shipflow secrets rm SSH_PRIVATE_KEY --project alpha/);
});

test("destroy previews exactly what will be removed before asking", async () => {
  const h = await deployOnce();
  const [meta] = h.store.list();
  let previewed = "";
  let terminatedAtPrompt = null;
  const { io, deps } = asUser(h, {
    "Type DESTROY": () => {
      previewed = io.text();
      terminatedAtPrompt = terminatedCalls(h.ec2).length;
      return "DESTROY";
    },
  });

  await runCloudDestroy({ flags: {}, deps, io });

  assert.match(previewed, new RegExp(`Deployment ${meta.id} \\(project portfolio\\) in ap-south-1`));
  assert.match(previewed, new RegExp(`EC2 instance ${meta.instanceId}: will be removed`));
  assert.match(previewed, new RegExp(`security group ${meta.securityGroupId}: will be removed`));
  assert.match(previewed, new RegExp(`key pair ${meta.keyPairName}: will be removed`));
  assert.equal(terminatedAtPrompt, 0, "nothing happened before the confirmation");
  assert.equal(terminatedCalls(h.ec2).length, 1, "and the confirmed destroy then ran");
});

test("destroy refuses an instance that is not tagged for this deployment, even if the metadata says so", async () => {
  const ec2 = createFakeEc2();
  seedNeighbours(ec2.world);
  const h = await deployOnce({ ec2 });
  const [meta] = h.store.list();

  for (const target of ["i-other", "i-unrelated"]) {
    h.store.save(meta.id, { instanceId: target });
    const { io, deps } = asUser(h, { "Type DESTROY": "DESTROY" });
    const error = await runCloudDestroy({ flags: {}, deps, io }).catch((e) => e);

    assert.ok(error instanceof CloudError, target);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, new RegExp(`Instance ${target} is not tagged as ShipFlow deployment ${meta.id}; refusing`));
    assert.equal(io.prompts.some((p) => p.includes("Type DESTROY")), false, "refused before even asking");
  }

  assert.equal(terminatedCalls(ec2).length, 0);
  assert.equal(ec2.world.instances.get("i-unrelated").State.Name, "running");
});

test("destroy that cannot remove everything says so, is retryable, and does not report success", async () => {
  const ec2 = createFakeEc2({ overrides: { DeleteSecurityGroup: () => { throw awsError("UnauthorizedOperation", "not allowed"); } } });
  const h = await deployOnce({ ec2 });
  const [meta] = h.store.list();

  const first = asUser(h, { "Type DESTROY": "DESTROY" });
  const error = await runCloudDestroy({ flags: {}, deps: first.deps, io: first.io }).catch((e) => e);

  assert.ok(error instanceof CloudError);
  assert.match(error.message, /could not be removed; they may still be billed/);
  assert.match(first.io.text(), /FAILED security group sg-/);
  assert.equal(h.store.load(meta.id).state, "failed-partial");
  assert.equal(ec2.world.instances.get(meta.instanceId).State.Name, "terminated");

  // Permissions fixed: the retry finishes the job (the instance is already gone).
  delete ec2.world.overrides;
  const fixed = createFakeEc2();
  fixed.world = ec2.world;
  h.deps.createAwsClients = () => ({ ec2: { call: (name, input) => (name === "DeleteSecurityGroup" ? Promise.resolve(ec2.world.groups.delete(input.GroupId) && {}) : ec2.call(name, input)) }, sts: h.sts });
  const retry = asUser(h, { "Type DESTROY": "DESTROY" });
  assert.equal(await runCloudDestroy({ flags: {}, deps: retry.deps, io: retry.io }), 0);
  assert.equal(h.store.load(meta.id).state, "destroyed");
  assert.equal(ec2.world.groups.has(meta.securityGroupId), false);
});

test("destroying something already destroyed is a no-op that does not touch AWS", async () => {
  const h = await deployOnce();
  const [meta] = h.store.list();
  const a = asUser(h, { "Type DESTROY": "DESTROY" });
  await runCloudDestroy({ flags: {}, deps: a.deps, io: a.io });

  const authsBefore = h.authCalls.length;
  const again = asUser(h);
  assert.equal(await runCloudDestroy({ flags: { id: meta.id }, deps: again.deps, io: again.io }), 0);
  assert.match(again.io.text(), /already destroyed/);
  assert.equal(h.authCalls.length, authsBefore);

  const none = asUser(h);
  assert.equal(await runCloudDestroy({ flags: {}, deps: none.deps, io: none.io }), 0);
  assert.match(none.io.text(), /No active ShipFlow cloud deployments/);
});

test("authentication problems stop status and destroy before any resource call", async () => {
  const h = await deployOnce();
  const bad = await createFakeDeps({
    sharedStore: h.store,
    sts: createFakeSts({ error: awsError("ExpiredToken", `expired ${FAKE_CREDENTIALS.sessionToken}`) }),
  });

  for (const run of [runCloudStatus, runCloudDestroy]) {
    const { io, deps } = asUser(bad, { "Type DESTROY": "DESTROY" });
    const error = await run({ flags: {}, deps, io }).catch((e) => e);
    assert.equal(error.exitCode, 3);
    assert.doesNotMatch(error.message, /FQoGZXIv/);
    assert.equal(bad.ec2.calls.length, 0);
  }
});

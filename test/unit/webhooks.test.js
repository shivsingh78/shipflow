import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";

import { verifySignature, planForProject, createGithubWebhookHandler } from "../../dist/src/webhooks.js";

const SECRET = "webhook-test-secret";
const sign = (body) => `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;

const project = (github = {}) => ({
  name: "site",
  repo_url: "https://github.com/me/site",
  target: "ssh",
  config: {
    project: { name: "site", branch: "main" },
    github: { checkPullRequests: true, deployOnPush: false, deployBranch: "main", ...github },
  },
});

const SHA = "a".repeat(40);

test("signature verification is exact", () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, body, sign(Buffer.from('{"a":2}'))), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature(SECRET, body, "sha1=abc"), false);
});

test("pull requests only produce check runs", () => {
  const { plan } = planForProject("pull_request", { action: "opened", number: 7 }, project({ deployOnPush: true }));
  assert.deepEqual(plan, [{ mode: "check", ref: "refs/pull/7/head" }]);

  assert.deepEqual(planForProject("pull_request", { action: "closed", number: 7 }, project()).plan, []);
  assert.deepEqual(planForProject("pull_request", { action: "opened", number: 7 }, project({ checkPullRequests: false })).plan, []);
});

test("pushes deploy only to the deploy branch and only when enabled", () => {
  const push = (branch) => ({ ref: `refs/heads/${branch}`, after: SHA });

  assert.deepEqual(planForProject("push", push("main"), project()).plan, [{ mode: "check", ref: SHA }], "off by default");
  assert.deepEqual(planForProject("push", push("main"), project({ deployOnPush: true })).plan, [{ mode: "deploy", ref: SHA }]);
  assert.deepEqual(planForProject("push", push("feature"), project({ deployOnPush: true })).plan, []);
  assert.deepEqual(planForProject("push", { ...push("main"), deleted: true }, project({ deployOnPush: true })).plan, []);
  assert.deepEqual(planForProject("push", { ref: "refs/tags/v1", after: SHA }, project({ deployOnPush: true })).plan, []);
  assert.deepEqual(planForProject("push", { ref: "refs/heads/main", after: "not-a-sha" }, project({ deployOnPush: true })).plan, []);
});

let server;
let url;
const queued = [];
const deliveries = new Set();

before(async () => {
  const app = express();
  app.post(
    "/hook",
    express.raw({ type: "*/*" }),
    createGithubWebhookHandler({
      secret: SECRET,
      allowedRepoPrefixes: ["https://github.com/me/"],
      findProjects: async (fullName) => (fullName === "me/site" ? [project({ deployOnPush: true })] : []),
      enqueue: async (options) => {
        queued.push(options);
        return { release_id: `R${queued.length}aaaaaaa`.slice(0, 8) };
      },
      recordDelivery: async ({ deliveryId }) => {
        if (deliveries.has(deliveryId)) return false;
        deliveries.add(deliveryId);
        return true;
      },
      finishDelivery: async () => {},
    })
  );
  server = app.listen(0);
  url = `http://127.0.0.1:${server.address().port}/hook`;
});

after(() => server.close());

const deliver = (event, payload, { id = crypto.randomUUID(), signature } = {}) => {
  const body = JSON.stringify(payload);
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": id,
      "X-Hub-Signature-256": signature ?? sign(body),
    },
    body,
  });
};

test("handler rejects bad signatures and queues nothing", async () => {
  const response = await deliver("push", { repository: { full_name: "me/site" } }, { signature: "sha256=00" });
  assert.equal(response.status, 401);
  assert.equal(queued.length, 0);
});

test("handler queues a deploy for a push and ignores the duplicate delivery", async () => {
  const payload = { ref: "refs/heads/main", after: SHA, repository: { full_name: "me/site" } };

  const first = await deliver("push", payload, { id: "delivery-1" });
  assert.equal(first.status, 202);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].mode, "deploy");
  assert.equal(queued[0].ref, SHA);
  assert.equal(queued[0].trigger, "webhook");

  const again = await deliver("push", payload, { id: "delivery-1" });
  assert.equal((await again.json()).duplicate, true);
  assert.equal(queued.length, 1);
});

test("handler refuses repositories outside the allowlist", async () => {
  const response = await deliver("push", { ref: "refs/heads/main", after: SHA, repository: { full_name: "evil/site" } });
  assert.equal(response.status, 403);
});

test("ping is answered without queueing", async () => {
  const response = await deliver("ping", { zen: "hi" });
  assert.equal((await response.json()).message, "pong");
});

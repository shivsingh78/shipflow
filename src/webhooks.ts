// GitHub webhooks -> releases for registered projects.
//
//   pull_request (opened/synchronize/reopened)  -> "check" run (build + test
//       of refs/pull/<n>/head) when github.checkPullRequests is true.
//       Check runs never deploy and never receive deployment secrets, so
//       code from forks cannot reach them.
//   push to github.deployBranch               -> "deploy" of the pushed commit
//       when github.deployOnPush is true (off by default).
//   push to project.branch otherwise          -> "check" run.
//
// Every request must carry a valid X-Hub-Signature-256 (HMAC-SHA256 of the
// raw body with SHIPFLOW_GITHUB_WEBHOOK_SECRET). Deliveries are de-duplicated
// by X-GitHub-Delivery. The payload is otherwise untrusted: only the
// repository name, branch, commit SHA and PR number are used, and each is
// validated before use.
import crypto from "crypto";
import type { Request, Response } from "express";

import { pool } from "./db.js";
import { validateRepoUrl } from "./validation.js";
import { errorMessage } from "./errors.js";
import type { ProjectRow } from "./projectStore.js";

/** The subset of a GitHub webhook payload ShipFlow reads (untrusted). */
export interface WebhookPayload {
  action?: string;
  number?: number;
  pull_request?: { number?: number };
  deleted?: boolean;
  ref?: string;
  after?: string;
  repository?: { full_name?: string };
}

/** A registered project as the webhook planner sees it. */
export type WebhookProject = Pick<ProjectRow, "name" | "repo_url" | "target" | "config">;

export type ReleaseMode = "check" | "deploy";

export interface PlanStep {
  mode: ReleaseMode;
  ref: string;
}

export interface EnqueueOptions {
  repoUrl: string;
  project: string;
  mode: ReleaseMode;
  ref: string;
  trigger: string;
  target: string;
  config: ProjectRow["config"];
}

interface DeliveryOutcome {
  deliveryId: string;
  project?: string | undefined;
  releaseId?: string | undefined;
  outcome: string;
}

export interface GithubWebhookOptions {
  secret: string;
  allowedRepoPrefixes: string[];
  findProjects: (fullName: string) => Promise<WebhookProject[]>;
  enqueue: (options: EnqueueOptions) => Promise<{ release_id: string }>;
  recordDelivery?: (delivery: { deliveryId: string; event: string }) => Promise<boolean>;
  finishDelivery?: (delivery: DeliveryOutcome) => Promise<void>;
}

interface Outcome {
  project: string;
  releaseId?: string;
  mode?: ReleaseMode;
  outcome: string;
}

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const FULL_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const DELIVERY = /^[A-Za-z0-9-]{1,100}$/;

export function verifySignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined
): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) {
    return false;
  }

  const expected = Buffer.from(
    `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`
  );
  const actual = Buffer.from(header);

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Decide which releases an event should create for one project.
 * Returns [{ mode, ref }] (possibly empty) and a reason.
 */
export function planForProject(
  event: string,
  payload: WebhookPayload,
  project: WebhookProject
): { plan: PlanStep[]; reason: string } {
  const github = project.config.github;

  if (event === "pull_request") {
    if (!["opened", "synchronize", "reopened"].includes(payload.action ?? "")) {
      return { plan: [], reason: `pull_request action "${payload.action}" ignored` };
    }

    const number = payload.number ?? payload.pull_request?.number;

    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
      return { plan: [], reason: "pull request number missing" };
    }

    if (!github.checkPullRequests) {
      return { plan: [], reason: "github.checkPullRequests is false" };
    }

    return { plan: [{ mode: "check", ref: `refs/pull/${number}/head` }], reason: "pull request check" };
  }

  if (event === "push") {
    if (payload.deleted) {
      return { plan: [], reason: "branch deletion ignored" };
    }

    const branch = typeof payload.ref === "string" ? payload.ref.replace(/^refs\/heads\//, "") : "";

    if (!payload.ref?.startsWith("refs/heads/") || !BRANCH.test(branch)) {
      return { plan: [], reason: "not a branch push" };
    }

    if (!SHA.test(payload.after ?? "")) {
      return { plan: [], reason: "pushed commit SHA missing" };
    }

    if (github.deployOnPush && branch === github.deployBranch) {
      return { plan: [{ mode: "deploy", ref: payload.after as string }], reason: `push to deploy branch ${branch}` };
    }

    if (branch === project.config.project.branch) {
      return { plan: [{ mode: "check", ref: payload.after as string }], reason: `push to ${branch} (deployOnPush is off)` };
    }

    return { plan: [], reason: `push to ${branch} ignored` };
  }

  return { plan: [], reason: `event "${event}" ignored` };
}

async function recordDeliveryDefault({
  deliveryId,
  event,
}: {
  deliveryId: string;
  event: string;
}): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO webhook_deliveries (delivery_id, event) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [deliveryId, event]
  );

  return result.rowCount === 1;
}

async function finishDeliveryDefault({
  deliveryId,
  project,
  releaseId,
  outcome,
}: DeliveryOutcome): Promise<void> {
  await pool.query(
    `UPDATE webhook_deliveries SET project = $2, release_id = $3, outcome = $4 WHERE delivery_id = $1`,
    [deliveryId, project ?? null, releaseId ?? null, outcome.slice(0, 2000)]
  );
}

export function createGithubWebhookHandler({
  secret,
  allowedRepoPrefixes,
  findProjects,
  enqueue,
  recordDelivery = recordDeliveryDefault,
  finishDelivery = finishDeliveryDefault,
}: GithubWebhookOptions) {
  return async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!verifySignature(secret, rawBody, req.get("x-hub-signature-256"))) {
      return res.status(401).json({ success: false, message: "Invalid webhook signature" });
    }

    const event = req.get("x-github-event") || "";
    const deliveryId = req.get("x-github-delivery") || "";

    if (!DELIVERY.test(deliveryId)) {
      return res.status(400).json({ success: false, message: "Missing X-GitHub-Delivery" });
    }

    let payload: WebhookPayload;

    try {
      payload = JSON.parse(rawBody.toString("utf8")) as WebhookPayload;
    } catch {
      return res.status(400).json({ success: false, message: "Body must be JSON" });
    }

    if (event === "ping") {
      return res.json({ success: true, message: "pong" });
    }

    if (!(await recordDelivery({ deliveryId, event }))) {
      return res.json({ success: true, duplicate: true, message: "Delivery already processed" });
    }

    const fullName = payload.repository?.full_name ?? "";

    if (!FULL_NAME.test(fullName)) {
      await finishDelivery({ deliveryId, outcome: "repository missing" });
      return res.status(400).json({ success: false, message: "repository.full_name missing" });
    }

    try {
      validateRepoUrl(`https://github.com/${fullName}`, allowedRepoPrefixes);
    } catch {
      await finishDelivery({ deliveryId, outcome: "repository not allowed" });
      return res.status(403).json({ success: false, message: "Repository is not allowed on this ShipFlow server" });
    }

    const projects = await findProjects(fullName);
    const outcomes: Outcome[] = [];

    for (const project of projects) {
      const { plan, reason } = planForProject(event, payload, project);

      if (plan.length === 0) {
        outcomes.push({ project: project.name, outcome: reason });
        continue;
      }

      for (const step of plan) {
        try {
          const release = await enqueue({
            repoUrl: project.repo_url,
            project: project.name,
            mode: step.mode,
            ref: step.ref,
            trigger: "webhook",
            target: project.target,
            config: project.config,
          });
          outcomes.push({ project: project.name, releaseId: release.release_id, mode: step.mode, outcome: reason });
        } catch (error) {
          outcomes.push({ project: project.name, outcome: `not queued: ${errorMessage(error)}` });
        }
      }
    }

    const summary = outcomes.length
      ? outcomes.map((o) => `${o.project}: ${o.releaseId ? `${o.mode} ${o.releaseId}` : o.outcome}`).join("; ")
      : "no registered project for this repository";

    await finishDelivery({
      deliveryId,
      project: outcomes[0]?.project,
      releaseId: outcomes.find((o) => o.releaseId)?.releaseId,
      outcome: summary,
    });

    return res.status(202).json({ success: true, results: outcomes });
  };
}

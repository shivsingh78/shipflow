import { beforeEach, describe, expect, it } from "vitest";
import { buildConfig, draftFromConfig, emptyDraft, errorMap, repoUrlIssue, stepOfPath, withTarget } from "./configForm";
import type { ConfigDraft } from "./configForm";
import { DRAFT_KEY, loadDraft, saveDraft } from "./draftStorage";
import { deriveAppRows, filterRows, missingSecrets, secretRows, sortRows } from "./appState";
import { toYaml } from "./yaml";
import type { ProjectWithState } from "@/data/hooks";
import type { Release } from "@/api/types";
import { createDemoClient } from "@/api/demo";

const PREFIXES = ["https://github.com/acme/"];

function valid(): ConfigDraft {
  return { ...emptyDraft(), name: "my-site", repository: "https://github.com/acme/my-site" };
}

describe("buildConfig", () => {
  it("accepts a minimal static configuration", () => {
    const result = buildConfig(valid(), PREFIXES);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.project.name).toBe("my-site");
      expect(result.config.deployment.target).toBe("shipflow");
    }
  });

  it("maps validator errors to dotted paths and steps", () => {
    const result = buildConfig({ ...valid(), name: "Bad Name", branch: "-x" }, PREFIXES);

    expect(result.ok).toBe(false);

    const map = errorMap(result.issues);

    expect(map.get("project.name")).toMatch(/lowercase/);
    expect(map.get("project.branch")).toBeDefined();
    expect(stepOfPath("project.name")).toBe(1);
    expect(stepOfPath("project.branch")).toBe(2);
    expect(stepOfPath("github.deployBranch")).toBe(2);
    expect(stepOfPath("build.strategy")).toBe(3);
    expect(stepOfPath("deployment.ssh.host")).toBe(4);
  });

  it("enforces the shared compatibility rules", () => {
    const image = buildConfig({ ...valid(), target: "docker", strategy: "static" }, PREFIXES);
    const staticTarget = buildConfig({ ...valid(), strategy: "node" }, PREFIXES);
    const noPort = buildConfig({ ...valid(), target: "docker" }, PREFIXES);

    expect(errorMap(image.issues).get("build.strategy")).toMatch(/static/);
    expect(errorMap(staticTarget.issues).get("build.strategy")).toMatch(/static files/);
    expect(errorMap(noPort.issues).get("runtime.port")).toBeDefined();
  });

  it("surfaces secret-looking environment keys on the row's path, without the (root) prefix", () => {
    const result = buildConfig({ ...valid(), buildEnv: [{ key: "API_TOKEN", value: "x" }] }, PREFIXES);

    expect(errorMap(result.issues).get("build.env.API_TOKEN")).toMatch(/looks like a secret/);
  });

  it("rejects duplicate variable names and credentials in URLs", () => {
    const dup = buildConfig({ ...valid(), buildEnv: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }, PREFIXES);
    const creds = buildConfig({ ...valid(), repository: "https://user:pw@github.com/acme/x" }, PREFIXES);

    expect(errorMap(dup.issues).get("build.env.A")).toMatch(/twice/);
    expect(errorMap(creds.issues).get("project.repository")).toMatch(/credentials/);
  });

  it("checks the repository against allowed prefixes", () => {
    expect(repoUrlIssue("https://github.com/other/x", PREFIXES)).toMatch(/not allowed/);
    expect(repoUrlIssue("https://github.com/acme/x", PREFIXES)).toBeNull();
    expect(repoUrlIssue("https://anything.example/x", [])).toBeNull();
    expect(buildConfig({ ...valid(), repository: "https://github.com/other/x" }, PREFIXES).ok).toBe(false);
  });

  it("round-trips a stored configuration through the form", async () => {
    const detail = await createDemoClient().getProject("orders-api");
    const draft = draftFromConfig(detail.project.config);
    const result = buildConfig(draft, PREFIXES);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual(detail.project.config);
  });

  it("drops a build strategy the new target cannot use", () => {
    expect(withTarget({ ...valid(), strategy: "node" }, "shipflow").strategy).toBe("");
    expect(withTarget({ ...valid(), strategy: "static" }, "docker").strategy).toBe("");
    expect(withTarget({ ...valid(), strategy: "node" }, "docker").strategy).toBe("node");
  });
});

describe("toYaml", () => {
  it("serializes a validated configuration", () => {
    const result = buildConfig({ ...valid(), target: "docker", strategy: "node", runtimePort: "3000", runtimeSecrets: "DATABASE_URL", docker: { ...emptyDraft().docker, host: "d.acme.dev", user: "deploy", url: "https://a.acme.dev", hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" } }, PREFIXES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const yaml = toYaml(result.config);

    expect(yaml).toContain("version: 1\nproject:\n  name: my-site\n");
    expect(yaml).toContain("  repository: https://github.com/acme/my-site");
    expect(yaml).toContain("runtime:\n  port: 3000\n  env: {}\n  secrets:\n    - DATABASE_URL");
    expect(yaml).toContain('  path: /\n  expectStatus: 200');
    expect(yaml).toContain("target: docker");
  });

  it("quotes strings that would parse as something else", () => {
    expect(toYaml({ a: "true", b: "123", c: "", d: "x: y", e: "plain" })).toBe('a: "true"\nb: "123"\nc: ""\nd: "x: y"\ne: plain\n');
  });
});

describe("wizard draft storage", () => {
  beforeEach(() => sessionStorage.clear());

  it("never stores secret-looking values or credentialed URLs", () => {
    const draft: ConfigDraft = {
      ...valid(),
      repository: "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/x",
      buildEnv: [{ key: "API_TOKEN", value: "supersecret" }, { key: "PUBLIC_URL", value: "https://x.dev" }, { key: "NOTE", value: "AKIAABCDEFGHIJKLMNOP" }],
    };

    saveDraft(3, draft);

    const raw = sessionStorage.getItem(DRAFT_KEY) ?? "";

    expect(raw).not.toContain("supersecret");
    expect(raw).not.toContain("ghp_");
    expect(raw).not.toContain("AKIA");
    expect(raw).toContain("https://x.dev");
    expect(loadDraft()?.step).toBe(3);
    expect(loadDraft()?.draft.repository).toBe("");
  });

  it("ignores corrupt drafts", () => {
    sessionStorage.setItem(DRAFT_KEY, "{not json");
    expect(loadDraft()).toBeNull();
  });
});

describe("application state", () => {
  it("derives missing secrets from the required names", async () => {
    const client = createDemoClient();
    const billing = await client.getProject("billing-service");
    const orders = await client.getProject("orders-api");

    expect(missingSecrets(billing.project.config, billing.secrets)).toEqual(["STRIPE_KEY"]);
    expect(missingSecrets(orders.project.config, orders.secrets)).toEqual([]);

    const rows = secretRows(billing.project.config, billing.secrets);

    expect(rows[0]).toMatchObject({ name: "STRIPE_KEY", required: true, set: false });
  });

  it("derives status from the latest deployment and filters", async () => {
    const client = createDemoClient();
    const names = (await client.listProjects()).map((p) => p.name);
    const details: ProjectWithState[] = await Promise.all(names.map(async (n) => { const d = await client.getProject(n); return { project: d.project, activeReleaseId: d.activeReleaseId, secrets: d.secrets }; }));
    const releases: Release[] = (await client.listReleases({ limit: 200 })).releases;
    const rows = deriveAppRows(details, releases);
    const status = (name: string) => rows.find((r) => r.name === name)?.status;

    expect(status("orders-api")).toBe("running");
    expect(status("marketing-site")).toBe("healthy");
    expect(status("billing-service")).toBe("running");
    expect(status("docs-portal")).toBe("healthy");
    expect(filterRows(rows, { search: "", target: "docker", status: "all" }).map((r) => r.name).sort()).toEqual(["orders-api", "worker-app"]);
    expect(filterRows(rows, { search: "docs", target: "all", status: "all" }).map((r) => r.name)).toEqual(["docs-portal"]);
    expect(filterRows(rows, { search: "", target: "all", status: "never" })).toEqual([]);
    expect(sortRows(rows, "name")[0]?.name).toBe("billing-service");
  });
});

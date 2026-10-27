import { describe, expect, it } from "vitest";
import { createDemoClient } from "@/api/demo";
import { deriveInfraRegistries, deriveInfraServers, detailText, formatHostKey } from "./model";

async function projects() {
  const api = createDemoClient();
  const list = await api.listProjects();

  return (await Promise.all(list.map((p) => api.getProject(p.name)))).map((d) => d.project);
}

describe("formatHostKey", () => {
  it("splits type and truncates the blob", () => {
    const parts = formatHostKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIABCDEFGHIJKLMNOPQRSTUVWXYZ0123");

    expect(parts.type).toBe("ssh-ed25519");
    expect(parts.short).toBe("AAAAC3NzaC1l…WXYZ0123");
  });

  it("keeps short blobs whole", () => {
    expect(formatHostKey("ssh-rsa AAAA").short).toBe("AAAA");
  });
});

describe("derivations", () => {
  it("groups projects by server and excludes the site server", async () => {
    const servers = deriveInfraServers(await projects());
    const docker = servers.find((s) => s.kind === "docker");

    expect(servers.some((s) => s.projects.includes("marketing-site"))).toBe(false);
    expect(docker?.projects.sort()).toEqual(["orders-api", "worker-app"]);
    expect(servers.map((s) => s.kind)).toEqual(expect.arrayContaining(["ssh", "docker", "kubernetes"]));
  });

  it("derives registries from kubernetes targets only", async () => {
    const regs = deriveInfraRegistries(await projects());

    expect(regs).toHaveLength(1);
    expect(regs[0]?.projects).toEqual(["billing-service"]);
  });

  it("stringifies check detail", () => {
    expect(detailText({ a: 1 })).toBe('{"a":1}');
    expect(detailText(null)).toBe("");
  });
});

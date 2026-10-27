import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./client";
import { ApiError } from "./errors";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const respond = (body: unknown, status = 200) => vi.fn<typeof fetch>(() => Promise.resolve(json(body, status)));

describe("http client", () => {
  it("sends the bearer token, never as a cookie, and no credentials", async () => {
    const fetchImpl = respond({ success: true, projects: [] });
    const client = createHttpClient({ token: "t0ken", fetchImpl });

    await client.listProjects();

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/projects");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t0ken");
    expect(init?.credentials).toBe("omit");
  });

  it("turns error responses into ApiError with the server message and validation issues", async () => {
    const fetchImpl = respond({ success: false, message: "Invalid ShipFlow configuration", errors: [{ path: "project.name", message: "is required" }] }, 400);
    const client = createHttpClient({ token: "t", fetchImpl });

    await expect(client.saveProject({ project: { name: "x" } } as never)).rejects.toMatchObject({
      status: 400,
      message: "Invalid ShipFlow configuration",
      issues: [{ path: "project.name", message: "is required" }],
    });
  });

  it("signs out on 401", async () => {
    const onUnauthorized = vi.fn();
    const client = createHttpClient({ token: "bad", onUnauthorized, fetchImpl: respond({ success: false, message: "Unauthorized" }, 401) });

    await expect(client.whoami()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("reports an unreachable server as a network error", async () => {
    const client = createHttpClient({ token: "t", fetchImpl: vi.fn<typeof fetch>(() => Promise.reject(new TypeError("fetch failed"))) });

    await expect(client.whoami()).rejects.toMatchObject({ status: 0 });
  });

  it("treats /ready 503 as data (failing checks), not an error", async () => {
    const client = createHttpClient({ token: "t", fetchImpl: respond({ success: false, checks: [{ name: "database", ok: false, detail: "down" }] }, 503) });

    await expect(client.ready()).resolves.toEqual({ ok: false, checks: [{ name: "database", ok: false, detail: "down" }] });
  });

  it("never sends a secret value anywhere except the write call's body", async () => {
    const fetchImpl = respond({ success: true });
    const client = createHttpClient({ token: "t", fetchImpl });

    await client.setSecret("app", "DB_URL", "super-secret");

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/projects/app/secrets/DB_URL");
    expect(init?.method).toBe("PUT");
    expect(url as string).not.toContain("super-secret");
    expect(init?.body).toBe(JSON.stringify({ value: "super-secret" }));
  });
});

describe("deploy requests", () => {
  it("label themselves as coming from the dashboard", async () => {
    const fetchImpl = respond({ success: true, release: { release_id: "Abcd1234" } });
    const client = createHttpClient({ token: "t", fetchImpl });

    await client.deploy({ project: "app", mode: "check" });

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(JSON.parse(init?.body as string)).toEqual({ trigger: "dashboard", project: "app", mode: "check" });
  });
});

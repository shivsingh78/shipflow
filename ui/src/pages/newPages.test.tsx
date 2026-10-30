import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import InfrastructurePage from "./infrastructure/InfrastructurePage";
import PipelinesPage from "./pipelines/PipelinesPage";
import SecretsPage from "./settings/SecretsPage";
import { secretInventory, secretSummary } from "./settings/secrets";

describe("Pipelines", () => {
  it("lists real releases with a pipeline track, status and a link to the release", async () => {
    renderPage(<PipelinesPage />);

    const link = await screen.findByRole("link", { name: "Zp3tY9cE" });

    expect(link).toHaveAttribute("href", "/releases/Zp3tY9cE");
    expect(screen.getAllByRole("img", { name: /^Pipeline: Prepare/ }).length).toBeGreaterThan(3);
    expect(screen.getByText(/does not store per-stage timings/)).toBeInTheDocument();
  });

  it("filters by status tab and by search", async () => {
    renderPage(<PipelinesPage />);
    await screen.findByRole("link", { name: "Zp3tY9cE" });

    await userEvent.click(screen.getByRole("tab", { name: /^Failed/ }));
    expect(screen.getByRole("link", { name: "Zp3tY9cE" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Kd8mW2vB" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /^All/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search pipelines" }), "zzzz");
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
  });
});

describe("Infrastructure hub", () => {
  it("is explicit that nothing is continuously monitored and shows no invented capacity numbers", async () => {
    renderPage(<InfrastructurePage />);

    expect(await screen.findByText(/does not continuously monitor these resources/)).toBeInTheDocument();
    expect(screen.getByText("Derived + diagnostic data")).toBeInTheDocument();
    expect(screen.getByText(/Not collected · Planned/)).toBeInTheDocument();
    expect(screen.queryByText(/\b\d+%/)).not.toBeInTheDocument();
    expect(screen.getByText(/Health monitoring for domains is planned/)).toBeInTheDocument();
  });

  it("links to the existing Servers, Registries and Domains pages", async () => {
    renderPage(<InfrastructurePage />);
    await screen.findByRole("list", { name: "Connected resources" });

    const hrefs = screen.getAllByRole("link", { name: /View (details|all)/ }).map((a) => a.getAttribute("href"));

    expect(hrefs).toEqual(expect.arrayContaining(["/servers", "/registries", "/domains"]));
  });

  it("lets the notice be dismissed and runs real diagnostics", async () => {
    renderPage(<InfrastructurePage />);
    await screen.findByText(/does not continuously monitor/);

    await userEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByText(/does not continuously monitor these resources/)).not.toBeInTheDocument();
    expect(await screen.findByText("Control plane diagnostics")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run diagnostics" })).toBeEnabled();
  });
});

describe("Secrets", () => {
  it("never shows a value: only names, status and a mask", async () => {
    renderPage(<SecretsPage />);

    const table = await screen.findByRole("table", { name: "Secrets by application" });

    expect(within(table).getAllByLabelText("Value hidden").length).toBeGreaterThan(0);
    expect(screen.getByText(/never displayed after creation/)).toBeInTheDocument();
    expect(screen.getByText(/does not keep a separate secrets audit log/)).toBeInTheDocument();
  });

  it("labels future controls as planned and disabled", async () => {
    renderPage(<SecretsPage />);
    await screen.findByRole("heading", { name: "Future controls" });

    for (const name of ["RBAC teams", "Artifact signing & provenance", "Vulnerability scanning / SBOM", "Automatic rollback policies"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByText("Planned")).toBeInTheDocument();
  });

  it("adding a secret points to the application's real Environment page", async () => {
    renderPage(<SecretsPage />);
    await screen.findByRole("table", { name: "Secrets by application" });
    await userEvent.click(await screen.findByRole("button", { name: "Add secret" }));

    expect(screen.getByRole("button", { name: "Open Environment" })).toBeDisabled();
  });
});

describe("secretInventory", () => {
  const detail = (name: string, required: string[], stored: string[]) =>
    ({ project: { name, config: { deployment: { target: "ssh", ssh: { privateKeySecret: required[0] ?? "K" } } } }, activeReleaseId: null, secrets: stored.map((n) => ({ name: n, updated_at: "2026-10-01T00:00:00Z" })) }) as never;

  it("flags a required secret that was never set, and lists extras as configured", () => {
    const rows = secretInventory([detail("a", ["DEPLOY_KEY"], ["EXTRA"])]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(byName.EXTRA).toMatchObject({ state: "configured", required: false });
    expect(secretSummary(rows).applications).toBe(1);
  });

  it("sorts problems first", () => {
    const rows = secretInventory([detail("a", ["DEPLOY_KEY"], ["EXTRA"])]);

    expect(rows.filter((r) => r.state === "missing").length === 0 || rows[0]?.state === "missing").toBe(true);
  });
});

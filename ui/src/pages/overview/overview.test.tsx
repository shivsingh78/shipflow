import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Release } from "@/api/types";
import { renderPage } from "@/test/render";
import { healthBars, HEALTH_WINDOW, releaseMetrics } from "./health";
import OverviewPage from "./OverviewPage";

const release = (id: string, status: Release["status"], minutesAgo: number, durationMin: number): Release =>
  ({
    release_id: id,
    status,
    mode: "deploy",
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    updated_at: new Date(Date.now() - (minutesAgo - durationMin) * 60_000).toISOString(),
  }) as Release;

describe("health bars", () => {
  it("are ordered oldest to newest and scale with duration", () => {
    const bars = healthBars([release("new", "FAILED", 5, 4), release("mid", "SUCCESS", 20, 2), release("old", "SUCCESS", 40, 1)]);

    expect(bars.map((b) => b.id)).toEqual(["old", "mid", "new"]);
    expect(bars.map((b) => b.status)).toEqual(["SUCCESS", "SUCCESS", "FAILED"]);
    expect(bars[2]!.heightPct).toBeGreaterThan(bars[1]!.heightPct);
    expect(bars[1]!.heightPct).toBeGreaterThan(bars[0]!.heightPct);
    expect(Math.max(...bars.map((b) => b.heightPct))).toBeLessThanOrEqual(90);
  });

  it("gives queued releases a short placeholder and never exceeds the window", () => {
    const [queued] = healthBars([release("q", "QUEUED", 0, 0)]);

    expect(queued!.durationMs).toBeNull();
    expect(queued!.heightPct).toBeLessThan(28);

    const many = Array.from({ length: 80 }, (_, i) => release(`r${i}`, "SUCCESS", i + 1, 1));

    expect(healthBars(many)).toHaveLength(HEALTH_WINDOW);
  });
});

describe("release metrics (derived from release records only)", () => {
  it("computes rates over FINISHED releases and ignores cancelled/queued/running", () => {
    const m = releaseMetrics([release("a", "SUCCESS", 60, 2), release("b", "SUCCESS", 50, 4), release("c", "FAILED", 40, 6), release("d", "CANCELLED", 30, 1), release("e", "RUNNING", 5, 0), release("f", "QUEUED", 1, 0)]);

    expect(m.finished).toBe(3);
    expect(m.successRatePct).toBe(66.7);
    expect(m.errorRatePct).toBe(33.3);
    expect(m.medianDurationMs).toBe(4 * 60_000);
  });

  it("takes the mean of the two middle durations for an even count", () => {
    expect(releaseMetrics([release("a", "SUCCESS", 30, 2), release("b", "FAILED", 20, 4)]).medianDurationMs).toBe(3 * 60_000);
  });

  it("reports nothing rather than zero when there is no finished release", () => {
    const m = releaseMetrics([release("q", "QUEUED", 1, 0)]);

    expect(m).toMatchObject({ successRatePct: null, errorRatePct: null, medianDurationMs: null, throughputPerDay: null, finished: 0 });
    expect(releaseMetrics([])).toMatchObject({ successRatePct: null, throughputPerDay: null });
  });

  it("computes throughput across the window's span, at least one day", () => {
    const day = 24 * 60;

    expect(releaseMetrics([release("a", "SUCCESS", 2 * day, 1), release("b", "SUCCESS", 0, 1), release("c", "SUCCESS", day, 1), release("d", "SUCCESS", day, 1)]).throughputPerDay).toBe(2);
    expect(releaseMetrics([release("a", "SUCCESS", 10, 1), release("b", "SUCCESS", 5, 1)]).throughputPerDay).toBe(2);
  });
});

describe("Overview (Flowstep layout)", () => {
  it("shows the four headline stat cards from real data", async () => {
    renderPage(<OverviewPage />);

    const stats = await screen.findByRole("list", { name: "Headline numbers" });

    for (const label of ["Applications", "Success rate", "Running builds", "Failed deploys"]) expect(await within(stats).findByText(label)).toBeInTheDocument();
    expect(within(stats).getAllByRole("listitem")).toHaveLength(4);
  });

  it("shows the deployment pulse with a text alternative and derived numbers, labelled as derived", async () => {
    renderPage(<OverviewPage />);

    const pulse = (await screen.findByRole("heading", { name: "Deployment pulse" })).closest("section")!;

    expect(await within(pulse).findByRole("img", { name: /succeeded and \d+ failed in the last \d+ releases/ })).toBeInTheDocument();
    for (const label of ["Median duration", "Throughput", "Error rate"]) expect(within(pulse).getByText(label)).toBeInTheDocument();
    expect(within(pulse).getByText(/Derived from release history/)).toBeInTheDocument();
  });

  it("keeps the real readiness and attention cards, and labels roadmap items as planned", async () => {
    renderPage(<OverviewPage />);

    expect(await screen.findByRole("heading", { name: "System readiness" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /needs attention|all clear/i })).toBeInTheDocument();

    const future = (await screen.findByRole("heading", { name: "Future capabilities" })).closest("section")!;

    expect(within(future).getByText(/not active in this workspace/)).toBeInTheDocument();
    for (const name of ["Preview environments", "SBOM generation", "Canary releases"]) expect(within(future).getByText(name)).toBeInTheDocument();
  });

  it("links the recent releases to the Pipelines list", async () => {
    renderPage(<OverviewPage />);

    const recent = (await screen.findByRole("heading", { name: "Recent releases" })).closest("section")!;

    expect(within(recent).getByRole("link", { name: /view all/i })).toHaveAttribute("href", "/pipelines");
  });

  it("offers the primary actions from the page header, with the application picker inside the Deploy dialog", async () => {
    renderPage(<OverviewPage />);

    expect(await screen.findByRole("link", { name: /new application/i })).toHaveAttribute("href", "/applications/new");
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Application to deploy")).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: /deploy…/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByRole("combobox", { name: /application/i })).toBeInTheDocument();
  });
});

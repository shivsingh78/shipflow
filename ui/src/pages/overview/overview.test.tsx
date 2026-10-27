import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Release } from "@/api/types";
import { renderPage } from "@/test/render";
import { healthBars, HEALTH_WINDOW } from "./health";
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

describe("Overview (design reference layout)", () => {
  it("shows the eyebrow, the four headline numbers inside Deploy health, and the real side cards", async () => {
    renderPage(<OverviewPage />);

    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(await screen.findByText(/· self-hosted/i)).toBeInTheDocument();

    const health = (await screen.findByRole("heading", { name: "Deploy health" })).closest("section")!;

    for (const label of ["Applications", "Successful builds", "Failed builds", "Running / queued"]) {
      expect(await within(health).findByText(label)).toBeInTheDocument();
    }

    // The chart is an image with a text alternative built from the same data.
    expect(await within(health).findByRole("img", { name: /succeeded and \d+ failed in the last \d+ releases/ })).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "System readiness" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /needs attention|all clear/i })).toBeInTheDocument();
  });

  it("offers the primary actions from the page header, with the application picker inside the Deploy dialog", async () => {
    renderPage(<OverviewPage />);

    expect(await screen.findByRole("link", { name: /new application/i })).toHaveAttribute("href", "/applications/new");
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();

    // No application dropdown sits in the header itself.
    expect(screen.queryByLabelText("Application to deploy")).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: /deploy…/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByRole("combobox", { name: /application/i })).toBeInTheDocument();
  });
});

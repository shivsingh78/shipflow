import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderPage } from "@/test/render";
import { AppShell } from "./AppShell";
import { ThemeProvider } from "./Theme";
import { crumbsFor } from "./Breadcrumbs";

const shell = (route: string) =>
  renderPage(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="*" element={<div>page body</div>} />
      </Route>
    </Routes>,
    { route }
  );

describe("app shell (design reference)", () => {
  it("is dark-only", () => {
    render(
      <ThemeProvider>
        <span>x</span>
      </ThemeProvider>
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
    // There is no theme switch anywhere in the shell.
    shell("/overview");
    expect(screen.queryByRole("button", { name: /theme/i })).not.toBeInTheDocument();
  });

  it("shows the brand, grouped navigation with disabled 'Soon' items, and the real system status", async () => {
    shell("/overview");

    expect(screen.getAllByText("ShipFlow").length).toBeGreaterThan(0);
    for (const group of ["Workspace", "Infrastructure", "Operations", "Administration"]) expect(screen.getByText(group)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Applications" })).toHaveAttribute("href", "/applications");

    // Unavailable features are labelled and are not links.
    expect(screen.queryByRole("link", { name: /^Projects/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("Soon")).toHaveLength(2);

    // The footer reports the API's readiness checks, not a hard-coded claim.
    expect(await screen.findByText("all systems nominal")).toBeInTheDocument();
  });

  it("has a search trigger, an application switcher and no page-level 'New application' in the top bar", async () => {
    shell("/overview");

    expect(screen.getByRole("button", { name: /search releases, applications and pages/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /switch application/i }));

    const menu = await screen.findByRole("menu");

    expect(await within(menu).findByRole("menuitem", { name: /orders-api/i })).toHaveAttribute("href", "/applications/orders-api");
    expect(screen.queryByRole("link", { name: /new application/i })).not.toBeInTheDocument();
  });

  it("shows breadcrumbs below the top bar on inner pages but not on Overview", () => {
    const { unmount } = shell("/overview");

    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).not.toBeInTheDocument();
    unmount();

    shell("/applications/orders-api/logs");

    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(crumbsFor("/applications/orders-api/logs").map((c) => c.label)).toEqual(["Applications", "orders-api", "Build Logs"]);
  });
});


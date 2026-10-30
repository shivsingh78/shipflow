import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderPage } from "@/test/render";
import { AppShell } from "./AppShell";
import { crumbsFor } from "./Breadcrumbs";
import { NAV, NAV_ROUTES, activeEntry, isItemActive } from "./nav";

const shell = (route: string) =>
  renderPage(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="*" element={<div>page body</div>} />
      </Route>
    </Routes>,
    { route }
  );

const sidebar = () => screen.getByRole("complementary", { name: "Primary" });

describe("app shell (Flowstep reference)", () => {
  it("shows the brand and the navigation in the approved order", () => {
    shell("/overview");

    expect(within(sidebar()).getByRole("link", { name: "ShipFlow overview" })).toHaveAttribute("href", "/overview");
    expect(NAV.map((item) => item.label)).toEqual(["Overview", "Applications", "Pipelines", "Deployments", "Infrastructure", "Build Runs", "RepoPilot", "Activity", "Settings"]);
    expect(NAV.find((item) => item.label === "Infrastructure")?.children?.map((c) => c.label)).toEqual(["Servers", "Registries", "Domains"]);
    expect(NAV.find((item) => item.label === "Settings")?.children?.map((c) => c.label)).toEqual(["Secrets", "Account"]);

    for (const item of NAV) expect(within(sidebar()).getByRole("link", { name: item.label })).toHaveAttribute("href", item.to);
  });

  it("has no 'Soon' placeholders or group captions any more", () => {
    shell("/overview");

    expect(screen.queryByText("Soon")).not.toBeInTheDocument();
    for (const caption of ["Workspace", "Operations", "Administration"]) expect(screen.queryByText(caption)).not.toBeInTheDocument();
  });

  it("opens Infrastructure's pages when you are inside it and marks the current one", () => {
    shell("/registries");

    const nav = within(sidebar());

    expect(nav.getByRole("link", { name: "Servers" })).toHaveAttribute("href", "/servers");
    expect(nav.getByRole("link", { name: "Registries" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "Domains" })).toHaveAttribute("href", "/domains");
    expect(nav.getByRole("link", { name: "Infrastructure" })).not.toHaveAttribute("aria-current");
    expect(nav.queryByRole("link", { name: "Secrets" })).not.toBeInTheDocument();
  });

  it("opens Settings' pages under /settings/secrets and /account", () => {
    const { unmount } = shell("/settings/secrets");

    expect(within(sidebar()).getByRole("link", { name: "Secrets" })).toHaveAttribute("aria-current", "page");
    expect(within(sidebar()).getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account");
    unmount();

    shell("/account");
    expect(within(sidebar()).getByRole("link", { name: "Account" })).toHaveAttribute("aria-current", "page");
  });

  it("lets you expand a collapsed group by hand", async () => {
    shell("/overview");

    const toggle = within(sidebar()).getByRole("button", { name: "Expand Infrastructure" });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(sidebar()).getByRole("link", { name: "Servers" })).toBeInTheDocument();
  });

  it("lights Pipelines for a release's detail page, which Pipelines owns", () => {
    shell("/releases/Zp3tY9cE");

    expect(within(sidebar()).getByRole("link", { name: "Pipelines" })).toHaveAttribute("aria-current", "page");
  });

  it("reports the real system status from the API's readiness checks", async () => {
    shell("/overview");

    expect(await screen.findByText("all systems nominal")).toBeInTheDocument();
  });

  it("has a search trigger, an application switcher and a theme control in the header", async () => {
    shell("/overview");

    expect(screen.getByRole("button", { name: /search releases, applications and pages/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Theme:/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /switch application/i }));

    const menu = await screen.findByRole("menu");

    expect(await within(menu).findByRole("menuitem", { name: /orders-api/i })).toHaveAttribute("href", "/applications/orders-api");
    expect(screen.queryByRole("link", { name: /new application/i })).not.toBeInTheDocument();
  });

  it("shows the page title as breadcrumbs inside the header, including on Overview", () => {
    const { unmount } = shell("/overview");

    expect(within(screen.getByRole("banner")).getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Overview");
    unmount();

    shell("/applications/orders-api/logs");

    expect(within(screen.getByRole("banner")).getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Applications/orders-api/Build Logs");
  });
});

describe("breadcrumbs", () => {
  it("name every route, with new parents for the pages that moved under a section", () => {
    const labels = (path: string) => crumbsFor(path).map((c) => c.label);

    expect(labels("/applications/orders-api/logs")).toEqual(["Applications", "orders-api", "Build Logs"]);
    expect(labels("/pipelines")).toEqual(["Pipelines"]);
    expect(labels("/releases/r_01842")).toEqual(["Pipelines", "Release r_01842"]);
    expect(crumbsFor("/releases/r_01842")[0]?.to).toBe("/pipelines");
    expect(labels("/servers")).toEqual(["Infrastructure", "Servers"]);
    expect(labels("/registries")).toEqual(["Infrastructure", "Registries"]);
    expect(labels("/domains")).toEqual(["Infrastructure", "Domains"]);
    expect(labels("/infrastructure")).toEqual(["Infrastructure"]);
    expect(labels("/settings/secrets")).toEqual(["Settings", "Secrets"]);
    expect(labels("/account")).toEqual(["Settings", "Account"]);
    expect(labels("/repopilot/runs/7")).toEqual(["RepoPilot", "Run #7"]);
    expect(labels("/build-runs")).toEqual(["Build Runs"]);
  });
});

describe("navigation keeps every existing URL reachable", () => {
  const ROUTES_THAT_EXISTED = ["/overview", "/applications", "/deployments", "/build-runs", "/servers", "/registries", "/domains", "/activity", "/logs", "/settings", "/account", "/repopilot"];

  it("lists each previous page in the command menu or sidebar", () => {
    const reachable = new Set(NAV_ROUTES.map((route) => route.to));

    for (const route of ROUTES_THAT_EXISTED) expect(reachable.has(route), route).toBe(true);
    for (const route of ["/pipelines", "/infrastructure", "/settings/secrets"]) expect(reachable.has(route), route).toBe(true);
  });

  it("matches sections by whole path segments, never by prefix", () => {
    const apps = NAV.find((item) => item.label === "Applications");
    const settings = NAV.find((item) => item.label === "Settings");

    if (!apps || !settings) throw new Error("missing nav items");

    expect(isItemActive("/applications/orders-api/logs", apps)).toBe(true);
    expect(isItemActive("/applications-archive", apps)).toBe(false);
    expect(activeEntry("/settings/secrets", settings)).toBe("/settings/secrets");
    expect(activeEntry("/settings", settings)).toBe("/settings");
    expect(activeEntry("/settingsx", settings)).toBeNull();
  });
});

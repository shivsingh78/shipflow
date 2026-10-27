import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderPage } from "@/test/render";
import ActivityPage from "../activity/ActivityPage";
import LogsPage from "../logs/LogsPage";
import OverviewPage from "../overview/OverviewPage";
import BuildRunsPage from "./BuildRunsPage";
import DeploymentsPage from "./DeploymentsPage";
import ReleaseDetailPage from "./ReleaseDetailPage";

const detail = (id: string) => renderPage(<ReleaseDetailPage />, { route: `/releases/${id}`, path: "/releases/:releaseId" });

describe("Build Runs", () => {
  it("lists every release and filters by type and status", async () => {
    const user = userEvent.setup();

    renderPage(<BuildRunsPage />);

    expect(await screen.findByRole("link", { name: "Cq2rF5gH" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kd8mW2vB" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Type"), "check");
    expect(screen.getByRole("link", { name: "Cq2rF5gH" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Kd8mW2vB" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.selectOptions(screen.getByLabelText("Status"), "FAILED");
    expect(screen.getByRole("link", { name: "Zp3tY9cE" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Kd8mW2vB" })).not.toBeInTheDocument();
  });

  it("searches by commit-less text and reports no match", async () => {
    const user = userEvent.setup();

    renderPage(<BuildRunsPage />);
    await screen.findByRole("link", { name: "Kd8mW2vB" });
    await user.type(screen.getByRole("searchbox", { name: "Search releases" }), "zzzz");
    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
  });
});

describe("Deployments", () => {
  it("excludes check runs and supports Live only", async () => {
    const user = userEvent.setup();

    renderPage(<DeploymentsPage />);
    await screen.findByRole("link", { name: "Kd8mW2vB" });
    expect(screen.queryByRole("link", { name: "Cq2rF5gH" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Live only" }));
    expect(screen.getByRole("link", { name: "Kd8mW2vB" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Zp3tY9cE" })).not.toBeInTheDocument();
  });
});

describe("Release detail", () => {
  it("separates build, artifact, deployment and source", async () => {
    detail("Kd8mW2vB");

    expect(await screen.findByRole("heading", { name: "Build" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Artifact" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deployment" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Source" })).toBeInTheDocument();
    expect(screen.getByText("Container image")).toBeInTheDocument();
    expect(screen.getByText("Image digest")).toBeInTheDocument();
    expect(screen.getAllByText("Live").length).toBeGreaterThanOrEqual(2);
  });

  it("states that a check run never deploys", async () => {
    detail("Cq2rF5gH");

    expect(await screen.findByText(/Not deployed: this was a check run/)).toBeInTheDocument();
    expect(screen.getByText(/check runs build and test but never store an artifact/i)).toBeInTheDocument();
  });

  it("shows the failure diagnosis for a failed release", async () => {
    detail("Xw1yU6iO");

    expect(await screen.findByText(/The build or dependency install failed/)).toBeInTheDocument();
  });

  it("switches to the logs tab", async () => {
    const user = userEvent.setup();

    detail("Zp3tY9cE");
    await user.click(await screen.findByRole("tab", { name: "Logs" }));
    expect(await screen.findByRole("region", { name: /Logs for release Zp3tY9cE/ })).toBeInTheDocument();
  });

  it("shows a friendly not-found", async () => {
    detail("nope");

    expect(await screen.findByText("Release not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to build runs/ })).toBeInTheDocument();
  });
});

describe("Activity, Logs and Overview", () => {
  it("labels the activity feed as derived and groups by day", async () => {
    renderPage(<ActivityPage />);

    expect(screen.getByText("Derived from release records")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
  });

  it("opens the release from ?release= in the logs page", async () => {
    renderPage(<LogsPage />, { route: "/logs?release=Zp3tY9cE" });

    expect(await screen.findByRole("region", { name: /Logs for release Zp3tY9cE/ })).toBeInTheDocument();
  });

  it("shows real counts, readiness and attention on the overview", async () => {
    renderPage(<OverviewPage />);

    expect(await screen.findByText("Successful builds")).toBeInTheDocument();
    expect(await screen.findByText("database")).toBeInTheDocument();

    const attention = (await screen.findByRole("heading", { name: "Needs attention" })).closest("section")!;

    expect(await within(attention).findByText(/Missing secret: STRIPE_KEY/)).toBeInTheDocument();
  });
});

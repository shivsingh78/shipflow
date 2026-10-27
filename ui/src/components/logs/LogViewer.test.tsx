import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPage } from "@/test/render";
import { LogViewer } from "./LogViewer";

afterEach(() => vi.restoreAllMocks());

describe("LogViewer", () => {
  it("shows lines of a finished release with no polling note", async () => {
    renderPage(<LogViewer releaseId="Zp3tY9cE" />);

    expect(await screen.findByText(/Live check failed after activation/)).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/no longer refreshing/)).toBeInTheDocument();
    expect(screen.getByText(/lines?$/)).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it("filters by level and search, highlighting matches", async () => {
    const user = userEvent.setup();

    renderPage(<LogViewer releaseId="Zp3tY9cE" />);
    await screen.findByText(/Live check failed after activation/);

    await user.click(screen.getByRole("button", { name: "ERROR" }));
    expect(screen.queryByText(/Cloning/)).not.toBeInTheDocument();
    expect(screen.getByText(/Live check failed/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ERROR" }));
    await user.type(screen.getByRole("searchbox", { name: "Search logs" }), "cloning");

    const region = screen.getByRole("region", { name: /Logs for release/ });

    expect(within(region).getAllByText(/cloning/i, { selector: "mark" }).length).toBeGreaterThan(0);
    expect(within(region).queryByText(/Package manager/)).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "Search logs" }));
    await user.type(screen.getByRole("searchbox", { name: "Search logs" }), "zzz-no-match");
    expect(screen.getByText("No lines match the current filters.")).toBeInTheDocument();
  });

  it("explains a queued release and states the polling interval honestly", async () => {
    renderPage(<LogViewer releaseId="Wi7fA5vM" />);

    expect(await screen.findByText(/waiting for a worker/)).toBeInTheDocument();
    expect(screen.getByText(/Auto-refreshing every 2s while the release runs/)).toBeInTheDocument();
  });

  it("follows the tail by default only while running and can be toggled", async () => {
    const user = userEvent.setup();

    renderPage(<LogViewer releaseId="Rn4pQ7xA" />);

    const follow = await screen.findByRole("checkbox", { name: "Follow tail" });

    await waitFor(() => expect(follow).toBeChecked());
    await user.click(follow);
    expect(follow).not.toBeChecked();
  });

  it("downloads the filtered lines as a .txt Blob", async () => {
    const user = userEvent.setup();
    let blob: Blob | undefined;

    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    renderPage(<LogViewer releaseId="Zp3tY9cE" />);
    await screen.findByText(/Live check failed after activation/);
    await user.click(screen.getByRole("button", { name: "ERROR" }));
    await user.click(screen.getByRole("button", { name: /Download/ }));

    expect(blob).toBeDefined();
    expect(blob!.type).toContain("text/plain");
    expect(blob!.size).toBeGreaterThan(0);
  });

  it("offers a retry when logs fail to load", async () => {
    renderPage(<LogViewer releaseId="does-not-exist" />);

    expect(await screen.findByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });
});

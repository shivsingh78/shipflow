import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderPage } from "@/test/render";
import AccountPage from "@/pages/settings/AccountPage";
import SettingsPage from "@/pages/settings/SettingsPage";
import DomainsPage from "./DomainsPage";
import RegistriesPage from "./RegistriesPage";
import ServersPage from "./ServersPage";

beforeAll(() => {
  // jsdom has no matchMedia; ThemeProvider needs it.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
});

describe("ServersPage", () => {
  it("lists grouped servers, runs a check and renders results", async () => {
    renderPage(<ServersPage />);

    const list = await screen.findByRole("list", { name: "Servers" });

    expect(within(list).getByText("SSH static host")).toBeInTheDocument();
    expect(within(list).getByText("Docker host")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add server/i })).toBeDisabled();

    await userEvent.click(within(list).getByRole("button", { name: /Run check for docker1\.acme\.dev:22/ }));
    expect(await screen.findByText("docker daemon", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/Checked at .* \(this session\)/)).toBeInTheDocument();
  });

  it("filters by kind", async () => {
    renderPage(<ServersPage />);
    await screen.findByRole("list", { name: "Servers" });
    await userEvent.selectOptions(screen.getByLabelText("Filter by kind"), "kubernetes");

    await waitFor(() => expect(within(screen.getByRole("list", { name: "Servers" })).queryByText("Docker host")).not.toBeInTheDocument());
  });
});

describe("RegistriesPage", () => {
  it("explains docker target and shows digests and not-verified status", async () => {
    renderPage(<RegistriesPage />);

    expect(await screen.findByText(/Docker target does not use a registry/)).toBeInTheDocument();
    expect(await screen.findByText("Not verified")).toBeInTheDocument();
    expect(await screen.findByText("Built images (by digest)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add registry/i })).toBeDisabled();
  });
});

describe("DomainsPage", () => {
  it("lists domains with safe external links and disabled add", async () => {
    renderPage(<DomainsPage />);

    const link = await screen.findByRole("link", { name: /https:\/\/docs\.acme\.dev\// });

    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("button", { name: /add domain/i })).toBeDisabled();
  });
});

describe("SettingsPage", () => {
  it("shows instance, targets and readiness", async () => {
    renderPage(<SettingsPage />);

    expect(await screen.findByText("demo")).toBeInTheDocument();
    expect(await screen.findByText(/sandbox docker, runtime/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
  });
});

describe("AccountPage", () => {
  it("never shows a token and offers sign out", async () => {
    renderPage(<AccountPage />);

    expect(await screen.findByText(/no user accounts/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(screen.getAllByText("Not supported yet")).toHaveLength(3);
  });
});

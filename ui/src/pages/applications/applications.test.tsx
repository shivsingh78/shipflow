import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { renderPage } from "@/test/render";
import ApplicationsPage from "./ApplicationsPage";
import ApplicationDetailPage from "./ApplicationDetailPage";
import CreateApplicationPage from "./CreateApplicationPage";
import ConfigurationTab from "./tabs/ConfigurationTab";
import EnvironmentTab from "./tabs/EnvironmentTab";
import OverviewTab from "./tabs/OverviewTab";
import SettingsTab from "./tabs/SettingsTab";
import { DRAFT_KEY } from "./lib/draftStorage";

// jsdom has no native <dialog> modal support.
beforeAll(() => {
  const proto = HTMLDialogElement.prototype;

  if (!Reflect.has(proto, "showModal")) {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

function Detail() {
  return (
    <Routes>
      <Route path="/applications/:name" element={<ApplicationDetailPage />}>
        <Route index element={<OverviewTab />} />
        <Route path="configuration" element={<ConfigurationTab />} />
        <Route path="environment" element={<EnvironmentTab />} />
        <Route path="settings" element={<SettingsTab />} />
      </Route>
    </Routes>
  );
}

describe("ApplicationsPage", () => {
  it("lists applications, filters, and remembers the layout", async () => {
    const user = userEvent.setup();

    renderPage(<ApplicationsPage />, { route: "/applications" });

    expect(await screen.findByRole("link", { name: "orders-api" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New application" })).toHaveAttribute("href", "/applications/new");
    // Required secret STRIPE_KEY is missing in the demo data.
    expect(await screen.findByText("1 secret missing")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filter by target"), "docker");
    expect(screen.queryByRole("link", { name: "marketing-site" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "worker-app" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filter by target"), "all");
    await user.type(screen.getByLabelText("Search applications"), "docs");
    expect(screen.getByRole("link", { name: "docs-portal" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "orders-api" })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search applications"));
    await user.click(screen.getByRole("button", { name: /Cards/ }));
    expect(localStorage.getItem("shipflow.applications.view")).toBe("cards");
    expect(screen.getByRole("article", { name: "billing-service" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filter by status"), "never");
    expect(screen.getByText("No applications match")).toBeInTheDocument();
  });

  it("opens external repository links safely", async () => {
    renderPage(<ApplicationsPage />, { route: "/applications" });

    const link = (await screen.findAllByRole("link", { name: /acme\/orders-api/ }))[0];

    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });
});

describe("Create application wizard", () => {
  it("validates each step before moving on and keeps state when going back", async () => {
    const user = userEvent.setup();

    renderPage(<CreateApplicationPage />, { route: "/applications/new" });

    await screen.findByLabelText(/Application name/);
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findAllByText(/is required/)).toHaveLength(2);
    expect(screen.getByText(/Step 1 of 6/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Application name/), "new-app");
    await user.type(screen.getByLabelText(/Repository URL/), "https://github.com/other/new-app");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findAllByText(/not allowed on this server/)).not.toHaveLength(0);

    await user.clear(screen.getByLabelText(/Repository URL/));
    await user.type(screen.getByLabelText(/Repository URL/), "https://github.com/acme/new-app");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText(/Step 2 of 6/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Branch & source/ })).toHaveAttribute("aria-current", "step");

    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByLabelText(/Application name/)).toHaveValue("new-app");
  });

  it("enforces runtime port for image targets and shows the experimental label", async () => {
    const user = userEvent.setup();

    renderPage(<CreateApplicationPage />, { route: "/applications/new" });

    await user.type(await screen.findByLabelText(/Application name/), "img-app");
    await user.type(screen.getByLabelText(/Repository URL/), "https://github.com/acme/img-app");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("radio", { name: /Docker/ }));
    expect(screen.getAllByText(/Experimental: not verified on a real cluster/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByLabelText(/Container port/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect((await screen.findAllByText(/is required/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Step 4 of 6/)).toBeInTheDocument();
  });

  it("walks to review, previews the YAML, creates, and sets a secret write-only", async () => {
    const user = userEvent.setup();

    renderPage(<CreateApplicationPage />, { route: "/applications/new" });

    await user.type(await screen.findByLabelText(/Application name/), "walk-app");
    await user.type(screen.getByLabelText(/Repository URL/), "https://github.com/acme/walk-app");
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("button", { name: /Next/ }));
    await user.click(await screen.findByRole("radio", { name: /SSH server/ }));
    await user.click(screen.getByRole("button", { name: /Next/ }));

    await user.type(await screen.findByLabelText(/^Host/), "vps.acme.dev");
    await user.type(screen.getByLabelText(/Remote path/), "/srv/walk-app");
    await user.type(screen.getByLabelText(/Public URL/), "https://walk.acme.dev/");
    await user.type(screen.getByLabelText(/Server host key/), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
    await user.click(screen.getByRole("button", { name: /Next/ }));

    const preview = await screen.findByLabelText("Generated shipflow.yml");

    expect(preview.textContent).toContain("name: walk-app");
    expect(preview.textContent).toContain("target: ssh");
    expect(screen.getAllByText("SSH_PRIVATE_KEY").length).toBeGreaterThan(0);
    // The draft stored so far has no secret values.
    expect(sessionStorage.getItem(DRAFT_KEY)).not.toContain("BEGIN");

    await user.click(screen.getByRole("button", { name: /Continue to create/ }));
    await user.click(await screen.findByRole("button", { name: "Create application" }));
    expect(await screen.findByText(/Application walk-app created/)).toBeInTheDocument();
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();

    const deploy = screen.getByRole("button", { name: /Deploy now/ });

    expect(deploy).toBeDisabled();

    const secret = "-----BEGIN OPENSSH PRIVATE KEY-----topsecret";

    await user.type(screen.getByLabelText("Value for SSH_PRIVATE_KEY"), secret);
    await user.click(screen.getByRole("button", { name: "Save SSH_PRIVATE_KEY" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Deploy now/ })).toBeEnabled());
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("topsecret");
  });

  it("restores a draft without secrets and can start over", async () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ step: 1, draft: { name: "kept-app", repository: "https://github.com/acme/kept" } }));
    renderPage(<CreateApplicationPage />, { route: "/applications/new" });

    expect(await screen.findByLabelText(/Application name/)).toHaveValue("kept-app");
    await userEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByLabelText(/Application name/)).toHaveValue("");
  });
});

describe("Application detail", () => {
  it("shows a friendly not-found for an unknown application", async () => {
    renderPage(<Detail />, { route: "/applications/nope" });
    expect(await screen.findByText("Application not found")).toBeInTheDocument();
  });

  it("renders the overview with the missing-secret warning and honest health text", async () => {
    renderPage(<Detail />, { route: "/applications/billing-service" });

    expect(await screen.findByRole("heading", { name: /billing-service/ })).toBeInTheDocument();
    expect(await screen.findByText(/A required secret is not set/)).toBeInTheDocument();
    expect(screen.getAllByText(/Experimental: not verified on a real cluster/).length).toBeGreaterThan(0);
    expect(screen.getByText(/no continuous monitoring yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Environment Variables" })).toHaveAttribute("href", "/applications/billing-service/environment");

    await userEvent.click(screen.getByRole("button", { name: "Run target check" }));
    expect(await screen.findByText("kubernetes API")).toBeInTheDocument();
  });

  it("settings disables delete honestly", async () => {
    renderPage(<Detail />, { route: "/applications/docs-portal/settings" });

    const button = await screen.findByRole("button", { name: /Delete application/ });

    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/not available yet/);
  });
});

describe("Configuration editing", () => {
  it("shows validation problems next to fields and keeps the name immutable", async () => {
    const user = userEvent.setup();

    renderPage(<Detail />, { route: "/applications/docs-portal/configuration" });
    await user.click(await screen.findByRole("button", { name: "Edit configuration" }));

    expect(screen.getByLabelText(/Application name/)).toBeDisabled();

    const user_ = screen.getByLabelText(/^User/);

    await user.clear(user_);
    await user.type(user_, "root");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(await screen.findByText(/must not be root/)).toBeInTheDocument();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
  });

  it("saves a valid edit through PUT", async () => {
    const user = userEvent.setup();

    renderPage(<Detail />, { route: "/applications/docs-portal/configuration" });
    await user.click(await screen.findByRole("button", { name: "Edit configuration" }));

    const branch = screen.getByLabelText(/^Branch/);

    await user.clear(branch);
    await user.type(branch, "release");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(await screen.findByText("Configuration saved")).toBeInTheDocument();
  });
});

describe("Environment secrets", () => {
  it("lists required-missing secrets first and never keeps the value after saving", async () => {
    const user = userEvent.setup();

    renderPage(<Detail />, { route: "/applications/billing-service/environment" });

    const list = await screen.findByRole("list", { name: "Secrets" });
    const items = within(list).getAllByRole("listitem");

    expect(items[0]).toHaveTextContent("STRIPE_KEY");
    expect(items[0]).toHaveTextContent("Not set");

    await user.click(screen.getByRole("button", { name: "Set value of STRIPE_KEY" }));

    const field = await screen.findByLabelText("Value");

    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("type", "password");

    await user.type(field, "sk_live_supersecret");
    await user.click(screen.getByRole("button", { name: "Save STRIPE_KEY" }));

    await waitFor(() => expect(screen.queryByLabelText("Value")).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue("sk_live_supersecret")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sk_live_supersecret");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Secrets" })).getAllByRole("listitem").some((li) => /STRIPE_KEY/.test(li.textContent ?? "") && /Replace/.test(li.textContent ?? ""))).toBe(true));

    // Reopening to replace never prefills the stored value.
    await user.click(screen.getByRole("button", { name: "Replace value of STRIPE_KEY" }));
    expect(await screen.findByLabelText("Value")).toHaveValue("");
  });

  it("rejects an empty value and removes a secret after confirmation", async () => {
    const user = userEvent.setup();

    renderPage(<Detail />, { route: "/applications/orders-api/environment" });
    await user.click(await screen.findByRole("button", { name: "Replace value of DATABASE_URL" }));
    expect(await screen.findByRole("button", { name: "Save DATABASE_URL" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Remove DATABASE_URL" }));
    await user.click(await screen.findByRole("button", { name: "Remove secret" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Set value of DATABASE_URL" })).toBeInTheDocument());
  });

  it("surfaces secret-looking public variables as validator errors", async () => {
    const user = userEvent.setup();

    renderPage(<Detail />, { route: "/applications/marketing-site/environment" });
    await user.click(await screen.findByRole("button", { name: "Add variable" }));
    await user.type(screen.getByLabelText("Build environment name 2"), "API_TOKEN");
    await user.type(screen.getByLabelText("Build environment value 2"), "x");
    await user.click(screen.getByRole("button", { name: "Save variables" }));
    expect(await screen.findByText(/looks like a secret/)).toBeInTheDocument();
  });
});

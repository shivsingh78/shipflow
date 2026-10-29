import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ApiError } from "@/api/errors";
import type { RepoPilotApi, RepoPilotStatus, RpFinding, RpPatch, RpRun, RunDetail } from "@/api/repopilotTypes";
import { ToastProvider } from "@/components/ui";
import RepoPilotPage from "./RepoPilotPage";
import RunDetailPage from "./RunDetailPage";

const hoisted = vi.hoisted(() => ({ api: { repopilot: {} } }));

vi.mock("@/auth/AuthProvider", () => ({ useApi: () => hoisted.api }));

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const now = "2026-10-28T12:00:00Z";

const status = (extra: Partial<RepoPilotStatus> = {}): RepoPilotStatus => ({
  enabled: true, workers: 1, github: { configured: true },
  ai: { providers: ["anthropic"], configured: ["anthropic"], credentialEncryption: true, workerCanDecrypt: true },
  sandbox: { mode: "off", status: "off", note: "Verification is not running: patches will be reported as inconclusive." },
  problems: [], limitations: ["Findings are suggestions from an AI model, not confirmed defects."], ...extra,
});

const run = (extra: Partial<RpRun> = {}): RpRun => ({ id: 7, repo: { owner: "acme", name: "widgets", url: "https://github.com/acme/widgets" }, requestedRef: null, commitSha: SHA, defaultBranch: "main", state: "ready_for_review", failure: null, cancelRequested: false, ai: { requests: 2, inputTokens: 1500, outputTokens: 400 }, createdBy: "user:operator", createdAt: now, updatedAt: now, finishedAt: null, ...extra });

const finding = (extra: Partial<RpFinding> = {}): RpFinding => ({ id: 3, rank: 1, title: "Unchecked JSON.parse", category: "error-handling", severity: "high", evidenceKind: "observed", file: "src/index.js", lineStart: 1, lineEnd: 2, evidence: "JSON.parse(x) can throw.", impact: "Crash on bad input.", remediation: "Catch it.", modelConfidence: 0.7, ...extra });

const patch = (extra: Partial<RpPatch> = {}): RpPatch => ({ id: 9, findingId: 3, baseCommit: SHA, title: "Guard JSON.parse", explanation: "Wrap in try/catch.", diff: "diff --git a/src/index.js b/src/index.js\n--- a/src/index.js\n+++ b/src/index.js\n@@ -1 +1 @@\n-a\n+b\n", testDiff: "diff --git a/test/x.test.js b/test/x.test.js\n--- /dev/null\n+++ b/test/x.test.js\n@@ -0,0 +1 @@\n+test\n", diffSha256: DIGEST, policy: { passed: true, details: {} }, createdAt: now, ...extra });

const detail = (extra: Partial<RunDetail> = {}): RunDetail => ({ run: run(), stages: [{ stage: "ingest", attempt: 1, state: "succeeded", error: null, startedAt: now, finishedAt: now }], counts: { findings: 1, patches: 1 }, outcomes: [{ patchId: 9, outcome: "improved", reasons: [], details: {}, computedAt: now }], pullRequest: null, limitations: [], ...extra });

function makeApi(over: Partial<RepoPilotApi> = {}): RepoPilotApi {
  return {
    status: vi.fn().mockResolvedValue(status()),
    listRepositories: vi.fn().mockResolvedValue([{ owner: "acme", name: "widgets", authorizedBy: "user:operator", authorizedAt: now }]),
    authorizeRepository: vi.fn().mockResolvedValue(undefined),
    revokeRepository: vi.fn().mockResolvedValue(undefined),
    listCredentials: vi.fn().mockResolvedValue([{ provider: "anthropic", fingerprint: "0123456789abcdef", updatedAt: now }]),
    setCredential: vi.fn().mockResolvedValue(undefined),
    deleteCredential: vi.fn().mockResolvedValue(undefined),
    listRuns: vi.fn().mockResolvedValue([]),
    createRun: vi.fn().mockResolvedValue(run({ id: 12, state: "queued" })),
    getRun: vi.fn().mockResolvedValue(detail()),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    listFindings: vi.fn().mockResolvedValue([finding()]),
    requestPatch: vi.fn().mockResolvedValue(undefined),
    listPatches: vi.fn().mockResolvedValue([patch()]),
    getVerifications: vi.fn().mockResolvedValue({ verifications: [], outcomes: [] }),
    listLogs: vi.fn().mockResolvedValue([]),
    authorizePullRequest: vi.fn().mockResolvedValue({ run: run({ state: "pr_authorized" }), pullRequest: {} }),
    ...over,
  };
}

/** The API double, with every method typed as a mock so assertions can inspect calls. */
function setApi(over: Partial<RepoPilotApi> = {}): Record<keyof RepoPilotApi, Mock> {
  const repopilot = makeApi(over);

  hoisted.api = { repopilot };

  return repopilot as unknown as Record<keyof RepoPilotApi, Mock>;
}

const page = (element: React.ReactElement, route = "/", path = "*") =>
  render(<ToastProvider><MemoryRouter initialEntries={[route]}><Routes><Route path={path} element={element} /></Routes></MemoryRouter></ToastProvider>);

const detailPage = (id = "7") => page(<RunDetailPage />, `/repopilot/runs/${id}`, "/repopilot/runs/:runId");

beforeEach(() => {
  hoisted.api = { repopilot: makeApi() };
});

describe("RepoPilot page", () => {
  it("shows a loading state, then the workspace", async () => {
    setApi();
    page(<RepoPilotPage />);

    expect(screen.getByText("Checking RepoPilot")).toBeInTheDocument();
    expect(await screen.findByText("Start an analysis")).toBeInTheDocument();
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
  });

  it("explains how to enable it when it is off, and offers no actions", async () => {
    setApi({ status: vi.fn().mockResolvedValue({ enabled: false, message: "RepoPilot is disabled on this server.", problems: ["REPOPILOT_SANDBOX=docker is not supported"], limitations: [] }) });
    page(<RepoPilotPage />);

    expect(await screen.findByText("RepoPilot is off")).toBeInTheDocument();
    expect(screen.getByText(/REPOPILOT=enabled/)).toBeInTheDocument();
    expect(screen.getByText(/REPOPILOT_SANDBOX=docker is not supported/)).toBeInTheDocument();
    expect(screen.queryByText("Start an analysis")).not.toBeInTheDocument();
  });

  it("shows an error with retry when the status cannot be loaded", async () => {
    const api = setApi({ status: vi.fn().mockRejectedValueOnce(new ApiError("Forbidden", 403)).mockResolvedValue(status()) });
    page(<RepoPilotPage />);

    expect(await screen.findByText("Could not reach RepoPilot")).toBeInTheDocument();
    expect(screen.getByText("Forbidden")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(await screen.findByText("Start an analysis")).toBeInTheDocument();
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it("says plainly that no tests run while the sandbox is off", async () => {
    setApi();
    page(<RepoPilotPage />);

    expect(await screen.findByText("Test verification is not running")).toBeInTheDocument();
    expect(screen.getByText(/labelled inconclusive/)).toBeInTheDocument();
  });

  it("warns when the worker lacks GitHub access or no worker runs", async () => {
    setApi({ status: vi.fn().mockResolvedValue(status({ workers: 1, github: { configured: false } })) });
    page(<RepoPilotPage />);
    expect(await screen.findByText("GitHub access is not configured")).toBeInTheDocument();
  });

  it("blocks starting an analysis until a repository and the user's own AI key exist", async () => {
    setApi({ listCredentials: vi.fn().mockResolvedValue([]) });
    page(<RepoPilotPage />);

    expect(await screen.findByText("Store your AI key first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyse" })).toBeDisabled();
  });

  it("stores the AI key write-only and clears the field", async () => {
    const api = setApi({ listCredentials: vi.fn().mockResolvedValue([]) });
    const user = userEvent.setup();

    page(<RepoPilotPage />);

    const field = await screen.findByLabelText(/Anthropic API key/);
    await user.type(field, "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    await user.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() => expect(api.setCredential).toHaveBeenCalledWith("anthropic", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"));
    await waitFor(() => expect(field).toHaveValue(""));
    expect(screen.queryByText(/sk-ant-api03/)).not.toBeInTheDocument();
  });

  it("starts an analysis for an authorised repository", async () => {
    const api = setApi();
    const user = userEvent.setup();

    page(<RepoPilotPage />);
    // The list loads after the form first renders; wait until the option exists and the field is usable.
    await screen.findByRole("option", { name: "acme/widgets" });
    await waitFor(() => expect(screen.getByLabelText("Repository")).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("Repository"), "acme/widgets");
    await user.click(screen.getByRole("button", { name: "Analyse" }));

    await waitFor(() => expect(api.createRun).toHaveBeenCalledWith({ repoUrl: "https://github.com/acme/widgets" }));
  });

  it("lists runs with their real state", async () => {
    setApi({ listRuns: vi.fn().mockResolvedValue([run({ id: 5, state: "failed" }), run({ id: 6, state: "ready_for_review" })]) });
    page(<RepoPilotPage />);

    expect(await screen.findByRole("link", { name: "#6" })).toBeInTheDocument();
    expect(screen.getByText("Ready for your review")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});

describe("Run detail", () => {
  it("rejects a malformed run id without calling the API", async () => {
    const api = setApi();

    detailPage("abc");
    expect(await screen.findByText("Run not found")).toBeInTheDocument();
    expect(api.getRun).not.toHaveBeenCalled();
  });

  it("labels findings as AI suggestions and the confidence as the model's estimate", async () => {
    setApi({ getRun: vi.fn().mockResolvedValue(detail({ run: run({ state: "awaiting_patch" }), outcomes: [] })), listPatches: vi.fn().mockResolvedValue([]) });
    detailPage();

    expect(await screen.findByText(/Unchecked JSON.parse/)).toBeInTheDocument();
    expect(screen.getByText(/AI suggestion/)).toBeInTheDocument();
    expect(screen.getByText(/an estimate, not a measurement/)).toBeInTheDocument();
    expect(screen.getByText(/not confirmed defects/)).toBeInTheDocument();
    expect(screen.getByText("cited as observed")).toBeInTheDocument();
  });

  it("requests a patch for a chosen finding", async () => {
    const api = setApi({ getRun: vi.fn().mockResolvedValue(detail({ run: run({ state: "awaiting_patch" }), outcomes: [] })), listPatches: vi.fn().mockResolvedValue([]) });
    const user = userEvent.setup();

    detailPage();
    await user.click(await screen.findByRole("button", { name: "Generate a patch for this" }));
    await waitFor(() => expect(api.requestPatch).toHaveBeenCalledWith(7, 3));
  });

  it("shows the server's actionable message when no AI key is stored", async () => {
    setApi({
      getRun: vi.fn().mockResolvedValue(detail({ run: run({ state: "awaiting_patch" }), outcomes: [] })),
      listPatches: vi.fn().mockResolvedValue([]),
      requestPatch: vi.fn().mockRejectedValue(new ApiError("Add your own AI provider key first.", 409, [], "ai_credentials_missing")),
    });
    detailPage();

    await userEvent.click(await screen.findByRole("button", { name: "Generate a patch for this" }));
    expect(await screen.findByText("Add your own AI provider key first.")).toBeInTheDocument();
  });

  it("separates 'patch generated', 'validated', 'verification' and 'pull request opened'", async () => {
    setApi();
    detailPage();

    const ladder = await screen.findByRole("list", { name: "Status of the proposal" });

    expect(within(ladder).getByText("Patch generated")).toBeInTheDocument();
    expect(within(ladder).getByText("Patch validated")).toBeInTheDocument();
    expect(within(ladder).getByText("Verification")).toBeInTheDocument();
    expect(within(ladder).getByText("Pull request opened")).toBeInTheDocument();
    expect(within(ladder).getByText(/does not mean it is correct/)).toBeInTheDocument();
  });

  it("shows both diffs, the digest and the base commit for review", async () => {
    setApi();
    detailPage();

    expect(await screen.findByLabelText("Source diff")).toHaveTextContent("+b");
    expect(screen.getByLabelText("Test diff")).toHaveTextContent("+test");
    expect(screen.getByText(/sha256:bbbbbbbbbbbbbbbb/)).toBeInTheDocument();
    expect(screen.getAllByText("aaaaaaaaaa").length).toBeGreaterThan(0);
  });

  it("requires explicit review, then authorises exactly what was shown", async () => {
    const api = setApi();
    const user = userEvent.setup();

    detailPage();

    const open = await screen.findByRole("button", { name: /Review and authorise pull request/ });
    expect(open).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /I have read the source diff/ }));
    expect(open).toBeEnabled();
    await user.click(open);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/draft pull request/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/RepoPilot will not merge it/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Authorise pull request" }));

    await waitFor(() => expect(api.authorizePullRequest).toHaveBeenCalledWith(7, { patchId: 9, diffSha256: DIGEST, baseCommitSha: SHA, outcome: "improved" }));
  });

  it("surfaces a refused authorisation (for example a changed patch) instead of pretending", async () => {
    setApi({ authorizePullRequest: vi.fn().mockRejectedValue(new ApiError("The patch digest no longer matches what was reviewed", 409, [], "authorization_mismatch")) });
    const user = userEvent.setup();

    detailPage();
    await user.click(await screen.findByRole("checkbox", { name: /I have read the source diff/ }));
    await user.click(screen.getByRole("button", { name: /Review and authorise pull request/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Authorise pull request" }));

    expect(await screen.findByText(/no longer matches what was reviewed/)).toBeInTheDocument();
  });

  it("has no merge action anywhere", async () => {
    setApi();
    detailPage();
    await screen.findByLabelText("Source diff");

    expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /merge/i })).not.toBeInTheDocument();
    expect(screen.getByText(/RepoPilot never merges/)).toBeInTheDocument();
  });

  it("warns that an inconclusive outcome is unproven and does not call it verified", async () => {
    setApi({ getRun: vi.fn().mockResolvedValue(detail({ outcomes: [{ patchId: 9, outcome: "inconclusive", reasons: ["verification_unavailable"], details: {}, computedAt: now }] })) });
    detailPage();

    expect(await screen.findByText("Outcome: Inconclusive")).toBeInTheDocument();
    expect(screen.getByText(/No isolated sandbox is configured, so no tests were run/)).toBeInTheDocument();
    expect(screen.getByText(/you can still propose the change for human review/i)).toBeInTheDocument();
    expect(screen.queryByText(/verified/i, { selector: "strong, h1, h2, h3" })).not.toBeInTheDocument();
  });

  it("blocks authorisation for a regression", async () => {
    setApi({ getRun: vi.fn().mockResolvedValue(detail({ outcomes: [{ patchId: 9, outcome: "regressed", reasons: [], details: {}, computedAt: now }] })) });
    detailPage();

    expect(await screen.findByText("Cannot be proposed")).toBeInTheDocument();
    expect(screen.getByText(/made passing tests fail/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review and authorise/ })).not.toBeInTheDocument();
  });

  it("shows a policy-rejected patch with its reasons and no way to propose it", async () => {
    setApi({
      listPatches: vi.fn().mockResolvedValue([patch({ policy: { passed: false, details: { issues: [{ code: "forbidden_path", message: "package.json is protected", path: "package.json" }] } } })]),
      getRun: vi.fn().mockResolvedValue(detail({ outcomes: [] })),
    });
    detailPage();

    // Shown both in the status ladder and in the patch banner.
    expect((await screen.findAllByText(/Rejected by RepoPilot's patch policy/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/package.json is protected/)).toBeInTheDocument();
    expect(screen.getAllByText(/will not be verified or proposed/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: /Review and authorise/ })).not.toBeInTheDocument();
  });

  it("shows a failed run's reason clearly and that nothing was proposed", async () => {
    setApi({ getRun: vi.fn().mockResolvedValue(detail({ run: run({ state: "failed", failure: { code: "repository_not_accessible", detail: "The repository was not found." } }), outcomes: [], counts: { findings: 0, patches: 0 } })), listFindings: vi.fn().mockResolvedValue([]), listPatches: vi.fn().mockResolvedValue([]) });
    detailPage();

    expect(await screen.findByText(/This run failed \(repository_not_accessible\)/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was proposed from this run/)).toBeInTheDocument();
  });

  it("links an opened pull request", async () => {
    const pullRequest = { id: 1, patchId: 9, state: "opened" as const, authorizedBy: "user:operator", authorizedAt: now, authorizedDiffSha256: DIGEST, authorizedOutcome: "improved" as const, baseBranch: "main", baseSha: SHA, branch: "repopilot/run-7-patch-9-bbbbbbbb", number: 42, url: "https://github.com/acme/widgets/pull/42", headSha: SHA, error: null, updatedAt: now };

    setApi({ getRun: vi.fn().mockResolvedValue(detail({ run: run({ state: "pr_opened" }), pullRequest })) });
    detailPage();

    const link = await screen.findByRole("link", { name: /#42/ });
    expect(link).toHaveAttribute("href", "https://github.com/acme/widgets/pull/42");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("offers to cancel an active run and calls the API after confirmation", async () => {
    const api = setApi({ getRun: vi.fn().mockResolvedValue(detail({ run: run({ state: "analyzing" }), outcomes: [] })), listPatches: vi.fn().mockResolvedValue([]) });
    const user = userEvent.setup();

    detailPage();
    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel run" }));

    await waitFor(() => expect(api.cancelRun).toHaveBeenCalledWith(7));
  });

  it("reports load errors with a retry", async () => {
    setApi({ getRun: vi.fn().mockRejectedValue(new ApiError("Run not found", 404, [], "not_found")) });
    detailPage();

    expect(await screen.findByText("Could not load this run")).toBeInTheDocument();
    expect(screen.getByText("Run not found")).toBeInTheDocument();
  });

  it("shows AI usage billed to the user's key and the log", async () => {
    setApi({ listLogs: vi.fn().mockResolvedValue([{ id: 1, stage: "ingest", level: "INFO", message: "Resolved main to aaaaaaaaaaaa", at: now }]) });
    detailPage();

    expect(await screen.findByLabelText("Run log")).toHaveTextContent("Resolved main to aaaaaaaaaaaa");
    expect(screen.getByText(/billed to your provider key/)).toBeInTheDocument();
  });
});

import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { useApi } from "@/auth/AuthProvider";
import { describeError } from "@/api/errors";
import type { RpRun } from "@/api/repopilotTypes";
import { Badge, Banner, Button, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, PageHeader, SecretField, SelectField, Spinner, TableSkeleton, TextField, useToast } from "@/components/ui";
import type { Column } from "@/components/ui";
import { useRepoPilotCredentials, useRepoPilotRepositories, useRepoPilotRuns, useRepoPilotStatus } from "@/data/repopilot";
import { timeAgo } from "@/lib/format";
import { useAutoPoll } from "../runs/useAutoPoll";
import { RUN_STATE, isActive, needsPerson, shortSha } from "./model";
import "./repopilot.css";

export default function RepoPilotPage() {
  const status = useRepoPilotStatus();

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="RepoPilot"
        description="AI-assisted analysis of a GitHub repository. It suggests fixes with a regression test, checks them when a sandbox is available, and opens a pull request only after you approve the exact change. It never merges."
        actions={<Button icon={<RefreshCw size={14} aria-hidden className={status.refreshing ? "spin" : undefined} />} onClick={() => void status.refresh()}>Refresh</Button>}
      />

      {status.status === "loading" ? <Spinner label="Checking RepoPilot" /> : null}
      {status.status === "error" ? <ErrorState error={status.error} onRetry={() => void status.refresh()} title="Could not reach RepoPilot" /> : null}

      {status.data && !status.data.enabled ? (
        <Banner tone="info" title="RepoPilot is off">
          {status.data.message ?? "RepoPilot is disabled on this server."} Turn it on by setting REPOPILOT=enabled on the API and starting the repopilot-worker service (see docs/repopilot.md).
          {status.data.problems.length > 0 ? <ul>{status.data.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
        </Banner>
      ) : null}

      {status.data?.enabled ? <Enabled status={status.data} /> : null}
    </>
  );
}

function Enabled({ status }: { status: NonNullable<ReturnType<typeof useRepoPilotStatus>["data"]> }) {
  const credentials = useRepoPilotCredentials();
  const repos = useRepoPilotRepositories();
  const aiReady = credentials.data?.some((c) => c.provider === "anthropic") ?? false;
  const sandbox = status.sandbox;

  return (
    <div className="rp-stack">
      {status.problems.map((problem) => <Banner key={problem} tone="warning" title="Configuration problem">{problem}</Banner>)}
      {status.workers === 0 ? <Banner tone="warning" title="No RepoPilot worker is running">Runs will wait in the queue. Start the repopilot-worker service.</Banner> : null}
      {status.github && !status.github.configured && status.workers ? <Banner tone="warning" title="GitHub access is not configured">The worker has no REPOPILOT_GITHUB_TOKEN, so repositories cannot be read and no pull request can be opened.</Banner> : null}
      {sandbox && sandbox.status !== "ready" ? (
        <Banner tone="warning" title="Test verification is not running">
          {sandbox.note} RepoPilot will still propose patches, but they will be labelled inconclusive: no repository code is executed unless an isolated sandbox has been provisioned and validated.
        </Banner>
      ) : null}

      <div className="rp-grid">
        <ConnectionCard aiReady={aiReady} credentialsLoading={credentials.status === "loading"} onChanged={() => void credentials.refresh()} encryption={status.ai?.credentialEncryption ?? false} workerCanDecrypt={status.ai?.workerCanDecrypt ?? false} />
        <RepositoriesCard repos={repos.data ?? []} loading={repos.status === "loading"} error={repos.status === "error" ? repos.error : undefined} onChanged={() => void repos.refresh()} />
      </div>

      <StartCard repos={repos.data ?? []} aiReady={aiReady} />
      <RunsCard />

      <Banner tone="info" title="What to keep in mind">
        <ul>{status.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </Banner>
    </div>
  );
}

function ConnectionCard({ aiReady, credentialsLoading, encryption, workerCanDecrypt, onChanged }: { aiReady: boolean; credentialsLoading: boolean; encryption: boolean; workerCanDecrypt: boolean; onChanged: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      await api.repopilot.setCredential("anthropic", key);
      setKey("");
      toast.success("AI key saved", "It is stored encrypted and is never shown again.");
      onChanged();
    } catch (error) {
      toast.error("Could not save the key", describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.repopilot.deleteCredential("anthropic");
      toast.success("AI key removed");
      onChanged();
    } catch (error) {
      toast.error("Could not remove the key", describeError(error));
    }
  };

  return (
    <Card>
      <CardHeader title="Your AI provider key" description="RepoPilot only ever uses your own Anthropic key, and you pay for what it uses. ShipFlow never substitutes an operator's key." actions={credentialsLoading ? <Spinner label="Loading" /> : <Badge tone={aiReady ? "success" : "warning"}>{aiReady ? "Key stored" : "No key"}</Badge>} />
      <CardBody>
        {!encryption ? <Banner tone="warning" title="Key storage is not configured">The server has no REPOPILOT_CREDENTIAL_PUBLIC_KEY, so keys cannot be stored safely. See docs/repopilot.md.</Banner> : null}
        {encryption && !workerCanDecrypt ? <Banner tone="warning" title="The worker cannot read stored keys">The worker has no credential private key; analysis will fail until it is configured.</Banner> : null}
        <form onSubmit={(e) => void save(e)} className="rp-form">
          <SecretField label="Anthropic API key" hint="Write-only. It is sealed for the worker and never returned to this browser." value={key} onChange={setKey} disabled={!encryption || busy} placeholder="sk-ant-…" />
          <div className="row">
            <Button type="submit" variant="primary" loading={busy} disabled={!encryption || key.trim() === ""}>{aiReady ? "Replace key" : "Save key"}</Button>
            {aiReady ? <Button onClick={() => void remove()}>Remove key</Button> : null}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function RepositoriesCard({ repos, loading, error, onChanged }: { repos: Array<{ owner: string; name: string }>; loading: boolean; error: unknown; onChanged: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      await api.repopilot.authorizeRepository(url.trim());
      setUrl("");
      onChanged();
    } catch (error_) {
      toast.error("Could not authorise the repository", describeError(error_));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Repositories RepoPilot may read" description="Authorise each repository explicitly. Public GitHub repositories only by default." />
      <CardBody>
        {loading ? <Spinner label="Loading repositories" /> : null}
        {error ? <ErrorState error={error} title="Could not load repositories" /> : null}
        {!loading && !error && repos.length === 0 ? <p className="muted">No repositories authorised yet.</p> : null}
        <ul className="rp-list">
          {repos.map((repo) => (
            <li key={`${repo.owner}/${repo.name}`} className="row">
              <code className="grow">{repo.owner}/{repo.name}</code>
              <Button size="sm" onClick={() => void api.repopilot.revokeRepository(repo.owner, repo.name).then(onChanged).catch((e: unknown) => toast.error("Could not revoke", describeError(e)))}>Revoke</Button>
            </li>
          ))}
        </ul>
        <form onSubmit={(e) => void add(e)} className="rp-form">
          <TextField label="Repository URL" placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button type="submit" loading={busy} disabled={url.trim() === ""}>Authorise repository</Button>
        </form>
      </CardBody>
    </Card>
  );
}

function StartCard({ repos, aiReady }: { repos: Array<{ owner: string; name: string }>; aiReady: boolean }) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      const run = await api.repopilot.createRun({ repoUrl: `https://github.com/${repo}`, ...(ref.trim() ? { ref: ref.trim() } : {}) });
      void navigate(`/repopilot/runs/${run.id}`);
    } catch (error) {
      toast.error("Could not start the analysis", describeError(error));
      setBusy(false);
    }
  };

  const blocked = repos.length === 0 ? "Authorise a repository first." : !aiReady ? "Store your AI key first." : null;

  return (
    <Card>
      <CardHeader title="Start an analysis" description="Reads the repository at an exact commit (the branch's current head unless you give a ref)." />
      <CardBody>
        {blocked ? <p className="muted">{blocked}</p> : null}
        <form onSubmit={(e) => void start(e)} className="rp-form rp-form--inline">
          <SelectField label="Repository" value={repo} onChange={(e) => setRepo(e.target.value)} disabled={blocked !== null}>
            <option value="">Choose…</option>
            {repos.map((r) => <option key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>{r.owner}/{r.name}</option>)}
          </SelectField>
          <TextField label="Branch, tag or commit (optional)" value={ref} onChange={(e) => setRef(e.target.value)} disabled={blocked !== null} placeholder="default branch" />
          <Button type="submit" variant="primary" icon={<ShieldCheck size={14} aria-hidden />} loading={busy} disabled={blocked !== null || repo === ""}>Analyse</Button>
        </form>
      </CardBody>
    </Card>
  );
}

function RunsCard() {
  const { pollMs, sync } = useAutoPoll(4000);
  const runs = useRepoPilotRuns({ pollMs });

  sync(runs.data ? runs.data.some((r) => isActive(r.state) && !needsPerson(r.state)) : undefined);

  const columns: Column<RpRun>[] = [
    { key: "id", header: "Run", cell: (r) => <Link to={`/repopilot/runs/${r.id}`}>#{r.id}</Link>, sort: (a, b) => a.id - b.id },
    { key: "repo", header: "Repository", cell: (r) => <code>{r.repo.owner}/{r.repo.name}</code> },
    { key: "commit", header: "Commit", cell: (r) => <code>{shortSha(r.commitSha)}</code> },
    { key: "state", header: "State", cell: (r) => <Badge tone={RUN_STATE[r.state].tone}>{RUN_STATE[r.state].label}</Badge> },
    { key: "age", header: "Started", cell: (r) => timeAgo(r.createdAt), sort: (a, b) => a.createdAt.localeCompare(b.createdAt) },
  ];

  return (
    <Card>
      <CardHeader title="Runs" description="Each run is one analysis of one commit." />
      <CardBody flush>
        {runs.status === "loading" ? <TableSkeleton rows={3} columns={5} /> : null}
        {runs.status === "error" ? <ErrorState error={runs.error} onRetry={() => void runs.refresh()} title="Could not load runs" /> : null}
        {runs.data ? <DataTable caption="RepoPilot runs" rows={runs.data} columns={columns} rowKey={(r) => String(r.id)} initialSort={{ key: "id", direction: "desc" }} empty={<EmptyState title="No runs yet" description="Start an analysis above." />} /> : null}
      </CardBody>
    </Card>
  );
}

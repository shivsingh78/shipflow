import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutGrid, List, Plus, RefreshCw, Rocket } from "lucide-react";
import { Button, Card, DataTable, EmptyState, ErrorState, LinkButton, PageHeader, SearchInput, StatusBadge, TableSkeleton, TargetBadge } from "@/components/ui";
import type { Column } from "@/components/ui";
import { useProjectDetails, useReleases } from "@/data/hooks";
import { projectUrl } from "@/lib/derive";
import { pluralize, repoName, timeAgo } from "@/lib/format";
import { TARGETS } from "@/lib/projectConfig";
import { targetLabel } from "@/lib/status";
import { ExternalLink } from "./components/ExternalLink";
import { AppStatusBadge } from "./components/AppStatusBadge";
import { MissingSecretsChip } from "./components/MissingSecretsChip";
import { APP_STATUS_LABEL, deriveAppRows, filterRows, sortRows } from "./lib/appState";
import type { AppFilters, AppRow, AppStatus, SortKey } from "./lib/appState";
import "./applications.css";

const VIEW_KEY = "shipflow.applications.view";
type View = "table" | "cards";

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "table";
  } catch {
    return "table";
  }
}

function LatestRelease({ row }: { row: AppRow }) {
  const r = row.latest;

  if (!r) return <span className="subtle">None yet</span>;

  return (
    <div className="row row--wrap" style={{ gap: "var(--space-2)" }}>
      <StatusBadge status={r.status} />
      <Link to={`/releases/${r.release_id}`} className="mono" onClick={(e) => e.stopPropagation()}>{r.release_id}</Link>
      <span className="subtle" title={r.created_at}>{timeAgo(r.created_at)}</span>
    </div>
  );
}

function LiveUrl({ row }: { row: AppRow }) {
  const url = projectUrl(row.details.project);

  // Only claim a live URL when something is actually deployed.
  if (!url || !row.details.activeReleaseId) return <span className="subtle">—</span>;

  return <ExternalLink href={url}>{url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</ExternalLink>;
}

function RepoLink({ url }: { url: string }) {
  return <ExternalLink href={url}>{repoName(url)}</ExternalLink>;
}

function AppCard({ row }: { row: AppRow }) {
  const p = row.details.project;

  return (
    <article className="card app-card" aria-label={p.name}>
      <div className="row row--between" style={{ alignItems: "flex-start" }}>
        <Link to={`/applications/${p.name}`} className="app-card__name truncate">{p.name}</Link>
        <AppStatusBadge status={row.status} />
      </div>
      <RepoLink url={p.repo_url} />
      <div className="app-card__meta">
        <TargetBadge target={p.target} />
        <span className="subtle mono">{p.config.project.branch}</span>
        <MissingSecretsChip names={row.missing} />
      </div>
      <LatestRelease row={row} />
      <div className="app-card__foot">
        <LiveUrl row={row} />
      </div>
    </article>
  );
}

function useColumns(): Column<AppRow>[] {
  return useMemo<Column<AppRow>[]>(
    () => [
      {
        key: "name",
        header: "Application",
        sort: (a, b) => a.name.localeCompare(b.name),
        cell: (r) => (
          <div className="row row--wrap" style={{ gap: "var(--space-2)" }}>
            <Link to={`/applications/${r.name}`} style={{ fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>{r.name}</Link>
            <MissingSecretsChip names={r.missing} />
          </div>
        ),
      },
      { key: "repo", header: "Repository", cell: (r) => <RepoLink url={r.details.project.repo_url} /> },
      { key: "target", header: "Target", sort: (a, b) => a.details.project.target.localeCompare(b.details.project.target), cell: (r) => <TargetBadge target={r.details.project.target} /> },
      { key: "branch", header: "Branch", cell: (r) => <span className="mono">{r.details.project.config.project.branch}</span> },
      { key: "status", header: "Status", sort: (a, b) => a.status.localeCompare(b.status), cell: (r) => <AppStatusBadge status={r.status} /> },
      { key: "latest", header: "Latest release", sort: (a, b) => Date.parse(a.latest?.created_at ?? "") - Date.parse(b.latest?.created_at ?? ""), cell: (r) => <LatestRelease row={r} /> },
      { key: "url", header: "Live URL", cell: (r) => <LiveUrl row={r} /> },
    ],
    []
  );
}

export default function ApplicationsPage() {
  const navigate = useNavigate();
  const details = useProjectDetails();
  const releases = useReleases({ limit: 200 });
  const [view, setViewState] = useState<View>(readView);
  const [filters, setFilters] = useState<AppFilters>({ search: "", target: "all", status: "all" });
  const [sort, setSort] = useState<SortKey>("name");
  const columns = useColumns();

  const setView = (next: View) => {
    setViewState(next);

    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Preference just will not persist.
    }
  };

  const rows = useMemo(() => (details.data ? deriveAppRows(details.data, releases.data?.releases ?? []) : []), [details.data, releases.data]);
  const visible = useMemo(() => sortRows(filterRows(rows, filters), sort), [rows, filters, sort]);
  const refreshing = details.refreshing || releases.refreshing;
  const newButton = <LinkButton to="/applications/new" variant="primary" icon={<Plus size={14} aria-hidden />}>New application</LinkButton>;

  const refresh = () => {
    void details.refresh();
    void releases.refresh();
  };

  let body;

  if (details.status === "loading") body = <Card><TableSkeleton rows={5} columns={6} /></Card>;
  else if (details.status === "error") body = <Card><ErrorState error={details.error} onRetry={refresh} title="Could not load applications" /></Card>;
  else if (rows.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={<Rocket size={22} aria-hidden />}
          title="Deploy your first application"
          description="An application is a repository ShipFlow builds, tests and deploys to one of your targets. Paste a repository URL, pick where it runs, and ShipFlow takes it from there."
          action={newButton}
        />
      </Card>
    );
  } else {
    body = (
      <>
        <div className="apps-toolbar" role="search">
          <SearchInput value={filters.search} onChange={(search) => setFilters({ ...filters, search })} placeholder="Search name, repository, branch" label="Search applications" />
          <select className="select" aria-label="Filter by target" value={filters.target} onChange={(e) => setFilters({ ...filters, target: e.target.value })}>
            <option value="all">All targets</option>
            {TARGETS.map((t) => <option key={t} value={t}>{targetLabel(t)}</option>)}
          </select>
          <select className="select" aria-label="Filter by status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as AppStatus | "all" })}>
            <option value="all">All statuses</option>
            {(Object.keys(APP_STATUS_LABEL) as AppStatus[]).map((s) => <option key={s} value={s}>{APP_STATUS_LABEL[s]}</option>)}
          </select>
          <select className="select" aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="name">Sort: name</option>
            <option value="recent">Sort: latest activity</option>
            <option value="status">Sort: needs attention</option>
          </select>
          <div className="view-toggle" role="group" aria-label="Layout">
            <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}><List size={14} aria-hidden />Table</button>
            <button type="button" aria-pressed={view === "cards"} onClick={() => setView("cards")}><LayoutGrid size={14} aria-hidden />Cards</button>
          </div>
        </div>
        <p className="subtle" role="status" style={{ margin: "0 0 var(--space-3)" }}>
          {pluralize(visible.length, "application")}{visible.length !== rows.length ? ` of ${rows.length}` : ""}
          {releases.status === "error" ? " · latest release status could not be loaded" : ""}
        </p>
        {visible.length === 0 ? (
          <Card>
            <EmptyState title="No applications match" description="Try a different search or clear the filters." action={<Button onClick={() => setFilters({ search: "", target: "all", status: "all" })}>Clear filters</Button>} />
          </Card>
        ) : view === "cards" ? (
          <div className="app-grid">{visible.map((row) => <AppCard key={row.name} row={row} />)}</div>
        ) : (
          <Card>
            <DataTable rows={visible} columns={columns} rowKey={(r) => r.name} onRowClick={(r) => navigate(`/applications/${r.name}`)} caption="Applications" />
          </Card>
        )}
      </>
    );
  }

  return (
    <div className="apps-page">
      <PageHeader
        title="Applications"
        description="Every repository ShipFlow builds and deploys. Status reflects the latest deployment."
        actions={
          <>
            <Button onClick={refresh} loading={refreshing} icon={<RefreshCw size={14} aria-hidden />}>Refresh</Button>
            {newButton}
          </>
        }
      />
      {body}
    </div>
  );
}

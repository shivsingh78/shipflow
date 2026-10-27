import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Globe, Plus } from "lucide-react";
import { Banner, Button, Card, DataTable, EmptyState, ErrorState, LinkButton, PageHeader, SearchInput, TableSkeleton, TargetBadge } from "@/components/ui";
import type { Column } from "@/components/ui";
import { useProjectDetails } from "@/data/hooks";
import { deriveDomains } from "@/lib/derive";
import type { DomainEntry } from "@/lib/derive";
import { targetLabel } from "@/lib/status";
import "./infrastructure.css";

export function filterDomains(rows: DomainEntry[], query: string, target: string): DomainEntry[] {
  const q = query.trim().toLowerCase();

  return rows.filter((r) => (target === "all" || r.target === target) && (!q || r.host.toLowerCase().includes(q) || r.project.toLowerCase().includes(q)));
}

const columns: Column<DomainEntry>[] = [
  { key: "host", header: "Host", sort: (a, b) => a.host.localeCompare(b.host), cell: (r) => <span className="mono">{r.host}</span> },
  {
    key: "url",
    header: "URL",
    cell: (r) => (
      <a href={r.url} target="_blank" rel="noopener noreferrer" className="row" style={{ display: "inline-flex", gap: "var(--space-1)" }}>
        <span style={{ overflowWrap: "anywhere" }}>{r.url}</span>
        <ExternalLink size={13} aria-hidden />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    ),
  },
  { key: "project", header: "Application", sort: (a, b) => a.project.localeCompare(b.project), cell: (r) => <Link to={`/applications/${encodeURIComponent(r.project)}`}>{r.project}</Link> },
  { key: "target", header: "Target", cell: (r) => <TargetBadge target={r.target} /> },
];

export default function DomainsPage() {
  const details = useProjectDetails();
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("all");
  const rows = useMemo(() => deriveDomains((details.data ?? []).map((d) => d.project)), [details.data]);
  const shown = useMemo(() => filterDomains(rows, query, target), [rows, query, target]);
  const targets = useMemo(() => [...new Set(rows.map((r) => r.target))].sort(), [rows]);

  return (
    <div className="stack">
      <PageHeader
        title="Domains"
        description="Hostnames your applications answer on, taken from their configuration."
        actions={<Button disabled aria-describedby="add-domain-why" icon={<Plus size={14} aria-hidden />}>Add domain</Button>}
      />
      <p id="add-domain-why" className="muted">
        Not available: domains are not standalone objects. Set the hostname or URL in the application&apos;s configuration (<Link to="/applications">open an application</Link>).
      </p>
      <Banner tone="info" title="ShipFlow does not manage DNS or TLS">
        Your reverse proxy or load balancer terminates TLS and routes the hostname. For the ShipFlow site server target, host-routed projects are served on the site server&apos;s own port. A hostname can belong to only one project.
      </Banner>

      {details.status === "loading" ? (
        <Card><TableSkeleton rows={4} columns={4} /></Card>
      ) : details.status === "error" ? (
        <ErrorState error={details.error} onRetry={() => void details.refresh()} title="Could not load applications" />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Globe size={22} aria-hidden />} title="No domains configured" description="No application has a hostname or public URL set yet." action={<LinkButton to="/applications/new" variant="primary">Create an application</LinkButton>} />
        </Card>
      ) : (
        <Card>
          <div className="infra-toolbar" style={{ margin: "var(--space-4)" }}>
            <SearchInput value={query} onChange={setQuery} label="Search domains" placeholder="Search host or application" />
            <label htmlFor="domain-target" className="sr-only">Filter by target</label>
            <select id="domain-target" className="select" style={{ width: "auto" }} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="all">All targets</option>
              {targets.map((t) => <option key={t} value={t}>{targetLabel(t)}</option>)}
            </select>
            <span className="muted" aria-live="polite">{shown.length} of {rows.length}</span>
          </div>
          <DataTable rows={shown} columns={columns} rowKey={(r) => `${r.project}:${r.host}`} caption="Domains" empty={<EmptyState title="No domains match" description="Change the search or target filter." />} />
        </Card>
      )}
    </div>
  );
}

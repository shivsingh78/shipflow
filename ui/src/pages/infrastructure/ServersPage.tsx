import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Server as ServerIcon, ShieldCheck } from "lucide-react";
import { Banner, Badge, Button, Card, CardBody, CardHeader, CopyValue, EmptyState, ErrorState, KeyValue, LinkButton, PageHeader, SearchInput, TableSkeleton } from "@/components/ui";
import { useProjectDetails } from "@/data/hooks";
import { CheckPanel } from "./CheckPanel";
import { KIND_LABEL, KIND_RUNTIME, deriveInfraServers, formatHostKey } from "./model";
import type { InfraServer, ServerKind } from "./model";
import { useChecks } from "./useChecks";
import "./infrastructure.css";

type KindFilter = "all" | ServerKind;

export function filterServers(servers: InfraServer[], query: string, kind: KindFilter): InfraServer[] {
  const q = query.trim().toLowerCase();

  return servers.filter((s) => (kind === "all" || s.kind === kind) && (!q || [s.address, s.user ?? "", s.credentialSecret, ...s.projects].some((v) => v.toLowerCase().includes(q))));
}

function ServerCard({ server, check }: { server: InfraServer; check: ReturnType<typeof useChecks> }) {
  const [via, setVia] = useState(server.projects[0] ?? "");
  const state = check.states[server.id];
  const key = server.hostKey ? formatHostKey(server.hostKey) : null;
  const selectId = `via-${server.id}`;

  return (
    <li>
      <Card className="infra-server">
        <CardHeader
          title={
            <span className="infra-server__head">
              <Badge tone={server.kind === "kubernetes" ? "info" : "neutral"}>{KIND_LABEL[server.kind]}</Badge>
              <span className="infra-server__addr mono">{server.address}</span>
            </span>
          }
        />
        <CardBody>
          <KeyValue
            items={[
              ...(server.user ? [{ label: "SSH user", value: <code>{server.user}</code> }] : []),
              ...(server.kind === "kubernetes" ? [{ label: "Cluster address", value: "Stored inside the kubeconfig secret; not retrievable" }, { label: "Namespaces", value: server.namespaces.map((n) => <code key={n}>{n} </code>) }] : []),
              ...(key && server.hostKey ? [{ label: "Pinned host key", value: <span className="row row--wrap"><code>{key.type}</code><CopyValue value={server.hostKey} display={key.short} /></span> }] : []),
              { label: server.kind === "kubernetes" ? "Kubeconfig secret" : "Private key secret", value: <span><code>{server.credentialSecret}</code> <span className="muted">(name only; value is stored server-side and never shown)</span></span> },
              { label: "Runs", value: KIND_RUNTIME[server.kind] },
              { label: "Applications", value: <span className="infra-links">{server.projects.map((p) => <Link key={p} to={`/applications/${encodeURIComponent(p)}`}>{p}</Link>)}</span> },
            ]}
          />
          <div className="infra-actions">
            {server.projects.length > 1 ? (
              <>
                <label htmlFor={selectId} className="muted">Check via application</label>
                <select id={selectId} className="select" style={{ width: "auto" }} value={via} onChange={(e) => setVia(e.target.value)}>
                  {server.projects.map((p) => <option key={p}>{p}</option>)}
                </select>
              </>
            ) : null}
            <Button icon={<ShieldCheck size={14} aria-hidden />} loading={state?.status === "running"} onClick={() => void check.run(server.id, via)} aria-label={`Run check for ${server.address}`}>
              Run check
            </Button>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>Uses the stored credentials of {via}; read-only, nothing is deployed.</span>
          </div>
          <CheckPanel state={state} />
        </CardBody>
      </Card>
    </li>
  );
}

export default function ServersPage() {
  const details = useProjectDetails();
  const check = useChecks();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const servers = useMemo(() => deriveInfraServers((details.data ?? []).map((d) => d.project)), [details.data]);
  const shown = useMemo(() => filterServers(servers, query, kind), [servers, query, kind]);

  return (
    <div className="stack">
      <PageHeader
        title="Servers"
        description="Hosts and clusters your applications deploy to, derived from each application's configuration."
        actions={
          <Button disabled aria-describedby="add-server-why" icon={<Plus size={14} aria-hidden />}>
            Add server
          </Button>
        }
      />
      <p id="add-server-why" className="muted">
        Not available: servers are configured per application (<code>deployment.*</code> in shipflow.yml). <Link to="/applications/new">Create or edit an application</Link> to add one.
      </p>
      <Banner tone="info" title="A read-only view">
        ShipFlow has no standalone server records, no agents and no continuous monitoring. Status appears only when you press Run check, and is kept in this browser session.
      </Banner>

      {details.status === "loading" ? (
        <Card><TableSkeleton rows={3} columns={4} /></Card>
      ) : details.status === "error" ? (
        <ErrorState error={details.error} onRetry={() => void details.refresh()} title="Could not load applications" />
      ) : servers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ServerIcon size={22} aria-hidden />}
            title="No external servers yet"
            description="Applications on the ShipFlow built-in site server (target shipflow) are served by this instance and are not external servers. Servers appear here once an application deploys over SSH, to a Docker host, or to Kubernetes."
            action={<LinkButton to="/applications/new" variant="primary">Create an application</LinkButton>}
          />
        </Card>
      ) : (
        <>
          <div className="infra-toolbar">
            <SearchInput value={query} onChange={setQuery} label="Search servers" placeholder="Search address, user, application" />
            <label htmlFor="kind-filter" className="sr-only">Filter by kind</label>
            <select id="kind-filter" className="select" style={{ width: "auto" }} value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
              <option value="all">All kinds</option>
              <option value="ssh">{KIND_LABEL.ssh}</option>
              <option value="docker">{KIND_LABEL.docker}</option>
              <option value="kubernetes">{KIND_LABEL.kubernetes}</option>
            </select>
            <span className="muted" aria-live="polite">{shown.length} of {servers.length}</span>
          </div>
          {shown.length === 0 ? (
            <Card><EmptyState title="No servers match" description="Change the search or the kind filter." /></Card>
          ) : (
            <ul className="infra-list" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Servers">
              {shown.map((s) => <ServerCard key={s.id} server={s} check={check} />)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

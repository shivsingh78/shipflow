import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Boxes, CheckCircle2, Container, Globe, Info, Network, Package, RefreshCw, Server, X, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge, Banner, Button, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, PageHeader, Spinner, TableSkeleton } from "@/components/ui";
import type { Column } from "@/components/ui";
import { useProjectDetails, useReadiness, useWhoAmI } from "@/data/hooks";
import { deriveDomains } from "@/lib/derive";
import { pluralize, timeAgo } from "@/lib/format";
import { targetLabel } from "@/lib/status";
import { KIND_LABEL, deriveInfraRegistries, deriveInfraServers, detailText } from "./model";
import "./infrastructure.css";

interface ResourceCard {
  key: string;
  title: string;
  icon: LucideIcon;
  count: number;
  noun: string;
  lines: string[];
  to: string;
}

interface InventoryRow {
  id: string;
  name: string;
  type: string;
  detail: string;
  apps: string[];
  to: string;
}

/**
 * Everything on this page comes from project configuration or ShipFlow's own
 * diagnostics. There is no host agent, so CPU/memory/disk and per-resource health
 * are NOT shown as numbers: the page says so instead of inventing them.
 */
export default function InfrastructurePage() {
  const projects = useProjectDetails();
  const whoami = useWhoAmI();
  const readiness = useReadiness();
  const [noticeOpen, setNoticeOpen] = useState(true);

  const list = useMemo(() => (projects.data ?? []).map((p) => p.project), [projects.data]);
  const servers = useMemo(() => deriveInfraServers(list), [list]);
  const registries = useMemo(() => deriveInfraRegistries(list), [list]);
  const domains = useMemo(() => deriveDomains(list), [list]);

  const ssh = servers.filter((s) => s.kind === "ssh");
  const docker = servers.filter((s) => s.kind === "docker");
  const kube = servers.filter((s) => s.kind === "kubernetes");

  const cards: ResourceCard[] = [
    { key: "ssh", title: "SSH static hosts", icon: Server, count: ssh.length, noun: "host", lines: ssh.slice(0, 2).map((s) => s.address), to: "/servers" },
    { key: "docker", title: "Docker hosts", icon: Container, count: docker.length, noun: "host", lines: docker.slice(0, 2).map((s) => s.address), to: "/servers" },
    { key: "kube", title: "Kubernetes clusters", icon: Network, count: kube.length, noun: "cluster", lines: kube.slice(0, 2).map((s) => `${s.namespaces.length} namespace${s.namespaces.length === 1 ? "" : "s"}`), to: "/servers" },
    { key: "registries", title: "Container registries", icon: Package, count: registries.length, noun: "registry", lines: registries.slice(0, 2).map((r) => r.endpoint), to: "/registries" },
  ];

  const inventory: InventoryRow[] = [
    ...servers.map((s) => ({ id: s.id, name: s.address, type: KIND_LABEL[s.kind], detail: s.kind === "kubernetes" ? "kubeconfig secret" : `user ${s.user ?? "?"}`, apps: s.projects, to: "/servers" })),
    ...registries.map((r) => ({ id: `registry:${r.endpoint}`, name: r.endpoint, type: "Container registry", detail: r.authSecret ? `auth secret ${r.authSecret}` : "no auth secret", apps: r.projects, to: "/registries" })),
    ...(whoami.data?.artifactStore ? [{ id: "artifact-store", name: whoami.data.artifactStore, type: "Artifact storage", detail: "all release artifacts", apps: [] as string[], to: "/infrastructure" }] : []),
  ];

  const columns: Column<InventoryRow>[] = [
    { key: "name", header: "Resource", sort: (a, b) => a.name.localeCompare(b.name), cell: (r) => <Link to={r.to} className="mono">{r.name}</Link> },
    { key: "type", header: "Type", sort: (a, b) => a.type.localeCompare(b.type), cell: (r) => r.type },
    { key: "detail", header: "Configuration", cell: (r) => <span className="muted">{r.detail}</span> },
    { key: "apps", header: "Applications", cell: (r) => (r.apps.length ? r.apps.join(", ") : <span className="muted">All</span>) },
  ];

  const checks = readiness.data?.checks ?? [];
  const failing = checks.filter((c) => !c.ok).length;

  return (
    <>
      <PageHeader
        title="Infrastructure"
        description="Configured resources and diagnostic checks."
        actions={
          <>
            <Badge title="Nothing here is continuously monitored">Derived + diagnostic data</Badge>
            <Button icon={<RefreshCw size={14} aria-hidden className={readiness.refreshing ? "spin" : undefined} />} onClick={() => void readiness.refresh()} loading={readiness.refreshing}>
              Run diagnostics
            </Button>
          </>
        }
      />

      {noticeOpen ? (
        <div className="infra-hub__notice" role="note">
          <Info size={18} aria-hidden />
          <p>
            ShipFlow does not continuously monitor these resources. What you see comes from your applications' configuration, or from the last diagnostic you ran. Per-server connection checks live on the{" "}
            <Link to="/servers">Servers</Link> page.
          </p>
          <button type="button" className="icon-btn" onClick={() => setNoticeOpen(false)} aria-label="Dismiss notice">
            <X size={16} aria-hidden />
          </button>
        </div>
      ) : null}

      <h2 className="infra-hub__heading">Connected resources</h2>
      {projects.status === "loading" ? (
        <Card><TableSkeleton rows={2} columns={4} /></Card>
      ) : projects.status === "error" ? (
        <Card><CardBody><ErrorState error={projects.error} onRetry={() => void projects.refresh()} title="Could not read application configuration" /></CardBody></Card>
      ) : (
        <ul className="infra-hub__cards" aria-label="Connected resources">
          {cards.map((card) => {
            const Icon = card.icon;

            return (
              <li key={card.key}>
                <Card className="infra-hub__card">
                  <CardBody>
                    <div className="infra-hub__card-top">
                      <span className="infra-hub__icon"><Icon size={20} aria-hidden /></span>
                      <Badge tone={card.count > 0 ? "info" : "neutral"}>{card.count > 0 ? "Configured" : "None"}</Badge>
                    </div>
                    <h3>{card.title}</h3>
                    <p className="infra-hub__count">{pluralize(card.count, card.noun)} configured</p>
                    {card.lines.map((line) => <p key={line} className="muted infra-hub__line mono">{line}</p>)}
                    <Link to={card.to} className="infra-hub__link">View details <ArrowUpRight size={14} aria-hidden /></Link>
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <div className="infra-hub__split">
        <Card>
          <CardHeader title="Resource inventory" description="Resources your applications are configured to use." />
          <CardBody flush>
            <DataTable
              caption="Resource inventory"
              rows={inventory}
              columns={columns}
              rowKey={(r) => r.id}
              pageSize={10}
              empty={<EmptyState icon={<Boxes size={22} aria-hidden />} title="No infrastructure configured" description="Servers, clusters and registries appear here once an application targets them." />}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Control plane diagnostics"
            description={readiness.updatedAt ? `Last run ${timeAgo(new Date(readiness.updatedAt).toISOString())}` : undefined}
            actions={readiness.status === "ready" ? <Badge tone={failing === 0 ? "success" : "danger"}>{failing === 0 ? "All passing" : `${failing} failing`}</Badge> : undefined}
          />
          <CardBody>
            {readiness.status === "loading" ? <Spinner label="Running diagnostics" /> : null}
            {readiness.status === "error" && !readiness.data ? <ErrorState error={readiness.error} onRetry={() => void readiness.refresh()} title="Diagnostics failed to run" /> : null}
            <ul className="infra-hub__checks">
              {checks.map((check) => (
                <li key={check.name}>
                  {check.ok ? <CheckCircle2 size={16} className="infra-hub__ok" aria-hidden /> : <XCircle size={16} className="infra-hub__bad" aria-hidden />}
                  <span>
                    <strong className="mono">{check.name}</strong>
                    <span className="muted"> {detailText(check.detail)}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted infra-hub__help">Point-in-time results of ShipFlow's own checks (database, queue, workers, storage), not continuous monitoring.</p>
            <div className="infra-hub__planned">
              <strong>Capacity (CPU, memory, disk)</strong>
              <Badge title="ShipFlow has no host metrics agent yet">Not collected · Planned</Badge>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card className="infra-hub__domains">
        <CardHeader title="Domains & endpoints" description="URLs your applications are configured to answer on." actions={<Link to="/domains">View all <ArrowUpRight size={14} aria-hidden /></Link>} />
        <CardBody>
          {domains.length === 0 ? (
            <p className="muted">No application has a domain or URL configured.</p>
          ) : (
            <ul className="infra-hub__domains-list">
              {domains.slice(0, 6).map((d) => (
                <li key={`${d.project}:${d.host}`}>
                  <Globe size={16} aria-hidden className="muted" />
                  <span className="grow">
                    <strong className="mono">{d.host}</strong>
                    <span className="muted"> · <Link to={`/applications/${encodeURIComponent(d.project)}`}>{d.project}</Link> · {targetLabel(d.target)}</span>
                  </span>
                  <Badge title="Configured, not verified by a health check">Configured</Badge>
                </li>
              ))}
            </ul>
          )}
          <Banner tone="info">Health monitoring for domains is planned. These entries show configuration only.</Banner>
        </CardBody>
      </Card>
    </>
  );
}

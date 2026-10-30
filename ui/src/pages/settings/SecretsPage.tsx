import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import { Badge, Banner, Button, Card, CardBody, CardHeader, DataTable, EmptyState, ErrorState, SearchInput, SelectField, TableSkeleton } from "@/components/ui";
import type { Column } from "@/components/ui";
import { useProjectDetails, useWhoAmI } from "@/data/hooks";
import { formatDateTime, pluralize, timeAgo } from "@/lib/format";
import { secretInventory, secretSummary } from "./secrets";
import type { SecretRow } from "./secrets";
import { SettingsLayout } from "./SettingsLayout";
import "./settings.css";

const PLANNED = ["RBAC teams", "Artifact signing & provenance", "Vulnerability scanning / SBOM", "Automatic rollback policies"];

export default function SecretsPage() {
  const details = useProjectDetails();
  const whoami = useWhoAmI();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState("");

  const rows = useMemo(() => secretInventory(details.data ?? []), [details.data]);
  const summary = useMemo(() => secretSummary(rows), [rows]);
  const names = useMemo(() => (details.data ?? []).map((d) => d.project.name).sort(), [details.data]);
  const q = query.trim().toLowerCase();
  const visible = rows.filter((r) => !q || r.name.toLowerCase().includes(q) || r.project.toLowerCase().includes(q));
  const enabled = whoami.data?.secretsEnabled;

  const columns: Column<SecretRow>[] = [
    { key: "name", header: "Name", sort: (a, b) => a.name.localeCompare(b.name), cell: (r) => <span className="mono">{r.name}</span> },
    { key: "app", header: "Application", sort: (a, b) => a.project.localeCompare(b.project), cell: (r) => <Link to={`/applications/${encodeURIComponent(r.project)}/environment`}>{r.project}</Link> },
    { key: "required", header: "Used as", cell: (r) => (r.required ? "Required by configuration" : <span className="muted">Extra (runtime)</span>) },
    { key: "updated", header: "Last changed", sort: (a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""), cell: (r) => (r.updatedAt ? <span title={formatDateTime(r.updatedAt)}>{timeAgo(r.updatedAt)}</span> : <span className="muted">Never set</span>) },
    { key: "status", header: "Status", cell: (r) => <Badge tone={r.state === "configured" ? "success" : "danger"}>{r.state === "configured" ? "Configured" : "Missing"}</Badge> },
    { key: "value", header: "Value", cell: () => <span className="mono secrets__mask" aria-label="Value hidden">••••••••</span> },
  ];

  return (
    <SettingsLayout
      active="secrets"
      title="Secrets & credentials"
      description="Secret values are write-only: they are never displayed after creation, only replaced or removed."
      actions={<Button variant="primary" icon={<Plus size={14} aria-hidden />} onClick={() => setAdding((open) => !open)} aria-expanded={adding} disabled={enabled === false || names.length === 0}>Add secret</Button>}
    >
      {adding ? (
        <Card>
          <CardHeader title="Add a secret" description="Secrets belong to an application. Choose one and set the value on its Environment page." />
          <CardBody>
            <div className="secrets__add">
              <SelectField label="Application" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose…</option>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </SelectField>
              <Button variant="primary" disabled={!target} onClick={() => void navigate(`/applications/${encodeURIComponent(target)}/environment`)}>Open Environment</Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {enabled === false ? (
        <Banner tone="warning" title="Secret storage is disabled on this server">Set SHIPFLOW_SECRETS_KEY on the API and worker so values can be stored. Applications that need SSH keys or a kubeconfig cannot deploy until then.</Banner>
      ) : (
        <Card>
          <CardBody>
            <div className="secrets__assurance">
              <span className="secrets__shield"><ShieldCheck size={20} aria-hidden /></span>
              <p>{enabled ? "Stored secrets are encrypted at rest with AES-256-GCM." : "Checking secret storage…"} ShipFlow does not keep a separate secrets audit log yet, so this page cannot show who changed what.</p>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Inventory"
          description={details.status === "ready" ? `${pluralize(summary.configured, "secret")} configured${summary.missing ? `, ${summary.missing} missing` : ""} across ${pluralize(summary.applications, "application")}` : undefined}
          actions={<div className="secrets__search"><SearchInput value={query} onChange={setQuery} placeholder="Secret or application" label="Search secrets" /></div>}
        />
        <CardBody flush>
          {details.status === "loading" ? <TableSkeleton rows={4} columns={5} /> : null}
          {details.status === "error" ? <ErrorState error={details.error} onRetry={() => void details.refresh()} title="Could not read secrets" /> : null}
          {details.status === "ready" ? (
            <DataTable
              caption="Secrets by application"
              rows={visible}
              columns={columns}
              rowKey={(r) => `${r.project}/${r.name}`}
              pageSize={10}
              empty={<EmptyState icon={<KeyRound size={22} aria-hidden />} title={rows.length === 0 ? "No secrets yet" : "Nothing matches"} description={rows.length === 0 ? "Applications that deploy over SSH, Docker or Kubernetes reference secrets by name. They appear here once configured." : "Try another search."} />}
            />
          ) : null}
        </CardBody>
      </Card>

      <section className="secrets__future" aria-labelledby="future-controls">
        <div className="secrets__future-head">
          <div>
            <h3 id="future-controls">Future controls</h3>
            <p className="muted">Planned security capabilities. None of these is active.</p>
          </div>
          <Badge>Planned</Badge>
        </div>
        <ul className="secrets__chips">
          {PLANNED.map((name) => <li key={name}><Button variant="secondary" disabled>{name}</Button></li>)}
        </ul>
      </section>
    </SettingsLayout>
  );
}

import { RefreshCw } from "lucide-react";
import { Badge, Banner, Button, Card, CardBody, CardHeader, ErrorState, KeyValue, PageHeader, TableSkeleton } from "@/components/ui";
import { useTheme } from "@/components/layout/Theme";
import type { ThemePreference } from "@/components/layout/Theme";
import { useReadiness, useWhoAmI } from "@/data/hooks";
import { detailText } from "@/pages/infrastructure/model";
import { targetLabel } from "@/lib/status";
import "@/pages/infrastructure/infrastructure.css";

const yes = (v: boolean) => (v ? "Yes" : "No");
const THEMES: ThemePreference[] = ["system", "light", "dark"];

function Appearance() {
  const { preference, setPreference } = useTheme();

  return (
    <Card>
      <CardHeader title="Appearance" description="Stored in this browser only." />
      <CardBody>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="sr-only">Theme</legend>
          <div className="seg">
            {THEMES.map((t) => (
              <label key={t}>
                <input type="radio" name="theme" value={t} checked={preference === t} onChange={() => setPreference(t)} />
                {t[0]?.toUpperCase()}{t.slice(1)}
              </label>
            ))}
          </div>
        </fieldset>
      </CardBody>
    </Card>
  );
}

export default function SettingsPage() {
  const who = useWhoAmI();
  const ready = useReadiness();
  const info = who.data;

  return (
    <div className="stack">
      <PageHeader title="Settings" description="Read-only overview of this ShipFlow instance." />
      <Banner tone="info" title="Server-side settings are not editable here">
        Server-side settings are configured with environment variables (see docs/self-hosting.md); this dashboard does not edit them.
      </Banner>

      <div className="settings-grid">
        <Card>
          <CardHeader title="Instance" />
          <CardBody>
            {who.status === "loading" ? (
              <TableSkeleton rows={4} columns={2} />
            ) : who.status === "error" || !info ? (
              <ErrorState error={who.error} onRetry={() => void who.refresh()} />
            ) : (
              <KeyValue
                items={[
                  { label: "Instance name", value: info.instance },
                  { label: "Artifact store", value: info.artifactStore ? <code>{info.artifactStore}</code> : "Not reported" },
                  { label: "Secrets", value: <span><Badge tone={info.secretsEnabled ? "success" : "warning"}>{info.secretsEnabled ? "Enabled" : "Disabled"}</Badge> <span className="muted">{info.secretsEnabled ? "Encrypted secrets can be stored per application." : "Applications that need secrets (SSH keys, kubeconfig) cannot be deployed."}</span></span> },
                  { label: "GitHub webhooks", value: <span><Badge tone={info.githubWebhooks ? "success" : "neutral"}>{info.githubWebhooks ? "Enabled" : "Disabled"}</Badge> <span className="muted">{info.githubWebhooks ? "Pushes can trigger deployments." : "Deployments are triggered manually or by the CLI."}</span></span> },
                  {
                    label: "Allowed repository prefixes",
                    value: info.allowedRepoPrefixes.length ? <ul style={{ margin: 0, paddingLeft: "var(--space-4)" }}>{info.allowedRepoPrefixes.map((p) => <li key={p}><code>{p}</code></li>)}</ul> : "None configured",
                  },
                ]}
              />
            )}
          </CardBody>
        </Card>
        <Appearance />
      </div>

      <Card>
        <CardHeader title="Deployment targets" description="What each target supports, as reported by the API." />
        {who.status === "ready" && info ? (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Deployment target capabilities</caption>
              <thead>
                <tr>
                  <th scope="col">Target</th><th scope="col">Artifacts</th><th scope="col">Candidate verification</th><th scope="col">Atomic activation</th><th scope="col">Rollback</th><th scope="col">Verify after revert</th>
                </tr>
              </thead>
              <tbody>
                {info.targets.map((t) => (
                  <tr key={t.name}>
                    <th scope="row"><div>{targetLabel(t.name)}</div><div className="muted" style={{ fontWeight: 400, fontSize: "var(--text-sm)" }}>{t.description}</div></th>
                    <td>{t.capabilities.artifactTypes.join(", ")}</td>
                    <td>{t.capabilities.candidateVerification}</td>
                    <td>{yes(t.capabilities.atomicActivation)}</td>
                    <td>{yes(t.capabilities.rollback)}</td>
                    <td>{t.capabilities.verifyAfterRevert === undefined ? "n/a" : yes(t.capabilities.verifyAfterRevert)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : who.status === "loading" ? (
          <TableSkeleton rows={4} columns={5} />
        ) : (
          <CardBody><ErrorState error={who.error} onRetry={() => void who.refresh()} /></CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title="System readiness"
          description="From the API's /ready endpoint, fetched when this page opened or you refreshed."
          actions={<Button size="sm" loading={ready.refreshing} onClick={() => void ready.refresh()} icon={<RefreshCw size={14} aria-hidden />}>Refresh</Button>}
        />
        <CardBody>
          {ready.status === "loading" ? (
            <TableSkeleton rows={4} columns={2} />
          ) : ready.status === "error" || !ready.data ? (
            <ErrorState error={ready.error} onRetry={() => void ready.refresh()} title="Could not read readiness" />
          ) : (
            <>
              <p><Badge tone={ready.data.ok ? "success" : "danger"}>{ready.data.ok ? "Ready" : "Not ready"}</Badge></p>
              <ul className="infra-digests" style={{ marginTop: "var(--space-3)" }}>
                {ready.data.checks.map((c) => (
                  <li key={c.name}>
                    <Badge tone={c.ok ? "success" : "danger"}>{c.ok ? "OK" : "Failing"}</Badge>
                    <strong>{c.name}</strong>
                    <span className="muted" style={{ overflowWrap: "anywhere", minWidth: 0 }}>{detailText(c.detail)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

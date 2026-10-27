import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { describeError } from "@/api/errors";
import type { SecretInfo } from "@/api/types";
import { useApi } from "@/auth/AuthProvider";
import { Badge, Banner, Button, Card, CardBody, CardHeader, ConfirmDialog, EmptyState, useToast } from "@/components/ui";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { ProjectConfig } from "@/lib/projectConfig";
import { secretRows } from "../lib/appState";
import { SetSecretDialog } from "./SecretDialog";

/** Secret NAMES with state. Values are write-only: never listed, never prefilled. */
export function SecretsPanel({ project, config, secrets, secretsEnabled, onChanged }: { project: string; config: ProjectConfig; secrets: SecretInfo[]; secretsEnabled: boolean | undefined; onChanged: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [setting, setSetting] = useState<{ name: string; replacing: boolean } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const rows = secretRows(config, secrets);
  const disabled = secretsEnabled === false;

  return (
    <Card>
      <CardHeader title="Secrets" description="Write-only. Values are stored encrypted on the server and can never be read back, only replaced or removed." />
      <CardBody>
        <div className="stack">
          {disabled ? <Banner tone="warning" title="Secret storage is disabled on this server">The server has no secret encryption key configured, so values cannot be stored. Required secrets cannot be set from here.</Banner> : null}
          {rows.length === 0 ? (
            <EmptyState icon={<KeyRound size={20} aria-hidden />} title="No secrets needed" description="This configuration does not reference any secret. SSH, Docker and Kubernetes targets reference key or kubeconfig secrets, and image targets can list runtime secret names." />
          ) : (
            <ul className="check-list" aria-label="Secrets" style={{ gap: 0 }}>
              {rows.map((row) => (
                <li key={row.name} className="secret-row" style={{ width: "100%" }}>
                  <div className="row row--wrap row--between" style={{ width: "100%" }}>
                    <div className="grow">
                      <div className="row row--wrap" style={{ gap: "var(--space-2)" }}>
                        <code style={{ fontWeight: 600 }}>{row.name}</code>
                        {row.required ? <Badge tone={row.set ? "neutral" : "warning"}>Required</Badge> : <Badge outline>Optional</Badge>}
                        {row.set ? <Badge tone="success">Set</Badge> : <Badge tone="warning">Not set</Badge>}
                      </div>
                      <div className="subtle">
                        {row.usage ?? "Not referenced by the configuration"}
                        {row.updatedAt ? <> · updated <span title={formatDateTime(row.updatedAt)}>{timeAgo(row.updatedAt)}</span></> : null}
                      </div>
                    </div>
                    <div className="row">
                      <Button size="sm" variant={row.set ? "secondary" : "primary"} disabled={disabled} onClick={() => setSetting({ name: row.name, replacing: row.set })} aria-label={`${row.set ? "Replace" : "Set"} value of ${row.name}`}>
                        {row.set ? "Replace value" : "Set value"}
                      </Button>
                      {row.set ? (
                        <Button size="sm" variant="ghost" icon={<Trash2 size={13} aria-hidden />} onClick={() => setRemoving(row.name)} aria-label={`Remove ${row.name}`}>Remove</Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
      {setting ? (
        <SetSecretDialog
          open
          project={project}
          name={setting.name}
          replacing={setting.replacing}
          multilineDefault={/PRIVATE_KEY|KUBECONFIG|AUTH/.test(setting.name)}
          onClose={() => setSetting(null)}
          onSaved={onChanged}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove secret ${removing ?? ""}?`}
        description={config && removing && rows.find((r) => r.name === removing)?.required ? "This secret is required by the configuration. Deployments will be refused until you set it again." : "The stored value is deleted. It cannot be recovered."}
        confirmLabel="Remove secret"
        tone="danger"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;

          try {
            await api.removeSecret(project, removing);
            toast.success("Secret removed", removing);
            setRemoving(null);
            onChanged();
          } catch (caught) {
            toast.error("Could not remove the secret", describeError(caught));
          }
        }}
      />
    </Card>
  );
}

import { useMemo, useState } from "react";
import { Save } from "lucide-react";
import type { Project, SaveProjectResult } from "@/api/types";
import { Banner, Button, Card, CardBody, CardHeader } from "@/components/ui";
import { BuildFields, DeploymentMethodFields, RepositoryFields, RuntimeFields, SourceFields, TargetFields, VerificationFields } from "./ConfigFields";
import { ErrorSummary } from "./ErrorSummary";
import { useConfigSave } from "./useConfigSave";
import { draftFromConfig, errorMap, isImageTargetName } from "../lib/configForm";
import type { ConfigDraft } from "../lib/configForm";
import { useWhoAmI } from "@/data/hooks";

/** Edit a stored configuration with the same form sections the creation wizard uses. */
export function ConfigEditor({ project, onSaved, onCancel }: { project: Project; onSaved: (result: SaveProjectResult) => void; onCancel: () => void }) {
  const whoami = useWhoAmI();
  const prefixes = useMemo(() => whoami.data?.allowedRepoPrefixes ?? [], [whoami.data]);
  const [draft, setDraft] = useState<ConfigDraft>(() => draftFromConfig(project.config));
  const { save, busy, issues, message } = useConfigSave(prefixes);
  const errors = useMemo(() => errorMap(issues), [issues]);
  const section = { draft, onChange: setDraft, errors };

  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft).then((result) => {
          if (result) onSaved(result);
        });
      }}
    >
      <Banner tone="info" title="Editing the shipflow.yml configuration">
        Saving validates the configuration with the same rules as the server. The application name cannot be changed. Secret values are never part of the configuration.
      </Banner>
      {message ? <Banner tone="danger" title="Not saved">{message}</Banner> : null}
      <ErrorSummary issues={issues} title="Problems not tied to a field" />
      <Card><CardHeader title="Repository" /><CardBody><RepositoryFields {...section} nameLocked allowedPrefixes={prefixes} /></CardBody></Card>
      <Card><CardHeader title="Branch and GitHub automation" /><CardBody><SourceFields {...section} /></CardBody></Card>
      <Card><CardHeader title="Deployment method" /><CardBody><DeploymentMethodFields {...section} targets={whoami.data?.targets} /></CardBody></Card>
      <Card><CardHeader title="Build" /><CardBody><BuildFields {...section} /></CardBody></Card>
      {isImageTargetName(draft.target) ? <Card><CardHeader title="Runtime" /><CardBody><RuntimeFields {...section} /></CardBody></Card> : null}
      <Card><CardHeader title="Target settings" /><CardBody><TargetFields {...section} /></CardBody></Card>
      <Card><CardHeader title="Verification" /><CardBody><VerificationFields {...section} /></CardBody></Card>
      <div className="row">
        <Button type="submit" variant="primary" loading={busy} icon={<Save size={14} aria-hidden />}>Save configuration</Button>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

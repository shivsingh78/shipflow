import { useMemo, useState } from "react";
import { Save } from "lucide-react";
import { Banner, Button, Card, CardBody, CardHeader, TextAreaField, useToast } from "@/components/ui";
import { EnvEditor } from "../components/EnvEditor";
import { SecretsPanel } from "../components/SecretsPanel";
import { ErrorSummary } from "../components/ErrorSummary";
import { useConfigSave } from "../components/useConfigSave";
import { useApplication } from "../context";
import { draftFromConfig, errorMap, isImageTargetName } from "../lib/configForm";
import type { ConfigDraft } from "../lib/configForm";
import "../applications.css";

const envKey = (d: ConfigDraft) => JSON.stringify([d.buildEnv, d.runtimeEnv, d.runtimeSecrets]);

export default function EnvironmentTab() {
  const app = useApplication();
  const toast = useToast();
  const original = useMemo(() => draftFromConfig(app.project.config), [app.project.config]);
  const [draft, setDraft] = useState<ConfigDraft>(original);
  const { save, busy, issues, message, reset } = useConfigSave(app.whoami?.allowedRepoPrefixes ?? []);
  const errors = useMemo(() => errorMap(issues), [issues]);
  const dirty = envKey(draft) !== envKey(original);
  const image = isImageTargetName(draft.target);

  return (
    <div className="stack">
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          // Only the variables change; everything else is saved exactly as stored.
          void save({ ...original, buildEnv: draft.buildEnv, runtimeEnv: draft.runtimeEnv, runtimeSecrets: draft.runtimeSecrets }).then((result) => {
            if (result) {
              toast.success("Environment saved", "Public variables were updated in the configuration.");
              void app.refresh();
            }
          });
        }}
      >
        <Card>
          <CardHeader title="Public variables" description="Stored in the project configuration and visible to anyone who can read it. Changes apply to the next deployment." />
          <CardBody>
            <div className="stack--lg stack">
              {message ? <Banner tone="danger" title="Not saved">{message}</Banner> : null}
              <ErrorSummary issues={issues} title="Problems not tied to a field" />
              <EnvEditor label="Build environment" prefix="build.env" rows={draft.buildEnv} onChange={(buildEnv) => { reset(); setDraft({ ...draft, buildEnv }); }} errors={errors} />
              {image ? (
                <>
                  <EnvEditor label="Runtime environment" prefix="runtime.env" rows={draft.runtimeEnv} onChange={(runtimeEnv) => { reset(); setDraft({ ...draft, runtimeEnv }); }} errors={errors} />
                  <TextAreaField
                    label="Runtime secret names"
                    rows={3}
                    className="mono"
                    value={draft.runtimeSecrets}
                    onChange={(e) => { reset(); setDraft({ ...draft, runtimeSecrets: e.target.value }); }}
                    error={[...errors.entries()].filter(([p]) => p.startsWith("runtime.secrets")).map(([, m]) => m).join("; ") || undefined}
                    hint="Names only (UPPER_CASE). After saving, set each value below. Values are injected as environment variables at run time."
                    spellCheck={false}
                  />
                </>
              ) : (
                <p className="muted">Runtime variables and runtime secrets only apply to image targets (Docker, Kubernetes). This application serves static files.</p>
              )}
              <div className="row">
                <Button type="submit" variant="primary" loading={busy} disabled={!dirty} icon={<Save size={14} aria-hidden />}>Save variables</Button>
                {dirty ? <Button onClick={() => { reset(); setDraft(original); }} disabled={busy}>Discard changes</Button> : null}
              </div>
            </div>
          </CardBody>
        </Card>
      </form>
      <SecretsPanel project={app.project.name} config={app.project.config} secrets={app.secrets} secretsEnabled={app.whoami?.secretsEnabled} onChanged={() => void app.refresh()} />
    </div>
  );
}

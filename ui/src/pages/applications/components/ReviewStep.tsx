import { Banner, Card, CardBody, CardHeader, CopyValue, KeyValue } from "@/components/ui";
import { requiredSecrets } from "@/lib/projectConfig";
import type { ProjectConfig, ProjectConfigIssue } from "@/lib/projectConfig";
import { projectUrl } from "@/lib/derive";
import { targetLabel } from "@/lib/status";
import { toYaml } from "../lib/yaml";
import { ErrorSummary } from "./ErrorSummary";
import type { StepNumber } from "../lib/configForm";

export function ReviewStep({ config, issues, onGoToStep }: { config: ProjectConfig | null; issues: ProjectConfigIssue[]; onGoToStep: (step: StepNumber) => void }) {
  if (!config) {
    return <ErrorSummary issues={issues} all title="The configuration is not valid yet" onGoToStep={onGoToStep} />;
  }

  const secrets = requiredSecrets(config);
  const yaml = toYaml(config);
  const url = projectUrl({ config });

  return (
    <div className="stack">
      <Card>
        <CardHeader title="Summary" />
        <CardBody>
          <KeyValue
            items={[
              { label: "Application", value: <code>{config.project.name}</code> },
              { label: "Repository", value: config.project.repository },
              { label: "Branch", value: <code>{config.project.branch}</code> },
              { label: "Deployment method", value: targetLabel(config.deployment.target) },
              { label: "Build strategy", value: config.build.strategy ?? "detected automatically" },
              { label: "Public URL", value: url ?? "none configured" },
              { label: "Deploy on push", value: config.github.deployOnPush ? "Yes" : "No" },
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Required secrets" description="Names only. You set the values, write-only, in the next step." />
        <CardBody>
          {secrets.length === 0 ? <p className="muted">None. This configuration needs no secrets.</p> : <ul className="check-list">{secrets.map((s) => <li key={s}><code>{s}</code></li>)}</ul>}
        </CardBody>
      </Card>
      {config.deployment.target === "kubernetes" ? <Banner tone="warning" title="Experimental: not verified on a real cluster">The Kubernetes target is implemented and tested against a fake API server only.</Banner> : null}
      <Card>
        <CardHeader title="shipflow.yml" description="The configuration ShipFlow will store. It never contains secret values." actions={<CopyValue value={yaml} display="Copy" />} />
        <CardBody>
          <pre className="yaml-preview" tabIndex={0} aria-label="Generated shipflow.yml"><code>{yaml}</code></pre>
        </CardBody>
      </Card>
    </div>
  );
}

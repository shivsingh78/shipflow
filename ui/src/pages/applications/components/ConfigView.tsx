import { Card, CardBody, CardHeader, CopyValue, KeyValue } from "@/components/ui";
import type { ProjectConfig } from "@/lib/projectConfig";
import { targetLabel } from "@/lib/status";
import { ExternalLink } from "./ExternalLink";

const mono = (v: string) => <code>{v}</code>;
const none = <span className="subtle">not set</span>;

function Env({ values }: { values: Record<string, string> }) {
  const entries = Object.entries(values);

  if (entries.length === 0) return none;

  return <ul className="check-list">{entries.map(([k, v]) => <li key={k}><code>{k}</code>=<code>{v}</code></li>)}</ul>;
}

/** Truncate a long public value (host key) while keeping it copyable. */
export function Truncated({ value, max = 36 }: { value: string; max?: number }) {
  return <CopyValue value={value} display={value.length > max ? `${value.slice(0, max)}…` : value} />;
}

function TargetItems({ config }: { config: ProjectConfig }) {
  const d = config.deployment;

  if (d.target === "shipflow") return <KeyValue items={[{ label: "Hostname", value: d.shipflow.hostname ? mono(d.shipflow.hostname) : none }]} />;
  if (d.target === "ssh") {
    const s = d.ssh;

    return <KeyValue items={[{ label: "Host", value: mono(`${s.host}:${s.port}`) }, { label: "User", value: mono(s.user) }, { label: "Remote path", value: mono(s.path) }, { label: "Public URL", value: <ExternalLink href={s.url}>{s.url}</ExternalLink> }, { label: "Host key (public)", value: <Truncated value={s.hostKey} /> }, { label: "Private key secret", value: mono(s.privateKeySecret) }]} />;
  }
  if (d.target === "docker") {
    const s = d.docker;

    return <KeyValue items={[{ label: "Host", value: mono(`${s.host}:${s.port}`) }, { label: "User", value: mono(s.user) }, { label: "Published port", value: s.publishPort }, { label: "Public URL", value: <ExternalLink href={s.url}>{s.url}</ExternalLink> }, { label: "Host key (public)", value: <Truncated value={s.hostKey} /> }, { label: "Private key secret", value: mono(s.privateKeySecret) }]} />;
  }

  const s = d.kubernetes;

  return <KeyValue items={[{ label: "Namespace", value: mono(s.namespace) }, { label: "Registry", value: mono(s.registry) }, { label: "Replicas", value: s.replicas }, { label: "Public URL", value: <ExternalLink href={s.url}>{s.url}</ExternalLink> }, { label: "Kubeconfig secret", value: mono(s.kubeconfigSecret) }, { label: "Registry auth secret", value: s.registryAuthSecret ? mono(s.registryAuthSecret) : none }]} />;
}

/** Read-only structured view of the stored configuration. */
export function ConfigView({ config }: { config: ProjectConfig }) {
  const b = config.build;

  return (
    <div className="cfg-grid">
      <Card>
        <CardHeader title="Source" />
        <CardBody>
          <KeyValue
            items={[
              { label: "Repository", value: <ExternalLink href={config.project.repository}>{config.project.repository}</ExternalLink> },
              { label: "Branch", value: mono(config.project.branch) },
              { label: "Deploy on push", value: config.github.deployOnPush ? "Yes" : "No" },
              { label: "Check pull requests", value: config.github.checkPullRequests ? "Yes" : "No" },
              { label: "Deploy branch", value: mono(config.github.deployBranch) },
            ]}
          />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Build" description="Commands run in the build sandbox." />
        <CardBody>
          <KeyValue items={[{ label: "Strategy", value: b.strategy ? mono(b.strategy) : "detected automatically" }, ...(b.dockerfile ? [{ label: "Dockerfile", value: mono(b.dockerfile) }] : []), { label: "Install", value: mono(b.install) }, { label: "Build command", value: mono(b.command) }, { label: "Output", value: mono(b.output) }, { label: "Test command", value: mono(b.test) }, { label: "Environment (public)", value: <Env values={b.env} /> }]} />
        </CardBody>
      </Card>
      {config.runtime ? (
        <Card>
          <CardHeader title="Runtime" />
          <CardBody>
            <KeyValue items={[{ label: "Port", value: config.runtime.port }, { label: "Start command", value: config.runtime.start ? mono(config.runtime.start) : "package.json start script" }, { label: "Environment (public)", value: <Env values={config.runtime.env} /> }, { label: "Secret names", value: config.runtime.secrets.length > 0 ? config.runtime.secrets.map((s) => <code key={s} style={{ marginRight: 6 }}>{s}</code>) : none }]} />
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader title={`Deployment: ${targetLabel(config.deployment.target)}`} />
        <CardBody><TargetItems config={config} /></CardBody>
      </Card>
      <Card>
        <CardHeader title="Verification" />
        <CardBody>
          <KeyValue items={[{ label: "Path", value: mono(config.verification.path) }, { label: "Expected status", value: config.verification.expectStatus }]} />
        </CardBody>
      </Card>
    </div>
  );
}

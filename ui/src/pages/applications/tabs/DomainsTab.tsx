import { Pencil } from "lucide-react";
import { Banner, Card, CardBody, CardHeader, KeyValue, LinkButton } from "@/components/ui";
import { projectUrl } from "@/lib/derive";
import { targetLabel } from "@/lib/status";
import { ExternalLink } from "../components/ExternalLink";
import { useApplication } from "../context";
import "../applications.css";

export default function DomainsTab() {
  const { project, name, activeReleaseId } = useApplication();
  const d = project.config.deployment;
  const url = projectUrl(project);
  const edit = <LinkButton to={`/applications/${name}/configuration?edit=1`} size="sm" icon={<Pencil size={13} aria-hidden />}>Edit in configuration</LinkButton>;

  return (
    <div className="stack">
      <Card>
        <CardHeader title="Where this application is served" description={`Deployment target: ${targetLabel(d.target)}`} actions={edit} />
        <CardBody>
          <KeyValue
            items={[
              ...(d.target === "shipflow" ? [{ label: "Hostname", value: d.shipflow.hostname ? <code>{d.shipflow.hostname}</code> : <span className="subtle">No hostname configured</span> }] : []),
              { label: d.target === "shipflow" ? "URL" : "Public URL", value: url ? <ExternalLink href={url}>{url}</ExternalLink> : <span className="subtle">None</span> },
              { label: "State", value: activeReleaseId ? "A release is live" : "Nothing is live yet" },
              { label: "Live check", value: <><code>{project.config.verification.path}</code> expects HTTP {project.config.verification.expectStatus}</> },
            ]}
          />
        </CardBody>
      </Card>
      <Banner tone="info" title="DNS and TLS are your responsibility">
        {d.target === "shipflow"
          ? "ShipFlow's site server answers for the configured hostname. Point its DNS record at the server and terminate TLS in front of it. "
          : "The public URL is where ShipFlow performs its live check. Point DNS at your server and manage the certificate there. "}
        ShipFlow does not issue, renew or manage certificates, and does not manage DNS records.
      </Banner>
      {d.target === "shipflow" && !d.shipflow.hostname ? <Banner tone="warning" title="No hostname configured">Set a hostname in the configuration to serve this application on your own domain.</Banner> : null}
    </div>
  );
}

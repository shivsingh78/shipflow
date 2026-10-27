import { Trash2 } from "lucide-react";
import { Badge, Banner, Button, Card, CardBody, CardHeader, CopyValue, KeyValue } from "@/components/ui";
import { formatDateTime, timeAgo } from "@/lib/format";
import { ExternalLink } from "../components/ExternalLink";
import { useApplication } from "../context";
import "../applications.css";

export default function SettingsTab() {
  const { project, whoami } = useApplication();
  const gh = project.config.github;
  const webhookUrl = `${window.location.origin}/webhooks/github`;

  return (
    <div className="stack">
      <Card>
        <CardHeader title="Application" />
        <CardBody>
          <KeyValue
            items={[
              { label: "Name", value: <code>{project.name}</code> },
              { label: "Repository", value: <ExternalLink href={project.repo_url}>{project.repo_url}</ExternalLink> },
              { label: "Target", value: <code>{project.target}</code> },
              { label: "Created", value: <span title={project.created_at}>{formatDateTime(project.created_at)} ({timeAgo(project.created_at)})</span> },
              { label: "Configuration updated", value: <span title={project.updated_at}>{formatDateTime(project.updated_at)} ({timeAgo(project.updated_at)})</span> },
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="GitHub webhook" description="How pushes and pull requests reach ShipFlow." />
        <CardBody>
          <div className="stack">
            {whoami ? (
              whoami.githubWebhooks ? (
                <Banner tone="success" title="GitHub webhooks are enabled on this server">
                  Add a webhook in your repository settings that POSTs to <CopyValue value={webhookUrl} /> with the shared webhook secret your administrator configured. ShipFlow does not show or manage that secret here.
                </Banner>
              ) : (
                <Banner tone="warning" title="GitHub webhooks are not enabled on this server">The settings below are stored but nothing will trigger them until the server is configured with a webhook secret.</Banner>
              )
            ) : null}
            <KeyValue
              items={[
                { label: "Deploy on push", value: gh.deployOnPush ? <Badge tone="success">On</Badge> : <Badge>Off</Badge> },
                { label: "Deploy branch", value: <code>{gh.deployBranch}</code> },
                { label: "Check pull requests", value: gh.checkPullRequests ? <Badge tone="success">On</Badge> : <Badge>Off</Badge> },
              ]}
            />
            <p className="subtle">Change these on the Configuration tab.</p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Cancel and roll back" />
        <CardBody>
          <ul className="error-list" style={{ listStyle: "disc" }}>
            <li><strong>Cancel:</strong> a queued release is cancelled at once; a running one stops at its next checkpoint, and never after activation has begun.</li>
            <li><strong>Roll back:</strong> makes a previous successful release live again from its stored artifact, without rebuilding. The target health-checks it first and restores the current release if that fails. Releases whose artifacts were pruned cannot be rolled back to.</li>
          </ul>
        </CardBody>
      </Card>

      <Card className="danger-zone">
        <CardHeader title="Danger zone" />
        <CardBody>
          <div className="row row--wrap row--between">
            <div>
              <strong>Delete application</strong>
              <p className="muted">The ShipFlow API has no delete endpoint yet. Removing an application currently requires the database or the CLI.</p>
            </div>
            <Button variant="danger" disabled icon={<Trash2 size={14} aria-hidden />} aria-describedby="delete-na">Delete application — not available yet</Button>
          </div>
          <span id="delete-na" className="sr-only">Deleting applications is not supported by the API. Use the database or CLI.</span>
        </CardBody>
      </Card>
    </div>
  );
}

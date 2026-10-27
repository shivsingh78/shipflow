import { Link } from "react-router-dom";
import { Box, FileText } from "lucide-react";
import type { Release, TargetInfo } from "@/api/types";
import { RollbackButton, canRollbackTo } from "@/components/releases/ReleaseActions";
import { ReleaseTable } from "@/components/releases/ReleaseTable";
import { Badge, Banner, Card, CardBody, CardHeader, CopyValue, EmptyState, KeyValue, LinkButton, PipelineSteps, StatusBadge, TargetBadge } from "@/components/ui";
import { useRelease } from "@/data/hooks";
import { projectUrl, releaseDurationMs } from "@/lib/derive";
import { formatBytes, formatDateTime, formatDuration, repoName, shortDigest, shortSha, timeAgo } from "@/lib/format";
import { isImageTarget, stageLabel, targetLabel } from "@/lib/status";
import { ExternalLink } from "../components/ExternalLink";
import { TargetCheckPanel } from "../components/TargetCheck";
import { latestDeploy, useApplication } from "../context";
import { missingSecrets } from "../lib/appState";
import "../applications.css";

function Capabilities({ info }: { info: TargetInfo | undefined }) {
  if (!info) return <p className="muted">Target capabilities are not available from the server.</p>;

  const c = info.capabilities;

  return (
    <KeyValue
      items={[
        { label: "Artifacts", value: c.artifactTypes.join(", ") },
        { label: "Candidate verification", value: c.candidateVerification },
        { label: "Atomic activation", value: c.atomicActivation ? "Yes" : "No" },
        { label: "Rollback", value: c.rollback ? "Supported" : "Not supported" },
      ]}
    />
  );
}

function ArtifactInfo({ release }: { release: Release | undefined }) {
  const a = release?.artifact;

  if (!release) return <p className="muted">Nothing is live yet.</p>;
  if (!a) return <p className="muted">The live release has no stored artifact information.</p>;

  if (a.type === "image") {
    return (
      <>
        <KeyValue
          items={[
            { label: "Type", value: <span className="row" style={{ gap: 6 }}><Box size={14} aria-hidden />Container image</span> },
            { label: "Digest", value: <CopyValue value={a.digest} display={shortDigest(a.digest)} /> },
            { label: "Size", value: formatBytes(a.sizeBytes) },
            { label: "Container port", value: a.port },
          ]}
        />
        <p className="subtle">Images are identified by digest; the API does not expose a registry image reference.</p>
      </>
    );
  }

  return (
    <KeyValue
      items={[
        { label: "Type", value: <span className="row" style={{ gap: 6 }}><FileText size={14} aria-hidden />Static files</span> },
        { label: "Files", value: a.fileCount > 0 ? a.fileCount : "—" },
        { label: "Stored at", value: <code>{a.path}</code> },
      ]}
    />
  );
}

export default function OverviewTab() {
  const app = useApplication();
  const { project, releases, activeReleaseId, whoami, name } = app;
  const base = `/applications/${name}`;
  const inList = releases.find((r) => r.release_id === activeReleaseId);
  const fetched = useRelease(activeReleaseId ?? "", { enabled: Boolean(activeReleaseId) && !inList });
  const live = inList ?? fetched.data;
  const latest = releases[0];
  const lastDeploy = latestDeploy(releases);
  const missing = missingSecrets(project.config, app.secrets);
  const info = whoami?.targets.find((t) => t.name === project.target);
  const url = projectUrl(project);
  const rollbackTarget = releases.find(canRollbackTo);

  return (
    <div className="stack">
      {missing.length > 0 ? (
        <Banner
          tone="warning"
          title={`${missing.length === 1 ? "A required secret is" : "Required secrets are"} not set`}
          action={<LinkButton to={`${base}/environment`} size="sm">Set secrets</LinkButton>}
        >
          Deployments will be refused until you set: {missing.map((n) => <code key={n} style={{ marginRight: 6 }}>{n}</code>)}
        </Banner>
      ) : null}
      {project.target === "kubernetes" ? <Banner tone="warning" title="Experimental: not verified on a real cluster">The Kubernetes target is implemented and tested against a fake API server only.</Banner> : null}

      <div className="cfg-grid">
        <Card>
          <CardHeader title="Repository" />
          <CardBody>
            <KeyValue
              items={[
                { label: "Repository", value: <ExternalLink href={project.repo_url}>{repoName(project.repo_url)}</ExternalLink> },
                { label: "Branch", value: <span className="mono">{project.config.project.branch}</span> },
                { label: "Live commit", value: live?.commit_sha ? <CopyValue value={live.commit_sha} display={shortSha(live.commit_sha)} /> : "—" },
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Latest build" description={latest ? `Release ${latest.release_id}${latest.mode === "check" ? " (check, no deploy)" : ""}` : undefined} />
          <CardBody>
            {latest ? (
              <div className="stack">
                <div className="row row--wrap">
                  <StatusBadge status={latest.status} />
                  <span className="subtle">{latest.status === "RUNNING" || latest.status === "QUEUED" ? `Stage: ${stageLabel(latest.current_stage)}` : `Ended at stage ${stageLabel(latest.current_stage)}`}</span>
                </div>
                <PipelineSteps status={latest.status} stage={latest.current_stage} mode={latest.mode} />
                <KeyValue
                  items={[
                    { label: "Duration", value: formatDuration(releaseDurationMs(latest)) },
                    { label: "Started", value: <span title={formatDateTime(latest.created_at)}>{timeAgo(latest.created_at)}</span> },
                    { label: "Release", value: <Link to={`/releases/${latest.release_id}`} className="mono">{latest.release_id}</Link> },
                  ]}
                />
                {latest.error_message ? <Banner tone="danger" title="Failure">{latest.error_message}</Banner> : null}
              </div>
            ) : (
              <p className="muted">No releases yet. Deploy to run the first build.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Live deployment" />
          <CardBody>
            {live ? (
              <KeyValue
                items={[
                  { label: "Release", value: <Link to={`/releases/${live.release_id}`} className="mono">{live.release_id}</Link> },
                  { label: "Deployed", value: <span title={formatDateTime(live.updated_at)}>{timeAgo(live.updated_at)}</span> },
                  { label: "URL", value: url ? <ExternalLink href={url}>{url}</ExternalLink> : "No URL configured" },
                ]}
              />
            ) : (
              <p className="muted">Nothing is live. {lastDeploy ? `The latest deployment is ${lastDeploy.status.toLowerCase()}.` : "No deployment has been run yet."}</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Health" description="From the latest deployment and the target's own diagnostics." />
          <CardBody>
            <div className="stack">
              <div className="row row--wrap">
                {lastDeploy ? <StatusBadge status={lastDeploy.status} /> : <Badge>Never deployed</Badge>}
                <span className="subtle">{lastDeploy ? `Latest deployment ${lastDeploy.release_id}, live-checked at deploy time` : "No deployment yet"}</span>
              </div>
              <p className="subtle">ShipFlow checks health at deploy time; there is no continuous monitoring yet.</p>
              <TargetCheckPanel project={project.name} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Artifact" description="What the live release runs." />
          <CardBody><ArtifactInfo release={live} /></CardBody>
        </Card>

        <Card>
          <CardHeader title="Deployment target" />
          <CardBody>
            <div className="stack">
              <div className="row row--wrap"><TargetBadge target={project.target} /><span className="muted">{info?.description ?? targetLabel(project.target)}</span></div>
              <Capabilities info={info} />
              <p className="subtle">{isImageTarget(project.target) ? "Runs a container image built from your repository." : "Serves static files built from your repository."}</p>
            </div>
          </CardBody>
        </Card>
      </div>

      {rollbackTarget ? (
        <Card>
          <CardHeader title="Roll back" description="Put an earlier successful release back live without rebuilding." />
          <CardBody>
            <div className="row row--wrap row--between">
              <span>
                Previous successful release <Link to={`/releases/${rollbackTarget.release_id}`} className="mono">{rollbackTarget.release_id}</Link> ({shortSha(rollbackTarget.commit_sha)}, {timeAgo(rollbackTarget.created_at)}).
              </span>
              <RollbackButton release={rollbackTarget} onDone={() => void app.refresh()} />
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Recent releases" actions={<LinkButton to={`${base}/deployments`} size="sm" variant="ghost">All deployments</LinkButton>} />
        <CardBody flush>
          <ReleaseTable
            releases={releases.slice(0, 5)}
            variant="compact"
            showProject={false}
            pageSize={5}
            caption={`Recent releases of ${project.name}`}
            empty={<EmptyState title="No releases yet" description="Deploy this application to see its first release here." />}
          />
        </CardBody>
      </Card>
    </div>
  );
}

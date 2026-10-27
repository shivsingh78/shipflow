import { ExternalLink } from "lucide-react";
import type { Release } from "@/api/types";
import { Badge, Card, CardBody, CardHeader, CopyValue, KeyValue } from "@/components/ui";
import { releaseDurationMs } from "@/lib/derive";
import { formatBytes, formatDateTime, formatDuration, repoName, shortDigest } from "@/lib/format";
import { safeHref } from "@/lib/runs";
import { modeLabel, stageLabel, targetLabel, triggerLabel } from "@/lib/status";

/** "…/image/image.tar": the last two path segments are what identify a stored object. */
const tail = (path: string): string => (path.split("/").length > 3 ? `…/${path.split("/").slice(-2).join("/")}` : path);

const Step = ({ n }: { n: number }) => <span className="breakdown__step" aria-hidden>{n}</span>;
const none = <span className="subtle">—</span>;

export function BuildCard({ release }: { release: Release }) {
  return (
    <Card>
      <CardHeader title={<><Step n={1} />Build</>} description="The CI run: install, build, test in a sandbox." />
      <CardBody>
        <KeyValue
          items={[
            { label: "Run type", value: modeLabel(release.mode) },
            { label: "Build strategy", value: release.build_strategy ?? none },
            { label: "Stage", value: release.status === "SUCCESS" ? `${stageLabel(release.current_stage)} (finished)` : stageLabel(release.current_stage) },
            { label: "Tests", value: release.test_status ? <Badge tone={release.test_status === "PASSED" ? "success" : "neutral"}>{release.test_status === "PASSED" ? "Passed" : "Skipped"}</Badge> : "Not run yet" },
            { label: "Duration", value: formatDuration(releaseDurationMs(release)) },
          ]}
        />
      </CardBody>
    </Card>
  );
}

export function ArtifactCard({ release }: { release: Release }) {
  const artifact = release.artifact;

  return (
    <Card>
      <CardHeader title={<><Step n={2} />Artifact</>} description="What the build produced and ShipFlow stored." />
      <CardBody>
        {!artifact ? (
          <p className="muted">{release.mode === "check" ? "None: check runs build and test but never store an artifact." : "No artifact recorded yet. It is stored after a successful build and test."}</p>
        ) : artifact.type === "image" ? (
          <KeyValue
            items={[
              { label: "Type", value: "Container image" },
              { label: "Image digest", value: <CopyValue value={artifact.digest} display={shortDigest(artifact.digest)} /> },
              { label: "Size", value: formatBytes(artifact.sizeBytes) },
              { label: "Container port", value: artifact.port },
              { label: "Artifact store key", value: <CopyValue value={artifact.key} display={tail(artifact.key)} /> },
              ...(release.artifacts_pruned ? [{ label: "Retention", value: <Badge tone="warning">Pruned</Badge> }] : []),
            ]}
          />
        ) : (
          <KeyValue
            items={[
              { label: "Type", value: "Static files" },
              { label: "Files", value: artifact.fileCount > 0 ? artifact.fileCount : none },
              { label: "Stored at", value: <CopyValue value={artifact.path} display={tail(artifact.path)} /> },
              ...(release.artifacts_pruned ? [{ label: "Retention", value: <Badge tone="warning">Pruned</Badge> }] : []),
            ]}
          />
        )}
      </CardBody>
    </Card>
  );
}

export function DeploymentCard({ release }: { release: Release }) {
  const href = safeHref(release.public_deployment_url);
  const activated = release.mode === "deploy" && release.status === "SUCCESS";

  return (
    <Card>
      <CardHeader title={<><Step n={3} />Deployment</>} description="Where the artifact runs and whether it is live." />
      <CardBody>
        {release.mode === "check" ? (
          <p className="muted">Not deployed: this was a check run. Nothing was placed on a target.</p>
        ) : (
          <KeyValue
            items={[
              { label: "Target", value: targetLabel(release.target) },
              { label: "Live status", value: release.is_active ? <Badge tone="success">Live</Badge> : activated ? <Badge>Not live (superseded or rolled back)</Badge> : <Badge>Not live</Badge> },
              { label: "Activated", value: activated ? "Yes" : release.status === "FAILED" ? `No: failed at ${stageLabel(release.current_stage).toLowerCase()}` : release.status === "CANCELLED" ? "No: cancelled" : "Not yet" },
              {
                label: "Public URL",
                value: href ? (
                  <a href={href} target="_blank" rel="noreferrer noopener" className="row" style={{ display: "inline-flex", gap: 4 }}>
                    {release.public_deployment_url} <ExternalLink size={12} aria-hidden />
                  </a>
                ) : (
                  none
                ),
              },
            ]}
          />
        )}
      </CardBody>
    </Card>
  );
}

export function SourceCard({ release }: { release: Release }) {
  const repoHref = safeHref(release.repo_url);

  return (
    <Card>
      <CardHeader title={<><Step n={4} />Source</>} description="The code this release was built from." />
      <CardBody>
        <KeyValue
          items={[
            { label: "Repository", value: repoHref ? <a href={repoHref} target="_blank" rel="noreferrer noopener">{repoName(release.repo_url)}</a> : repoName(release.repo_url) },
            { label: "Ref", value: release.ref ? <code>{release.ref}</code> : none },
            { label: "Commit", value: release.commit_sha ? <CopyValue value={release.commit_sha} display={release.commit_sha.slice(0, 12)} /> : "Not resolved yet" },
            { label: "Trigger", value: triggerLabel(release.trigger) },
            { label: "Queued", value: formatDateTime(release.created_at) },
            { label: "Last update", value: formatDateTime(release.updated_at) },
          ]}
        />
      </CardBody>
    </Card>
  );
}

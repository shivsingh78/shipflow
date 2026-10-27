import { Outlet, useParams } from "react-router-dom";
import { GitBranch, RefreshCw } from "lucide-react";
import { ApiError } from "@/api/errors";
import { Banner, Button, EmptyState, ErrorState, LinkButton, NavTabs, Skeleton, TargetBadge } from "@/components/ui";
import type { TabItem } from "@/components/ui";
import { DeployButton } from "@/components/releases/ReleaseActions";
import { useProject, useReleases, useWhoAmI } from "@/data/hooks";
import { projectUrl } from "@/lib/derive";
import { repoName } from "@/lib/format";
import { AppStatusBadge } from "./components/AppStatusBadge";
import { ExternalLink } from "./components/ExternalLink";
import { QueueCheckButton } from "./components/QueueCheckButton";
import { MissingSecretsChip } from "./components/MissingSecretsChip";
import { appStatus, missingSecrets } from "./lib/appState";
import { latestDeploy } from "./context";
import type { ApplicationContext } from "./context";
import "./applications.css";

function tabs(name: string): TabItem[] {
  const base = `/applications/${name}`;

  return [
    { to: base, label: "Overview", end: true },
    { to: `${base}/deployments`, label: "Deployments" },
    { to: `${base}/logs`, label: "Build Logs" },
    { to: `${base}/configuration`, label: "Configuration" },
    { to: `${base}/domains`, label: "Domains" },
    { to: `${base}/environment`, label: "Environment Variables" },
    { to: `${base}/settings`, label: "Settings" },
  ];
}

/** Layout for /applications/:name; tab routes render inside the Outlet. */
export default function ApplicationDetailPage() {
  const { name = "" } = useParams();
  const project = useProject(name);
  const releases = useReleases({ project: name, limit: 50, pollMs: 10_000 });
  const whoami = useWhoAmI();

  if (project.status === "loading") {
    return (
      <div className="app-detail" role="status" aria-label="Loading application">
        <Skeleton width={240} height={28} />
        <div style={{ height: 12 }} />
        <Skeleton width={420} height={16} />
      </div>
    );
  }

  if (project.status === "error" || !project.data) {
    if (project.error instanceof ApiError && project.error.status === 404) {
      return (
        <EmptyState
          title="Application not found"
          description={<>There is no application named <code>{name}</code>. It may have been misspelled, or it was never created.</>}
          action={<LinkButton to="/applications" variant="primary">Back to applications</LinkButton>}
        />
      );
    }

    return <ErrorState error={project.error} onRetry={() => void project.refresh()} title="Could not load this application" />;
  }

  const detail = project.data;
  const p = detail.project;
  const list = releases.data?.releases ?? [];
  const status = appStatus(latestDeploy(list));
  const url = projectUrl(p);
  const missing = missingSecrets(p.config, detail.secrets);
  const refresh = async () => {
    await Promise.all([project.refresh(), releases.refresh()]);
  };

  const context: ApplicationContext = {
    name,
    project: p,
    secrets: detail.secrets,
    activeReleaseId: detail.activeReleaseId,
    releases: list,
    releasesLoading: releases.status === "loading",
    releasesError: releases.status === "error" ? releases.error : null,
    whoami: whoami.data,
    refresh,
  };

  return (
    <div className="app-detail">
      <div className="page-header app-head">
        <div className="grow">
          <h1 className="page-header__title row row--wrap" style={{ gap: "var(--space-3)" }}>
            {p.name}
            {releases.status === "ready" ? <AppStatusBadge status={status} /> : null}
            <MissingSecretsChip names={missing} />
          </h1>
          <div className="app-head__facts">
            <span className="app-head__fact"><ExternalLink href={p.repo_url}>{repoName(p.repo_url)}</ExternalLink></span>
            <TargetBadge target={p.target} />
            <span className="app-head__fact"><GitBranch size={13} aria-hidden /><span className="mono">{p.config.project.branch}</span></span>
            {url && detail.activeReleaseId ? <span className="app-head__fact"><ExternalLink href={url}>{url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</ExternalLink></span> : <span className="subtle">Not live yet</span>}
          </div>
        </div>
        <div className="page-header__actions">
          <Button onClick={() => void refresh()} loading={project.refreshing || releases.refreshing} icon={<RefreshCw size={14} aria-hidden />}>Refresh</Button>
          <QueueCheckButton project={p.name} branch={p.config.project.branch} />
          <DeployButton project={p.name} defaultRef={p.config.project.branch} />
        </div>
      </div>
      {releases.status === "error" ? <Banner tone="warning" title="Release data could not be refreshed">Showing what was loaded before. Use Refresh to retry.</Banner> : null}
      <NavTabs items={tabs(name)} label={`${name} sections`} />
      <Outlet context={context} />
    </div>
  );
}


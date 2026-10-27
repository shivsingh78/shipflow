import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Package, Plus, ShieldCheck } from "lucide-react";
import { Badge, Banner, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, KeyValue, PageHeader, Skeleton, TableSkeleton } from "@/components/ui";
import { useProjectDetails, useReleases, useWhoAmI } from "@/data/hooks";
import { formatBytes, shortDigest, timeAgo } from "@/lib/format";
import { CheckPanel } from "./CheckPanel";
import { deriveInfraRegistries } from "./model";
import { useChecks } from "./useChecks";
import "./infrastructure.css";

export default function RegistriesPage() {
  const details = useProjectDetails();
  const whoami = useWhoAmI();
  const releases = useReleases({ limit: 100 });
  const check = useChecks();
  const registries = useMemo(() => deriveInfraRegistries((details.data ?? []).map((d) => d.project)), [details.data]);

  const images = useMemo(() => {
    const byProject = new Map<string, Array<{ id: string; digest: string; size: number; at: string }>>();

    for (const r of releases.data?.releases ?? []) {
      if (r.artifact?.type !== "image") continue;

      const list = byProject.get(r.project) ?? [];

      if (list.length < 3) list.push({ id: r.release_id, digest: r.artifact.digest, size: r.artifact.sizeBytes, at: r.created_at });
      byProject.set(r.project, list);
    }

    return [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [releases.data]);

  return (
    <div className="stack">
      <PageHeader
        title="Container registries"
        description="Registries used by Kubernetes applications, derived from each application's configuration."
        actions={<Button disabled aria-describedby="add-reg-why" icon={<Plus size={14} aria-hidden />}>Add registry</Button>}
      />
      <p id="add-reg-why" className="muted">
        Not available: registries are not standalone objects. Set <code>deployment.kubernetes.registry</code> (and <code>registryAuthSecret</code>) by <Link to="/applications/new">creating or editing an application</Link>, or use the CLI.
      </p>

      <Banner tone="info" title="The Docker target does not use a registry">
        Docker-host applications keep built images in the artifact store as archives and load them over SSH. Only Kubernetes applications push to a registry.
      </Banner>

      <Card>
        <CardHeader title="Artifact store" description="Where built artifacts and images are kept" />
        <CardBody>
          {whoami.status === "loading" ? <Skeleton width={200} /> : whoami.status === "error" ? <ErrorState error={whoami.error} onRetry={() => void whoami.refresh()} /> : <p>{whoami.data?.artifactStore ? <code>{whoami.data.artifactStore}</code> : <span className="muted">Not reported by the API.</span>}</p>}
        </CardBody>
      </Card>

      {details.status === "loading" ? (
        <Card><TableSkeleton rows={2} columns={3} /></Card>
      ) : details.status === "error" ? (
        <ErrorState error={details.error} onRetry={() => void details.refresh()} title="Could not load applications" />
      ) : registries.length === 0 ? (
        <Card>
          <EmptyState icon={<Package size={22} aria-hidden />} title="No registries configured" description="No application uses the Kubernetes target, so no registry is referenced." />
        </Card>
      ) : (
        <ul className="infra-list" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Registries">
          {registries.map((reg) => {
            const via = reg.projects[0] ?? "";
            const state = check.states[reg.endpoint];

            return (
              <li key={reg.endpoint}>
                <Card>
                  <CardHeader title={<span className="mono infra-server__addr">{reg.endpoint}</span>} actions={<Badge tone={state?.status === "done" ? (state.ok ? "success" : "danger") : "neutral"}>{state?.status === "done" ? (state.ok ? "Last check passed" : "Last check failed") : "Not verified"}</Badge>} />
                  <CardBody>
                    <KeyValue
                      items={[
                        { label: "Authentication", value: reg.authSecret ? <span><code>{reg.authSecret}</code> <span className="muted">(secret name only)</span></span> : "Anonymous / none configured" },
                        { label: "Namespaces", value: reg.namespaces.map((n) => <code key={n}>{n} </code>) },
                        { label: "Applications", value: <span className="infra-links">{reg.projects.map((p) => <Link key={p} to={`/applications/${encodeURIComponent(p)}`}>{p}</Link>)}</span> },
                      ]}
                    />
                    <div className="infra-actions">
                      <Button icon={<ShieldCheck size={14} aria-hidden />} loading={state?.status === "running"} onClick={() => void check.run(reg.endpoint, via)} aria-label={`Run check for ${reg.endpoint}`}>
                        Run check
                      </Button>
                      <span className="muted" style={{ fontSize: "var(--text-sm)" }}>Checks {via}&apos;s kubeconfig, cluster API and registry configuration. Connection is not verified until you run it.</span>
                    </div>
                    <CheckPanel state={state} />
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Card>
        <CardHeader title="Built images (by digest)" description="Releases record only the immutable image digest, not a tag or registry reference. Latest three deployed images per application." />
        <CardBody>
          {releases.status === "loading" ? (
            <Skeleton width="60%" />
          ) : releases.status === "error" ? (
            <ErrorState error={releases.error} onRetry={() => void releases.refresh()} title="Could not load releases" />
          ) : images.length === 0 ? (
            <p className="muted">No image builds yet.</p>
          ) : (
            <div className="stack">
              {images.map(([project, list]) => (
                <div key={project}>
                  <h3 style={{ fontSize: "var(--text-md)", margin: "0 0 var(--space-2)" }}><Link to={`/applications/${encodeURIComponent(project)}`}>{project}</Link></h3>
                  <ul className="infra-digests">
                    {list.map((i) => (
                      <li key={i.id}>
                        <code title={i.digest}>{shortDigest(i.digest)}</code>
                        <span className="muted">{formatBytes(i.size)}</span>
                        <span className="muted">{timeAgo(i.at)}</span>
                        <Link to={`/releases/${encodeURIComponent(i.id)}`}>Release {i.id}</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

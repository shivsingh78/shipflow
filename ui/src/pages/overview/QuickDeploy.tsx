import { useState } from "react";
import { DeployButton } from "@/components/releases/ReleaseActions";

/** Deploy needs an application: pick one, then open the standard deploy dialog. */
export function QuickDeploy({ projects }: { projects: string[] }) {
  const [project, setProject] = useState("");
  const chosen = project || projects[0] || "";

  if (projects.length === 0) return null;

  return (
    <div className="row row--wrap" style={{ gap: "var(--space-2)" }}>
      {projects.length > 1 ? (
        <select className="select" style={{ width: "auto", maxWidth: 200 }} aria-label="Application to deploy" value={chosen} onChange={(e) => setProject(e.target.value)}>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      ) : null}
      <DeployButton key={chosen} project={chosen} label="Deploy…" variant="secondary" />
    </div>
  );
}

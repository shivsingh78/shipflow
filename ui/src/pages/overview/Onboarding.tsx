import { Plus } from "lucide-react";
import { Card, CardBody, CopyValue, LinkButton } from "@/components/ui";
import "../runs/runs.css";

/** Shown when the workspace has no applications yet. */
export function Onboarding() {
  return (
    <Card>
      <CardBody>
        <div style={{ textAlign: "center", maxWidth: 760, margin: "0 auto", padding: "var(--space-6) 0" }}>
          <h2 style={{ fontSize: "var(--text-xl)", margin: 0 }}>Ship your first application</h2>
          <p className="muted" style={{ marginTop: "var(--space-2)" }}>
            An application in ShipFlow is a Git repository plus a <code>shipflow.yml</code> that says how to build it and where to deploy it. Every run after that is a release you can inspect, cancel and roll back.
          </p>
          <ol className="steps">
            <li><strong>1. Connect a repository</strong>Point ShipFlow at an allowed Git repository.</li>
            <li><strong>2. Configure</strong>Pick the build strategy and a deployment target, and add any required secrets.</li>
            <li><strong>3. Deploy</strong>Queue the first release and watch its pipeline and logs.</li>
          </ol>
          <LinkButton to="/applications/new" variant="primary" icon={<Plus size={14} aria-hidden />}>New application</LinkButton>
          <p className="muted" style={{ marginTop: "var(--space-5)", fontSize: "var(--text-sm)" }}>Prefer the terminal?</p>
          <div className="stack--sm" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-1)" }}>
            <CopyValue value="shipflow init" />
            <CopyValue value="shipflow deploy" />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Rocket } from "lucide-react";
import { describeError } from "@/api/errors";
import type { SaveProjectResult } from "@/api/types";
import { useApi } from "@/auth/AuthProvider";
import { Banner, Button, Card, CardBody, CardHeader, useToast } from "@/components/ui";
import { SecretValueForm } from "./SecretDialog";
import { TargetCheckPanel } from "./TargetCheck";

/** After the application exists: set required secrets (write-only), optionally check the target, then deploy or stop. */
export function CreatedPanel({ result, secretsEnabled }: { result: SaveProjectResult; secretsEnabled: boolean | undefined }) {
  const api = useApi();
  const navigate = useNavigate();
  const toast = useToast();
  const [done, setDone] = useState<string[]>([]);
  const [deploying, setDeploying] = useState(false);
  const name = result.project.name;
  const missing = result.missingSecrets.filter((n) => !done.includes(n));

  const deploy = async () => {
    setDeploying(true);

    try {
      const release = await api.deploy({ project: name });

      toast.success("Deployment queued", `Release ${release.release_id} is waiting for a worker.`);
      void navigate(`/releases/${release.release_id}`);
    } catch (caught) {
      toast.error("Could not queue the deployment", describeError(caught));
      setDeploying(false);
    }
  };

  return (
    <div className="stack">
      <Banner tone="success" title={`Application ${name} created`}>The configuration was validated and saved. Nothing has been built or deployed yet.</Banner>

      {result.requiredSecrets.length > 0 ? (
        <Card>
          <CardHeader title="Required secrets" description="Write-only: values are stored encrypted and never shown again." />
          <CardBody>
            {secretsEnabled === false ? <Banner tone="warning" title="Secret storage is disabled on this server">Values cannot be stored until the server has a secret encryption key.</Banner> : null}
            {result.requiredSecrets.map((secret) => {
              const set = !missing.includes(secret);

              return (
                <div key={secret} className="secret-row">
                  <div className="row"><code style={{ fontWeight: 600 }}>{secret}</code><span className={set ? "subtle" : "field__error"}>{set ? "Set" : "Not set"}</span></div>
                  {!set && secretsEnabled !== false ? (
                    <SecretValueForm project={name} name={secret} bare multilineDefault={/PRIVATE_KEY|KUBECONFIG|AUTH/.test(secret)} onSaved={() => setDone((d) => [...d, secret])} />
                  ) : null}
                </div>
              );
            })}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Check the deployment target" description="Optional, read-only diagnostics: can ShipFlow reach the target?" />
        <CardBody><TargetCheckPanel project={name} /></CardBody>
      </Card>

      <div className="row row--wrap">
        <Button variant="primary" icon={<Rocket size={14} aria-hidden />} loading={deploying} disabled={missing.length > 0} onClick={() => void deploy()}>Deploy now</Button>
        <Button onClick={() => void navigate(`/applications/${name}`)} disabled={deploying}>Open application without deploying</Button>
        {missing.length > 0 ? <span className="subtle">Set the required secrets above to enable deployment.</span> : null}
      </div>
    </div>
  );
}

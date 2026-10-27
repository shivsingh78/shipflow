import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Pencil } from "lucide-react";
import { Banner, Button, useToast } from "@/components/ui";
import { ConfigEditor } from "../components/ConfigEditor";
import { ConfigView } from "../components/ConfigView";
import { useApplication } from "../context";
import "../applications.css";

export default function ConfigurationTab() {
  const app = useApplication();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(params.get("edit") === "1");
  const [missing, setMissing] = useState<string[]>([]);

  const stop = () => {
    setEditing(false);

    if (params.has("edit")) setParams({}, { replace: true });
  };

  if (editing) {
    return (
      <ConfigEditor
        key={app.project.updated_at}
        project={app.project}
        onCancel={stop}
        onSaved={(result) => {
          setMissing(result.missingSecrets);
          toast.success("Configuration saved", `${result.project.name} was validated and updated.`);
          stop();
          void app.refresh();
        }}
      />
    );
  }

  return (
    <div className="stack">
      {missing.length > 0 ? <Banner tone="warning" title="New secrets are required">Set {missing.join(", ")} on the Environment Variables tab before deploying.</Banner> : null}
      <div className="row row--between row--wrap">
        <p className="muted">This is the configuration ShipFlow stores for this application (shipflow.yml). It never contains secret values.</p>
        <Button variant="primary" icon={<Pencil size={14} aria-hidden />} onClick={() => setEditing(true)}>Edit configuration</Button>
      </div>
      <ConfigView config={app.project.config} />
    </div>
  );
}

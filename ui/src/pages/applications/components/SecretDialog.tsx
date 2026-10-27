import { useState } from "react";
import { describeError } from "@/api/errors";
import { useApi } from "@/auth/AuthProvider";
import { Banner, Button, Dialog, SecretField, useToast } from "@/components/ui";

/** Value entry for one secret. Write-only: the field starts empty, is never prefilled, and is cleared as soon as the value is sent. */
export function SecretValueForm({ project, name, multilineDefault = false, onSaved, onCancel, bare = false }: { project: string; name: string; multilineDefault?: boolean; onSaved: () => void; onCancel?: () => void; bare?: boolean }) {
  const api = useApi();
  const toast = useToast();
  const [value, setValue] = useState("");
  const [multiline, setMultiline] = useState(multilineDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (value === "") {
      setError("Enter a value. Empty secrets are not stored.");

      return;
    }

    setBusy(true);
    setError(null);

    try {
      await api.setSecret(project, name, value);
      setValue("");
      toast.success("Secret saved", `${name} is stored encrypted. Its value cannot be shown again.`);
      onSaved();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SecretField
        label={bare ? `Value for ${name}` : "Value"}
        value={value}
        onChange={setValue}
        multiline={multiline}
        error={error}
        hint="Write-only. The value is stored encrypted on the server and is never shown again."
      />
      <label className="check">
        <input type="checkbox" checked={multiline} onChange={(e) => setMultiline(e.target.checked)} />
        <span>Multi-line value (private keys, kubeconfig)</span>
      </label>
      <div className="row">
        <Button type="submit" variant="primary" loading={busy} disabled={value === ""}>
          Save {name}
        </Button>
        {onCancel ? <Button onClick={() => { setValue(""); onCancel(); }} disabled={busy}>Cancel</Button> : null}
      </div>
    </form>
  );
}

export function SetSecretDialog({ project, name, open, onClose, onSaved, multilineDefault = false, replacing = false }: { project: string; name: string; open: boolean; onClose: () => void; onSaved: () => void; multilineDefault?: boolean; replacing?: boolean }) {
  return (
    <Dialog open={open} onClose={onClose} title={`${replacing ? "Replace" : "Set"} secret ${name}`}>
      {open ? (
        <div className="stack">
          {replacing ? <Banner tone="info">The stored value is never shown. Saving replaces it.</Banner> : null}
          <SecretValueForm
            project={project}
            name={name}
            multilineDefault={multilineDefault}
            onCancel={onClose}
            onSaved={() => {
              onSaved();
              onClose();
            }}
          />
        </div>
      ) : null}
    </Dialog>
  );
}

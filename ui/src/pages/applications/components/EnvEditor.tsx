import { Plus, X } from "lucide-react";
import { Banner, Button, IconButton } from "@/components/ui";
import type { EnvRow, FieldErrors } from "../lib/configForm";

/** Edit NAME=value pairs. Values are PUBLIC: they are stored in the project configuration. */
export function EnvEditor({ label, prefix, rows, onChange, errors }: { label: string; prefix: "build.env" | "runtime.env"; rows: EnvRow[]; onChange: (rows: EnvRow[]) => void; errors: FieldErrors }) {
  const update = (index: number, patch: Partial<EnvRow>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const general = errors.get(prefix);

  return (
    <fieldset className="env-editor">
      <legend className="field__label">{label}</legend>
      <Banner tone="warning" title="Public values only">
        These values are stored in the project configuration and visible to anyone who can read it. Never put passwords, tokens or keys here: use a secret instead.
      </Banner>
      {rows.length === 0 ? <p className="muted">No variables.</p> : null}
      {rows.map((row, index) => {
        const error = errors.get(`${prefix}.${row.key.trim()}`);

        return (
          <div key={index} className="env-row">
            <div className="env-row__inputs">
              <input className="input mono" aria-label={`${label} name ${index + 1}`} aria-invalid={error ? true : undefined} placeholder="NAME" value={row.key} onChange={(e) => update(index, { key: e.target.value })} autoComplete="off" spellCheck={false} />
              <input className="input mono" aria-label={`${label} value ${index + 1}`} placeholder="value" value={row.value} onChange={(e) => update(index, { value: e.target.value })} autoComplete="off" spellCheck={false} />
              <IconButton label={`Remove ${label} row ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                <X size={15} aria-hidden />
              </IconButton>
            </div>
            {error ? <div className="field__error" role="alert">{row.key.trim()}: {error}</div> : null}
          </div>
        );
      })}
      {general ? <div className="field__error" role="alert">{general}</div> : null}
      <div>
        <Button size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => onChange([...rows, { key: "", value: "" }])}>
          Add variable
        </Button>
      </div>
    </fieldset>
  );
}

import { useId, useState } from "react";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Eye, EyeOff, Search } from "lucide-react";

interface FieldShellProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
}

/** Label + control + hint/error, wired for accessibility (id, aria-describedby, aria-invalid). */
export function Field({ label, hint, error, required, children }: FieldShellProps & { children: (props: { id: string; "aria-describedby": string | undefined; "aria-invalid": true | undefined }) => ReactNode }) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? <span aria-hidden style={{ color: "var(--danger)" }}> *</span> : null}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? <div className="field__hint" id={`${id}-hint`}>{hint}</div> : null}
      {error ? <div className="field__error" id={`${id}-error`} role="alert">{error}</div> : null}
    </div>
  );
}

export function TextField({ label, hint, error, required, ...input }: FieldShellProps & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {(a11y) => <input className="input" required={required} {...a11y} {...input} />}
    </Field>
  );
}

export function SelectField({ label, hint, error, required, children, ...select }: FieldShellProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {(a11y) => (
        <select className="select" required={required} {...a11y} {...select}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function TextAreaField({ label, hint, error, required, ...area }: FieldShellProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {(a11y) => <textarea className="textarea" required={required} {...a11y} {...area} />}
    </Field>
  );
}

/**
 * Write-only secret entry. The field is always empty on load (stored values are
 * never sent to the browser) and masks what is typed unless "show" is toggled.
 */
export function SecretField({ label, hint, error, required, multiline = false, value, onChange, ...rest }: FieldShellProps & { multiline?: boolean; value: string; onChange: (value: string) => void; placeholder?: string; disabled?: boolean }) {
  const [shown, setShown] = useState(false);

  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {(a11y) =>
        multiline ? (
          <textarea
            className="textarea"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            // Multi-line secrets (private keys) are masked with a CSS text-security fallback.
            style={shown ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
            {...a11y}
            {...rest}
          />
        ) : (
          <div className="input-group">
            <input className="input" type={shown ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" spellCheck={false} {...a11y} {...rest} />
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShown((s) => !s)} aria-pressed={shown} aria-label={shown ? "Hide value" : "Show value"}>
              {shown ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
            </button>
          </div>
        )
      }
    </Field>
  );
}

export function SearchInput({ value, onChange, placeholder = "Search", label = "Search" }: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string }) {
  return (
    <div className="search">
      <Search size={15} aria-hidden />
      <input className="input" type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} />
    </div>
  );
}

export function Checkbox({ label, description, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...input} />
      <span>
        <span>{label}</span>
        {description ? <span className="field__hint" style={{ display: "block" }}>{description}</span> : null}
      </span>
    </label>
  );
}

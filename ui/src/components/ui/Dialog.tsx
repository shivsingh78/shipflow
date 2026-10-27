import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/** Modal built on the native <dialog>: focus trap, Escape to close, backdrop. */
export function Dialog({ open, onClose, title, children, footer, wide = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;

    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " dialog--wide" : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      {open ? (
        <>
          <div className="dialog__head">
            <h2 className="dialog__title" id={titleId}>{title}</h2>
          </div>
          <div className="dialog__body">{children}</div>
          {footer ? <div className="dialog__foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  /** Ask the user to type this text before the action is enabled (destructive actions). */
  confirmText?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Dialog open={props.open} onClose={props.onClose} title={props.title}>
      {props.open ? <ConfirmBody {...props} /> : null}
    </Dialog>
  );
}

/** Rendered only while the dialog is open, so its state resets every time. */
function ConfirmBody({ description, confirmLabel, tone = "primary", confirmText, onConfirm, onClose }: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const allowed = !confirmText || typed === confirmText;

  const confirm = async () => {
    setBusy(true);

    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="stack--sm" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <div>{description}</div>
        {confirmText ? (
          <label className="field">
            <span className="field__hint">Type <code>{confirmText}</code> to confirm</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label={`Type ${confirmText} to confirm`} />
          </label>
        ) : null}
      </div>
      <div className="dialog__foot" style={{ margin: "var(--space-4) calc(var(--space-5) * -1) calc(var(--space-4) * -1)" }}>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={tone === "danger" ? "danger" : "primary"} onClick={() => void confirm()} loading={busy} disabled={!allowed}>
          {confirmLabel}
        </Button>
      </div>
    </>
  );
}

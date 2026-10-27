import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import type { Tone } from "@/lib/status";

interface ToastItem {
  id: number;
  tone: Tone;
  title: string;
  description?: string | undefined;
}

interface ToastApi {
  push(toast: { tone?: Tone; title: string; description?: string }): void;
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICON = { success: CheckCircle2, danger: XCircle, warning: AlertTriangle, info: Info, neutral: Info } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((t) => t.id !== id)), []);

  const push = useCallback<ToastApi["push"]>(({ tone = "info", title, description }) => {
    const id = nextId.current++;

    setItems((current) => [...current.slice(-3), { id, tone, title, description }]);
    setTimeout(() => dismiss(id), tone === "danger" ? 9000 : 5000);
  }, [dismiss]);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, description) => push({ tone: "success", title, ...(description ? { description } : {}) }),
      error: (title, description) => push({ tone: "danger", title, ...(description ? { description } : {}) }),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((item) => (
          <ToastView key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = ICON[item.tone];

  return (
    <div className={`toast toast--${item.tone}`} role={item.tone === "danger" ? "alert" : "status"}>
      <Icon size={18} aria-hidden className="toast__icon" />
      <div className="toast__body">
        <div className="toast__title">{item.title}</div>
        {item.description ? <div className="toast__desc">{item.description}</div> : null}
      </div>
      <button type="button" className="icon-btn" onClick={onDismiss} aria-label="Dismiss notification">
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);

  if (!value) throw new Error("useToast must be used inside ToastProvider");

  return value;
}

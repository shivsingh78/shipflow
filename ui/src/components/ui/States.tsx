import type { CSSProperties, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, XCircle } from "lucide-react";
import { describeError } from "@/api/errors";
import { Button } from "./Button";

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon ? <div className="empty__icon">{icon}</div> : null}
      <h2 className="empty__title">{title}</h2>
      {description ? <p className="empty__desc">{description}</p> : null}
      {action}
    </div>
  );
}

/** A failed load, with the reason and a retry. */
export function ErrorState({ error, onRetry, title = "Could not load this data" }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="empty" role="alert">
      <div className="empty__icon" style={{ color: "var(--danger)", background: "var(--danger-soft)" }}>
        <XCircle size={22} aria-hidden />
      </div>
      <h2 className="empty__title">{title}</h2>
      <p className="empty__desc">{describeError(error)}</p>
      {onRetry ? (
        <Button onClick={onRetry} icon={<RefreshCw size={14} aria-hidden />}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 14, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return <span className="skeleton" style={{ width, height, ...style }} aria-hidden />;
}

export function TableSkeleton({ rows = 5, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="stack--sm" style={{ padding: "var(--space-4)", display: "flex", flexDirection: "column" }} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="row" style={{ gap: "var(--space-4)" }}>
          {Array.from({ length: columns }, (_, col) => (
            <Skeleton key={col} width={col === 0 ? "22%" : `${12 + ((row + col) % 3) * 6}%`} height={16} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span role="status" className="row muted">
      <Loader2 size={16} className="spin" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

type BannerTone = "info" | "warning" | "danger" | "success";

const BANNER_ICON = { info: Info, warning: AlertTriangle, danger: XCircle, success: CheckCircle2 } as const;

export function Banner({ tone = "info", title, children, action }: { tone?: BannerTone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = BANNER_ICON[tone];

  return (
    <div className={`banner banner--${tone}`} role={tone === "danger" ? "alert" : "note"}>
      <Icon size={18} aria-hidden />
      <div className="grow">
        {title ? <div className="banner__title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

/** A feature the backend does not offer yet: clearly labelled, never interactive. */
export function ComingSoon({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Banner tone="info" title={`${title} — not available yet`}>
      {children}
    </Banner>
  );
}

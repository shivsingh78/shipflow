import type { ReactNode } from "react";

export function Card({ children, className = "", interactive = false }: { children: ReactNode; className?: string; interactive?: boolean }) {
  return <section className={`card${interactive ? " card--interactive" : ""} ${className}`.trim()}>{children}</section>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="card__header">
      <div className="grow">
        <h2 className="card__title">{title}</h2>
        {description ? <p className="muted" style={{ fontSize: "var(--text-sm)" }}>{description}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ children, flush = false }: { children: ReactNode; flush?: boolean }) {
  return <div className={`card__body${flush ? " card__body--flush" : ""}`}>{children}</div>;
}

import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Skeleton } from "@/components/ui";
import type { AttentionItem } from "./attention";

/** Applications whose latest release failed or that lack a required secret. */
export function AttentionCard({ items, loading }: { items: AttentionItem[]; loading: boolean }) {
  const clear = !loading && items.length === 0;

  return (
    <section className={`card needs${clear ? " needs--clear" : ""}`} aria-labelledby="attention-title">
      <header className="needs__head">
        {clear ? <CheckCircle2 size={18} aria-hidden className="needs__icon needs__icon--ok" /> : <AlertTriangle size={18} aria-hidden className="needs__icon" />}
        <div>
          <h2 className="card__title" id="attention-title">{clear ? "All clear" : "Needs attention"}</h2>
          <p className="card__sub">{clear ? "No failed releases or missing secrets" : "Failed latest release or missing secrets"}</p>
        </div>
      </header>

      {loading ? <Skeleton height={64} /> : null}

      <ul className="needs__list">
        {items.map((item) => (
          <li key={item.project} className="needs__item">
            <Link to={`/applications/${encodeURIComponent(item.project)}`} className="needs__app">{item.project}</Link>
            <p className="needs__reason">{item.reasons.join(" · ")}.</p>
            {item.failedReleaseId ? (
              <Link to={`/releases/${item.failedReleaseId}?tab=logs`} className="needs__action">View failure log</Link>
            ) : (
              <Link to={`/applications/${encodeURIComponent(item.project)}/environment`} className="needs__action">Set secrets</Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui";

const PLANNED = ["Preview environments", "SBOM generation", "Canary releases"];

/** Roadmap items, kept visibly apart from what this instance actually does. */
export function FutureCapabilities() {
  return (
    <section className="card future" aria-labelledby="future-title">
      <header className="future__head">
        <div>
          <h2 className="card__title" id="future-title">Future capabilities</h2>
          <p className="card__sub">Planned, not active in this workspace</p>
        </div>
        <Sparkles size={16} aria-hidden className="muted" />
      </header>
      <ul className="future__chips">
        {PLANNED.map((name) => <li key={name}><Badge>{name}</Badge></li>)}
      </ul>
      <p className="muted future__note">Roadmap items are shown separately from configured control-plane capabilities.</p>
    </section>
  );
}

import { ExternalLink as Icon } from "lucide-react";

/** Link out to a repository or live site. Opens in a new tab without leaking the opener. */
export function ExternalLink({ href, children, label }: { href: string; children: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="ext-link" title={href} onClick={(e) => e.stopPropagation()} aria-label={label ?? `${children} (opens in a new tab)`}>
      <span>{children}</span>
      <Icon size={12} aria-hidden />
    </a>
  );
}

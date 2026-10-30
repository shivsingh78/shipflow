import { Workflow } from "lucide-react";

/** The ShipFlow mark: the workflow glyph on a soft teal tile (Flowstep reference). */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden>
      <Workflow size={Math.round(size * 0.625)} strokeWidth={2} />
    </span>
  );
}

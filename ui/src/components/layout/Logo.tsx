import { Rocket } from "lucide-react";

/** The ShipFlow mark: a rocket on an orange rounded square. */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden>
      <Rocket size={Math.round(size * 0.5)} strokeWidth={2.2} />
    </span>
  );
}

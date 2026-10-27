/** The ShipFlow mark: a sail over a wave. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="8" fill="#4f6df5" />
      <path d="M16 6v14M16 6l8 11h-8M8 22c2.2 2.2 4.6 2.2 8 0s5.8-2.2 8 0" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

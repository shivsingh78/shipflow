const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600_000],
  ["month", 30 * 24 * 3600_000],
  ["day", 24 * 3600_000],
  ["hour", 3600_000],
  ["minute", 60_000],
];

/** "5 minutes ago", "yesterday". */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";

  const diff = Date.parse(iso) - now;

  if (Number.isNaN(diff)) return "—";
  if (Math.abs(diff) < 45_000) return "just now";

  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }

  return rtf.format(Math.round(diff / 60_000), "minute");
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";

  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";

  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour12: false });
}

/** "1m 05s", "42s", "2h 03m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0 || Number.isNaN(ms)) return "—";

  const seconds = Math.round(ms / 1000);

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export const shortSha = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : "—");

/** sha256:abcdef012345… */
export function shortDigest(digest: string | null | undefined): string {
  if (!digest) return "—";

  const [algorithm, hex] = digest.split(":");

  return hex ? `${algorithm}:${hex.slice(0, 12)}…` : digest.slice(0, 19);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "acme/orders-api" from a repository URL. */
export function repoName(url: string): string {
  try {
    const { pathname } = new URL(url);

    return pathname.replace(/^\/|\.git$|\/$/g, "") || url;
  } catch {
    return url;
  }
}

export const pluralize = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

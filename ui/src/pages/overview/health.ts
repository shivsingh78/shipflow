import type { Release, ReleaseStatus } from "@/api/types";
import { releaseDurationMs } from "@/lib/derive";

export interface HealthBar {
  id: string;
  status: ReleaseStatus;
  /** Bar height as a percentage of the chart (taller = longer run). */
  heightPct: number;
  durationMs: number | null;
  mode: Release["mode"];
}

/** The window the chart and the stat tiles describe. */
export const HEALTH_WINDOW = 45;

const MIN_PCT = 28;
const SPAN_PCT = 62;
const UNKNOWN_PCT = 18;

/**
 * Bars for the most recent releases, oldest first (so the newest is at the right).
 * Height is the run's duration relative to the longest in the window; releases
 * without a duration (queued) get a short placeholder bar.
 */
export function healthBars(releases: Release[], size = HEALTH_WINDOW, now = Date.now()): HealthBar[] {
  const recent = releases.slice(0, size).reverse();
  const durations = recent.map((r) => releaseDurationMs(r, now));
  const longest = Math.max(1, ...durations.map((d) => d ?? 0));

  return recent.map((release, index) => {
    const durationMs = durations[index] ?? null;

    return {
      id: release.release_id,
      status: release.status,
      mode: release.mode,
      durationMs,
      heightPct: durationMs === null ? UNKNOWN_PCT : Math.round(MIN_PCT + SPAN_PCT * (durationMs / longest)),
    };
  });
}

export interface ReleaseMetrics {
  /** Share of FINISHED releases that succeeded (0-100), or null before any finished. */
  successRatePct: number | null;
  errorRatePct: number | null;
  medianDurationMs: number | null;
  /** Releases per day across the window's span, or null with fewer than two releases. */
  throughputPerDay: number | null;
  finished: number;
}

const DAY_MS = 86_400_000;

/**
 * Headline numbers for the Overview, derived ONLY from release records. Cancelled
 * releases are neither a success nor a failure; queued/running ones are not finished.
 */
export function releaseMetrics(releases: Release[], now = Date.now()): ReleaseMetrics {
  const finished = releases.filter((r) => r.status === "SUCCESS" || r.status === "FAILED");
  const succeeded = finished.filter((r) => r.status === "SUCCESS").length;
  const durations = finished.map((r) => releaseDurationMs(r, now)).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length === 0 ? null : durations.length % 2 === 1 ? (durations[middle] as number) : ((durations[middle - 1] as number) + (durations[middle] as number)) / 2;
  const times = releases.map((r) => Date.parse(r.created_at)).filter((t) => !Number.isNaN(t));
  const spanDays = times.length >= 2 ? Math.max(1, (Math.max(...times) - Math.min(...times)) / DAY_MS) : null;

  return {
    successRatePct: finished.length === 0 ? null : Math.round((succeeded / finished.length) * 1000) / 10,
    errorRatePct: finished.length === 0 ? null : Math.round(((finished.length - succeeded) / finished.length) * 1000) / 10,
    medianDurationMs: median,
    throughputPerDay: spanDays === null ? null : Math.round((releases.length / spanDays) * 10) / 10,
    finished: finished.length,
  };
}

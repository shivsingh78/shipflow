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

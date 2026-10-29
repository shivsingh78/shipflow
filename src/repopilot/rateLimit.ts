/**
 * Fixed-window rate limiter. In-memory, so limits apply per API process;
 * ShipFlow runs one API process per instance. A multi-instance deployment
 * would need a shared store behind the same interface.
 */

export interface RateRule {
  windowMs: number;
  max: number;
}

export interface RateDecision {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  hit(key: string, rule: RateRule): RateDecision;
}

const MAX_TRACKED_KEYS = 10_000;

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();

  return {
    hit(key, rule) {
      const time = now();
      const current = windows.get(key);

      if (windows.size >= MAX_TRACKED_KEYS) {
        for (const [k, w] of windows) {
          if (time - w.start >= rule.windowMs) windows.delete(k);
        }

        // Still full of live windows: refuse rather than grow without bound.
        if (windows.size >= MAX_TRACKED_KEYS && !windows.has(key)) {
          return { ok: false, remaining: 0, retryAfterSec: Math.ceil(rule.windowMs / 1000) };
        }
      }

      if (!current || time - current.start >= rule.windowMs) {
        windows.set(key, { start: time, count: 1 });

        return { ok: true, remaining: rule.max - 1, retryAfterSec: 0 };
      }

      current.count += 1;

      if (current.count > rule.max) {
        return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((current.start + rule.windowMs - time) / 1000)) };
      }

      return { ok: true, remaining: rule.max - current.count, retryAfterSec: 0 };
    },
  };
}

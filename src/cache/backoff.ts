const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Delay after the first failure; it doubles with every further one. */
export const BACKOFF_BASE_MS = MINUTE;

/** Upper bound of the exponential backoff. */
export const BACKOFF_MAX_MS = 30 * MINUTE;

/**
 * Delay before the next attempt after `failures` consecutive failures.
 *
 * The exponential backoff is capped at 30 minutes. A `Retry-After` from the
 * server is always honored, so it may lift the delay above that cap.
 */
export function retryDelayMs(failures: number, retryAfterMs: number | null = null): number {
  const exponent = Math.max(failures - 1, 0);
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
  if (retryAfterMs === null || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
    return backoff;
  }
  return Math.max(backoff, retryAfterMs);
}

const DELTA_SECONDS = /^\d+$/;

/**
 * Parses a `Retry-After` header: delta-seconds or an HTTP date.
 * Returns the wait in ms, or `null` when the header is absent or malformed.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  const value = header?.trim();
  if (!value) {
    return null;
  }
  if (DELTA_SECONDS.test(value)) {
    return Number(value) * SECOND;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(date - nowMs, 0);
}

import type { FetchResult } from "../cache/sharedCache";
import type { BankedResets, QuotaSnapshot, QuotaWindow } from "../model";

/** `windowDurationMins` of the two windows; the primary/secondary order says nothing. */
export const FIVE_HOUR_WINDOW_MINS = 300;
export const WEEK_WINDOW_MINS = 10080;

export const ERROR_INVALID_RATE_LIMITS_RESPONSE = "invalid_rate_limits_response";

const CREDIT_STATUS_AVAILABLE = "available";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A unix time in seconds, as ms; `null` when it is not a positive number. */
function secondsToMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

function parseWindow(value: unknown): { durationMins: number; window: QuotaWindow } | null {
  if (!isRecord(value)) {
    return null;
  }
  const { usedPercent, windowDurationMins } = value;
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    typeof windowDurationMins !== "number"
  ) {
    return null;
  }
  return {
    durationMins: windowDurationMins,
    window: { usedPercent: Math.round(usedPercent), resetsAt: secondsToMs(value.resetsAt) },
  };
}

/** The `primary` or `secondary` window whose duration is `durationMins`. */
function windowByDuration(bucket: Record<string, unknown>, durationMins: number): QuotaWindow | null {
  for (const candidate of [bucket.primary, bucket.secondary]) {
    const parsed = parseWindow(candidate);
    if (parsed !== null && parsed.durationMins === durationMins) {
      return parsed.window;
    }
  }
  return null;
}

/**
 * The redeemable resets: `availableCount` is the count, the earliest expiry is
 * the minimum `expiresAt` of the `available` credits, and a credit without an
 * `expiresAt` never expires. `null` when the block is absent or malformed.
 */
export function parseResetCredits(value: unknown): BankedResets | null {
  if (!isRecord(value)) {
    return null;
  }
  const { availableCount, credits } = value;
  if (typeof availableCount !== "number" || !Number.isSafeInteger(availableCount) || availableCount < 0) {
    return null;
  }
  let nextExpiresAt: number | null = null;
  for (const credit of Array.isArray(credits) ? credits : []) {
    if (!isRecord(credit) || credit.status !== CREDIT_STATUS_AVAILABLE) {
      continue;
    }
    const expiresAt = secondsToMs(credit.expiresAt);
    if (expiresAt !== null) {
      nextExpiresAt = nextExpiresAt === null ? expiresAt : Math.min(nextExpiresAt, expiresAt);
    }
  }
  return { count: availableCount, nextExpiresAt };
}

/**
 * Turns the `account/rateLimits/read` result (`GetAccountRateLimitsResponse`)
 * into a snapshot. At least one of the two windows is required; a missing
 * window or reset-credit block is left out. Never throws.
 */
export function parseRateLimits(result: unknown, name: string): FetchResult {
  if (!isRecord(result) || !isRecord(result.rateLimits)) {
    return { ok: false, error: ERROR_INVALID_RATE_LIMITS_RESPONSE };
  }
  const fiveHour = windowByDuration(result.rateLimits, FIVE_HOUR_WINDOW_MINS);
  const week = windowByDuration(result.rateLimits, WEEK_WINDOW_MINS);
  if (fiveHour === null && week === null) {
    return { ok: false, error: ERROR_INVALID_RATE_LIMITS_RESPONSE };
  }
  const banked = parseResetCredits(result.rateLimitResetCredits);
  const snapshot: QuotaSnapshot = {
    name,
    ...(fiveHour && { fiveHour }),
    ...(week && { week }),
    ...(banked && { banked }),
  };
  return { ok: true, snapshot };
}

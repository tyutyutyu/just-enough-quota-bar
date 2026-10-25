/**
 * Quota data of one provider, as consumed by the format renderer.
 *
 * Every point in time is a unix timestamp in milliseconds. A missing block or
 * a `null` field means that the source did not report the value.
 */
export interface QuotaWindow {
  /** Used share of the window, 0-100. */
  readonly usedPercent: number | null;
  readonly resetsAt: number | null;
}

export interface BankedResets {
  /** Number of redeemable resets. */
  readonly count: number | null;
  /** Expiry of the earliest-expiring redeemable reset. */
  readonly nextExpiresAt: number | null;
}

export type AnnouncedKind = "announced" | "hinted" | "estimate";

export interface AnnouncedReset {
  readonly next: number | null;
  readonly kind: AnnouncedKind | null;
  readonly last: number | null;
  /** Probability of a reset within 24 hours, 0-100. */
  readonly p24: number | null;
  /** Probability of a reset within 48 hours, 0-100. */
  readonly p48: number | null;
  /**
   * Start of the UTC day the tracker estimates for the next reset. It is shown
   * as `next` only when estimates are enabled and nothing is announced.
   */
  readonly estimate?: number | null;
}

export interface QuotaSnapshot {
  /** Display name of the provider, e.g. `Claude` or `Codex`. */
  readonly name: string;
  readonly fiveHour?: QuotaWindow;
  readonly week?: QuotaWindow;
  readonly banked?: BankedResets;
  readonly announced?: AnnouncedReset;
  /** When the source last answered successfully. */
  readonly fetchedAt?: number | null;
  /** The last fetch failed or the data is otherwise out of date. */
  readonly stale?: boolean;
  /** Non-sensitive error code of the last failed fetch, e.g. `upstream_429`. */
  readonly error?: string | null;
}

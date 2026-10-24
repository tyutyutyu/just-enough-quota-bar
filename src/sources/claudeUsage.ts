import { parseRetryAfter } from "../cache/backoff";
import type { FetchResult } from "../cache/sharedCache";
import type { BankedResets, QuotaSnapshot, QuotaWindow } from "../model";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_BETA = "oauth-2025-04-20";
/** The version of the Claude Code the sample was verified against. */
export const CLAUDE_CODE_VERSION = "2.1.296";
/** The reset inventory is gated on the request surface, so it needs the CLI identity. */
export const RESET_CREDITS_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
export const USAGE_USER_AGENT = `claude-code/${CLAUDE_CODE_VERSION}`;

/** The sample's upper bounds; a response beyond them is not trusted. */
export const MAX_RESET_CREDITS = 50;
export const MAX_RESET_GRANTS = 200;

export const ERROR_INVALID_USAGE_RESPONSE = "invalid_usage_response";
export const ERROR_NETWORK = "network_error";
export const ERROR_TIMEOUT = "timeout";

const RETRY_WITHOUT_PARAMETER_STATUSES: readonly number[] = [400, 403];
const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An ISO 8601 text with an explicit zone, or a unix time in seconds or milliseconds, as ms. */
function toTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === "string" && ISO_WITH_ZONE.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function parseWindow(value: unknown): QuotaWindow | null {
  if (!isRecord(value)) {
    return null;
  }
  const utilization =
    typeof value.utilization === "number" ? value.utilization : Number.NaN;
  const resetsAt = typeof value.resets_at === "string" ? toTimestampMs(value.resets_at) : null;
  if (!Number.isFinite(utilization) || utilization < 0 || utilization > 100 || resetsAt === null) {
    return null;
  }
  return { usedPercent: Math.round(utilization), resetsAt };
}

/** The usable resets of the `cedar_ember` block; `null` when it is absent, not eligible or implausible. */
export function parseBankedResets(payload: unknown, nowMs: number): BankedResets | null {
  const block = isRecord(payload) ? payload.cedar_ember : undefined;
  if (!isRecord(block) || block.eligible !== true || !Array.isArray(block.grants)) {
    return null;
  }
  const grants = block.grants.filter(isRecord);
  if (grants.length > MAX_RESET_GRANTS) {
    return null;
  }
  let count = 0;
  let nextExpiresAt: number | null = null;
  for (const grant of grants) {
    const left = grant.resets_left;
    const startsAt = toTimestampMs(grant.starts_at);
    const endsAt = toTimestampMs(grant.ends_at);
    if (
      typeof left !== "number" ||
      !Number.isInteger(left) ||
      left <= 0 ||
      grant.paused !== false ||
      startsAt === null ||
      endsAt === null ||
      startsAt > nowMs ||
      endsAt <= nowMs
    ) {
      continue;
    }
    count += left;
    nextExpiresAt = nextExpiresAt === null ? endsAt : Math.min(nextExpiresAt, endsAt);
  }
  return count > MAX_RESET_CREDITS ? null : { count, nextExpiresAt };
}

/**
 * Turns the usage response into a snapshot. The weekly window is required; a
 * missing five-hour window or banked block is left out. Never throws.
 */
export function parseUsage(payload: unknown, name: string, nowMs: number): FetchResult {
  if (!isRecord(payload)) {
    return { ok: false, error: ERROR_INVALID_USAGE_RESPONSE };
  }
  const week = parseWindow(payload.seven_day);
  if (week === null) {
    return { ok: false, error: ERROR_INVALID_USAGE_RESPONSE };
  }
  const fiveHour = parseWindow(payload.five_hour);
  const banked = parseBankedResets(payload, nowMs);
  const snapshot: QuotaSnapshot = {
    name,
    ...(fiveHour && { fiveHour }),
    week,
    ...(banked && { banked }),
  };
  return { ok: true, snapshot };
}

export interface UsageRequestOptions {
  readonly accessToken: string;
  readonly fetchImpl: typeof fetch;
  readonly signal: AbortSignal;
}

function request(options: UsageRequestOptions, withBankedResets: boolean): Promise<Response> {
  const url = withBankedResets ? `${CLAUDE_USAGE_URL}?cedar_ember=1` : CLAUDE_USAGE_URL;
  return options.fetchImpl(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      Accept: "application/json",
      "User-Agent": withBankedResets ? RESET_CREDITS_USER_AGENT : USAGE_USER_AGENT,
    },
    signal: options.signal,
  });
}

/** Asks with `cedar_ember=1`; a 400 or 403 is asked once more without it. */
async function requestWithFallback(options: UsageRequestOptions): Promise<Response> {
  const response = await request(options, true);
  return RETRY_WITHOUT_PARAMETER_STATUSES.includes(response.status)
    ? request(options, false)
    : response;
}

/**
 * Queries the usage endpoint. Every outcome is a result with a non-sensitive
 * code; nothing is thrown and neither the token nor the body is exposed.
 */
export async function fetchUsage(
  options: UsageRequestOptions,
  name: string,
  now: () => number,
): Promise<FetchResult> {
  let response: Response;
  try {
    response = await requestWithFallback(options);
  } catch {
    return { ok: false, error: options.signal.aborted ? ERROR_TIMEOUT : ERROR_NETWORK };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `upstream_${response.status}`,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), now()),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: ERROR_INVALID_USAGE_RESPONSE };
  }
  return parseUsage(body, name, now());
}

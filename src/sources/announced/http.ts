import { parseRetryAfter } from "../../cache/backoff";
import type { FetchResult } from "../../cache/sharedCache";

/** The trackers ask readers to name themselves and a way to reach them. */
export const PROJECT_URL = "https://github.com/tyutyutyu/just-enough-quota-bar";
const PRODUCT = "just-enough-quota-bar";

export const ERROR_INVALID_ANNOUNCED_RESPONSE = "invalid_announced_response";
export const ERROR_NETWORK = "network_error";
export const ERROR_TIMEOUT = "timeout";

/** The identifying `User-Agent` every tracker request is sent with. */
export function announcedUserAgent(version?: string): string {
  const product = version === undefined || version === "" ? PRODUCT : `${PRODUCT}/${version}`;
  return `${product} (+${PROJECT_URL})`;
}

export interface JsonRequestOptions {
  readonly fetchImpl: typeof fetch;
  readonly userAgent: string;
  readonly signal: AbortSignal;
  readonly now: () => number;
}

export type Failure = Extract<FetchResult, { ok: false }>;

export type JsonResult = { readonly ok: true; readonly body: unknown } | Failure;

/**
 * GETs `url` and parses its JSON body. Every outcome is a result with a
 * non-sensitive code; nothing is thrown and the body never reaches an error.
 */
export async function getJson(url: string, options: JsonRequestOptions): Promise<JsonResult> {
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": options.userAgent },
      signal: options.signal,
    });
  } catch {
    return { ok: false, error: options.signal.aborted ? ERROR_TIMEOUT : ERROR_NETWORK };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `upstream_${response.status}`,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), options.now()),
    };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, error: ERROR_INVALID_ANNOUNCED_RESPONSE };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i;

/** A `YYYY-MM-DD` date as the start of that UTC day, in ms. */
export function parseUtcDate(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    return null;
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  // Date.parse rolls an impossible day such as 02-31 over into the next month.
  return Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, value.length) !== value
    ? null
    : parsed;
}

/** An ISO 8601 date-time with an explicit zone, in ms. */
export function parseIsoTime(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value.trim())) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

import type { FetchResult } from "../../cache/sharedCache";
import { PROVIDER_NAMES, type ProviderId } from "../../constants";
import type { AnnouncedReset } from "../../model";
import type { AnnouncedSource, Attribution } from "../../statusbar/source";
import {
  ERROR_INVALID_ANNOUNCED_RESPONSE,
  getJson,
  isRecord,
  parseUtcDate,
  type Failure,
  type JsonResult,
} from "./http";
import { describeShape, earliestAnnounced, parseScheduled } from "./scheduled";
import type { AnnouncedProviderOptions } from "./options";

export const WHENRESET_LATEST_URL = "https://whenreset.app/api/v1/latest.json";
export const WHENRESET_FORECAST_URL = "https://whenreset.app/api/forecast";
export const WHENRESET_ATTRIBUTION: Attribution = {
  text: "Data: whenreset.app",
  url: "https://whenreset.app/",
};

const MINUTE_MS = 60_000;
export const WHENRESET_INTERVAL_MS = 30 * MINUTE_MS;
/** whenreset.app asks for at most one request every 5 minutes, in line with its cache. */
export const WHENRESET_MIN_INTERVAL_MS = 5 * MINUTE_MS;
export const WHENRESET_TIMEOUT_MS = 20_000;

const PERCENT = 100;

/** What `latest.json` tells about one product. */
export interface WhenresetLatest {
  readonly next: number | null;
  readonly last: number | null;
  readonly estimate: number | null;
  /** The raw `scheduled` field, kept only to describe its shape. */
  readonly scheduled: unknown;
}

/**
 * Reads one product of `latest.json`. `last` comes from
 * `stats.last_regular_date`, not from `latest_event`, which may be a banked
 * reset rather than a global one.
 */
export function parseWhenresetLatest(payload: unknown, product: ProviderId): WhenresetLatest | null {
  const products = isRecord(payload) ? payload.products : undefined;
  const entry = isRecord(products) ? products[product] : undefined;
  if (!isRecord(entry)) {
    return null;
  }
  const stats = isRecord(entry.stats) ? entry.stats : {};
  return {
    next: earliestAnnounced(parseScheduled(entry.scheduled)),
    last: parseUtcDate(stats.last_regular_date),
    estimate: parseUtcDate(entry.next_estimate),
    scheduled: entry.scheduled,
  };
}

function toPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value * PERCENT
    : null;
}

/** The 24 and 48 hour probabilities of `/api/forecast`, from 0-1 fractions to percent. */
export function parseWhenresetForecast(
  payload: unknown,
): Pick<AnnouncedReset, "p24" | "p48"> | null {
  if (!isRecord(payload)) {
    return null;
  }
  const probabilities = isRecord(payload.probabilities) ? payload.probabilities : {};
  return { p24: toPercent(probabilities.raw_24h), p48: toPercent(probabilities.raw_48h) };
}

const INVALID: Failure = { ok: false, error: ERROR_INVALID_ANNOUNCED_RESPONSE };

/** Loads `latest.json`; the request may be shared with the other product. */
export type WhenresetLatestLoader = (signal: AbortSignal) => Promise<JsonResult>;

/**
 * `latest.json` covers every product, so the fetches that start while its
 * request is running share that request instead of sending another. It is
 * cancelled only when every fetch waiting for it is.
 */
export function createWhenresetLatestLoader(options: AnnouncedProviderOptions): WhenresetLatestLoader {
  let running: { readonly result: Promise<JsonResult>; readonly controller: AbortController; waiting: number } | null =
    null;
  return (signal) => {
    if (running === null) {
      const controller = new AbortController();
      const request = {
        result: getJson(WHENRESET_LATEST_URL, { ...options, signal: controller.signal }),
        controller,
        waiting: 0,
      };
      running = request;
      // getJson never rejects; a finished request is not shared any more.
      void request.result.then(() => {
        running = null;
      });
    }
    const request = running;
    request.waiting += 1;
    const leave = (): void => {
      request.waiting -= 1;
      if (request.waiting === 0) {
        request.controller.abort();
      }
    };
    if (signal.aborted) {
      leave();
    } else {
      signal.addEventListener("abort", leave, { once: true });
    }
    return request.result;
  };
}

/**
 * The whenreset.app provider of one product: `latest.json` for the announced
 * and the last reset, `/api/forecast` for the probabilities.
 */
export function createWhenresetSource(
  provider: ProviderId,
  options: AnnouncedProviderOptions,
  loadLatest: WhenresetLatestLoader = createWhenresetLatestLoader(options),
): AnnouncedSource {
  let shapeLogged = false;
  const logShapeOnce = (scheduled: unknown): void => {
    if (shapeLogged || scheduled === null || scheduled === undefined) {
      return;
    }
    shapeLogged = true;
    options.log(`whenreset ${provider}: scheduled has the shape ${describeShape(scheduled)}`);
  };

  return {
    provider,
    sourceId: "whenreset",
    attribution: WHENRESET_ATTRIBUTION,
    definition: {
      id: `${provider}-whenreset`,
      intervalMs: WHENRESET_INTERVAL_MS,
      timeoutMs: WHENRESET_TIMEOUT_MS,
      minRetryMs: WHENRESET_MIN_INTERVAL_MS,
    },
    minIntervalMs: WHENRESET_MIN_INTERVAL_MS,
    fetch: async (signal): Promise<FetchResult> => {
      const forecastUrl = `${WHENRESET_FORECAST_URL}?product=${provider}`;
      const [latestBody, forecastBody] = await Promise.all([
        loadLatest(signal),
        getJson(forecastUrl, { ...options, signal }),
      ]);
      if (!latestBody.ok) {
        return latestBody;
      }
      const latest = parseWhenresetLatest(latestBody.body, provider);
      if (latest === null) {
        return INVALID;
      }
      // Logged before the forecast is checked, so a failing forecast cannot hide it.
      logShapeOnce(latest.scheduled);
      if (!forecastBody.ok) {
        return forecastBody;
      }
      const forecast = parseWhenresetForecast(forecastBody.body);
      if (forecast === null) {
        return INVALID;
      }
      return {
        ok: true,
        snapshot: {
          name: PROVIDER_NAMES[provider],
          announced: {
            next: latest.next,
            kind: latest.next === null ? null : "announced",
            last: latest.last,
            ...forecast,
            estimate: latest.estimate,
          },
        },
      };
    },
  };
}

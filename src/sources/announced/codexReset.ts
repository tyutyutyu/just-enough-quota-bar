import type { FetchResult } from "../../cache/sharedCache";
import { PROVIDER_NAMES } from "../../constants";
import type { AnnouncedReset } from "../../model";
import type { AnnouncedSource, Attribution } from "../../statusbar/source";
import { ERROR_INVALID_ANNOUNCED_RESPONSE, getJson, isRecord, parseIsoTime } from "./http";
import type { AnnouncedProviderOptions } from "./options";

export const CODEX_RESET_FORECAST_URL = "https://codex-reset.com/api/forecast";
/** codex-reset.com requires this credit, linked, on the surface that shows its data. */
export const CODEX_RESET_ATTRIBUTION: Attribution = {
  text: "Data: codex-reset.com",
  url: "https://codex-reset.com/",
};

const MINUTE_MS = 60_000;
export const CODEX_RESET_INTERVAL_MS = 30 * MINUTE_MS;
/** codex-reset.com publishes a new copy about once a minute and asks for no faster polling. */
export const CODEX_RESET_MIN_INTERVAL_MS = MINUTE_MS;
export const CODEX_RESET_TIMEOUT_MS = 20_000;

const PERCENT_MAX = 100;

function percentOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= PERCENT_MAX
    ? value
    : null;
}

/**
 * Reads `/api/forecast`: `probabilities.rounded_24h` and `rounded_48h` are
 * already percentages, `last_reset_at` is the last confirmed reset.
 */
export function parseCodexResetForecast(payload: unknown): AnnouncedReset | null {
  if (!isRecord(payload)) {
    return null;
  }
  const probabilities = isRecord(payload.probabilities) ? payload.probabilities : {};
  return {
    next: null,
    kind: null,
    last: parseIsoTime(payload.last_reset_at),
    p24: percentOrNull(probabilities.rounded_24h),
    p48: percentOrNull(probabilities.rounded_48h),
  };
}

/** The codex-reset.com provider; it only covers Codex. */
export function createCodexResetSource(options: AnnouncedProviderOptions): AnnouncedSource {
  return {
    provider: "codex",
    sourceId: "codexReset",
    attribution: CODEX_RESET_ATTRIBUTION,
    definition: {
      id: "codex-codexreset",
      intervalMs: CODEX_RESET_INTERVAL_MS,
      timeoutMs: CODEX_RESET_TIMEOUT_MS,
      minRetryMs: CODEX_RESET_MIN_INTERVAL_MS,
    },
    minIntervalMs: CODEX_RESET_MIN_INTERVAL_MS,
    fetch: async (signal): Promise<FetchResult> => {
      const response = await getJson(CODEX_RESET_FORECAST_URL, { ...options, signal });
      if (!response.ok) {
        return response;
      }
      const announced = parseCodexResetForecast(response.body);
      return announced === null
        ? { ok: false, error: ERROR_INVALID_ANNOUNCED_RESPONSE }
        : { ok: true, snapshot: { name: PROVIDER_NAMES.codex, announced } };
    },
  };
}

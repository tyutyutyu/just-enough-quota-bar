import { parseRetryAfter } from "../cache/backoff";
import type { FetchResult, Fetcher } from "../cache/sharedCache";
import { PROVIDER_NAMES } from "../constants";
import type { BankedResets, QuotaSnapshot, QuotaWindow } from "../model";
import type { QuotaSource } from "../statusbar/source";
import { readCodexAuth, defaultCodexAuthEnvironment, type CodexAuthEnvironment } from "./codexAuth";
import { FIVE_HOUR_WINDOW_MINS, WEEK_WINDOW_MINS } from "./codexRateLimits";

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

/** Every probe uses a little quota, so it never runs more often than this, whatever the setting says. */
export const CODEX_PROBE_MIN_INTERVAL_MS = 10 * MINUTE_MS;
export const CODEX_PROBE_DEFAULT_INTERVAL_MS = CODEX_PROBE_MIN_INTERVAL_MS;
/** Three requests may follow each other, so the budget is larger than the app-server's. */
export const CODEX_PROBE_TIMEOUT_MS = 45 * SECOND_MS;
/**
 * The models and responses requests answer within this, inside the overall
 * budget, so a stalled probe still reports its own timeout and waits its interval.
 */
export const CODEX_PROBE_QUOTA_TIMEOUT_MS = 35 * SECOND_MS;
/** The optional reset-credits request gets this much; a stall only leaves the banked resets out. */
export const CODEX_RESET_CREDITS_TIMEOUT_MS = 5 * SECOND_MS;

export const ERROR_MODELS_INVALID = "models_invalid";
export const ERROR_INVALID_QUOTA_HEADERS = "invalid_quota_headers";
export const ERROR_NETWORK = "network_error";
export const ERROR_TIMEOUT = "timeout";

const PROBE_PROMPT = "reply ok";
const PROBE_INSTRUCTIONS = "You are a coding assistant.";
const CREDIT_STATUS_AVAILABLE = "available";
const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The probe interval for a `jeqb.codex.probeIntervalMinutes` value: never below 10 minutes. */
export function probeIntervalMs(minutes: unknown): number {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
    return CODEX_PROBE_DEFAULT_INTERVAL_MS;
  }
  return Math.max(minutes * MINUTE_MS, CODEX_PROBE_MIN_INTERVAL_MS);
}

function headerNumber(headers: Headers, name: string): number | null {
  const text = headers.get(name)?.trim() ?? "";
  if (text === "") {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

interface HeaderWindow {
  readonly windowMinutes: number;
  readonly window: QuotaWindow;
}

/** One complete `x-codex-<prefix>-*` window; `null` when any of its three headers is missing or out of range. */
function windowFromHeaders(headers: Headers, prefix: string, nowMs: number): HeaderWindow | null {
  const usedPercent = headerNumber(headers, `x-codex-${prefix}-used-percent`);
  const resetAfterSeconds = headerNumber(headers, `x-codex-${prefix}-reset-after-seconds`);
  const windowMinutes = headerNumber(headers, `x-codex-${prefix}-window-minutes`);
  if (
    usedPercent === null ||
    usedPercent < 0 ||
    usedPercent > 100 ||
    resetAfterSeconds === null ||
    resetAfterSeconds < 0 ||
    windowMinutes === null ||
    windowMinutes <= 0
  ) {
    return null;
  }
  return {
    windowMinutes: Math.floor(windowMinutes),
    window: {
      usedPercent: Math.round(usedPercent),
      resetsAt: nowMs + Math.floor(resetAfterSeconds) * SECOND_MS,
    },
  };
}

/** The window of `windowMinutes`, whether the server calls it primary or secondary. */
function windowByMinutes(windows: readonly HeaderWindow[], windowMinutes: number): QuotaWindow | null {
  return windows.find((candidate) => candidate.windowMinutes === windowMinutes)?.window ?? null;
}

/**
 * The 5-hour and weekly windows of the `x-codex-{primary,secondary}-*` response
 * headers, found by their window length and not by their order. `null` when
 * neither is complete.
 */
export function parseQuotaHeaders(
  headers: Headers,
  name: string,
  nowMs: number,
): Pick<QuotaSnapshot, "name" | "fiveHour" | "week"> | null {
  const windows = ["primary", "secondary"]
    .map((prefix) => windowFromHeaders(headers, prefix, nowMs))
    .filter((window): window is HeaderWindow => window !== null);
  const fiveHour = windowByMinutes(windows, FIVE_HOUR_WINDOW_MINS);
  const week = windowByMinutes(windows, WEEK_WINDOW_MINS);
  return fiveHour === null && week === null
    ? null
    : { name, ...(fiveHour && { fiveHour }), ...(week && { week }) };
}

function isoToMs(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value.trim())) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The redeemable resets of the `wham/rate-limit-reset-credits` body: the count
 * is `available_count`, or the number of `available` credits when that is
 * missing; the earliest expiry is the minimum `expires_at` of the available
 * ones. `null` when the body has no `credits` list.
 */
export function parseProbeResetCredits(payload: unknown): BankedResets | null {
  if (!isRecord(payload) || !Array.isArray(payload.credits)) {
    return null;
  }
  const available = payload.credits.filter(
    (credit): credit is Record<string, unknown> =>
      isRecord(credit) && credit.status === CREDIT_STATUS_AVAILABLE,
  );
  const reported = payload.available_count;
  const count =
    typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0
      ? reported
      : available.length;
  const expiries = available
    .map((credit) => isoToMs(credit.expires_at))
    .filter((expiresAt): expiresAt is number => expiresAt !== null);
  return { count, nextExpiresAt: expiries.length === 0 ? null : Math.min(...expiries) };
}

/** First non-blank `slug` of the models response. */
function firstModelSlug(payload: unknown): string | null {
  const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  for (const model of models) {
    if (isRecord(model) && typeof model.slug === "string" && model.slug.trim() !== "") {
      return model.slug.trim();
    }
  }
  return null;
}

export interface CodexProbeOptions {
  readonly accessToken: string;
  readonly accountId: string;
  readonly fetchImpl: typeof fetch;
  readonly signal: AbortSignal;
  readonly now: () => number;
}

function requestHeaders(options: CodexProbeOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${options.accessToken}`,
    accept: "application/json",
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
    "chatgpt-account-id": options.accountId,
  };
}

function httpFailure(response: Response, nowMs: number): FetchResult {
  return {
    ok: false,
    error: `upstream_${response.status}`,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), nowMs),
  };
}

async function jsonOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Best effort: a failing reset-credits request only leaves the banked resets out. */
async function fetchResetCredits(options: CodexProbeOptions): Promise<BankedResets | null> {
  try {
    const response = await options.fetchImpl(CODEX_RESET_CREDITS_URL, {
      method: "GET",
      headers: requestHeaders(options),
      signal: options.signal,
    });
    return response.ok ? parseProbeResetCredits(await jsonOrNull(response)) : null;
  } catch {
    return null;
  }
}

async function fetchModelSlug(options: CodexProbeOptions): Promise<string | FetchResult> {
  const response = await options.fetchImpl(CODEX_MODELS_URL, {
    method: "GET",
    headers: requestHeaders(options),
    signal: options.signal,
  });
  if (!response.ok) {
    return httpFailure(response, options.now());
  }
  return firstModelSlug(await jsonOrNull(response)) ?? { ok: false, error: ERROR_MODELS_INVALID };
}

function postResponses(options: CodexProbeOptions, model: string): Promise<Response> {
  return options.fetchImpl(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      ...requestHeaders(options),
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      model,
      instructions: PROBE_INSTRUCTIONS,
      input: [{ role: "user", content: [{ type: "input_text", text: PROBE_PROMPT }] }],
      store: false,
      stream: true,
    }),
    signal: options.signal,
  });
}

/**
 * Runs `work` with a signal that is aborted after `ms` or with `parent`, and
 * settles with `onTimeout` at that deadline even if `work` ignores the abort.
 */
async function withDeadline<T>(
  parent: AbortSignal,
  ms: number,
  onTimeout: T,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (parent.aborted) {
    abort();
  }
  parent.addEventListener("abort", abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      abort();
      resolve(onTimeout);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  }
}

/** Models, then the minimal streamed responses request whose headers carry the limits. */
async function fetchQuota(options: CodexProbeOptions, name: string): Promise<FetchResult> {
  try {
    const model = await fetchModelSlug(options);
    if (typeof model !== "string") {
      return model;
    }
    const response = await postResponses(options, model);
    // Only the headers are needed; the stream is dropped so it uses no more quota.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      return httpFailure(response, options.now());
    }
    const quota = parseQuotaHeaders(response.headers, name, options.now());
    return quota === null
      ? { ok: false, error: ERROR_INVALID_QUOTA_HEADERS }
      : { ok: true, snapshot: quota };
  } catch {
    return { ok: false, error: options.signal.aborted ? ERROR_TIMEOUT : ERROR_NETWORK };
  }
}

/**
 * Runs the probe: models, a minimal streamed responses request whose headers
 * carry the limits, then the reset credits. Every outcome is a result with a
 * non-sensitive code; nothing is thrown, and neither the token nor a body is
 * exposed. Each step has its own deadline inside `CODEX_PROBE_TIMEOUT_MS`, so
 * a stalled reset-credits request keeps the quotas already read.
 */
export async function probeCodex(options: CodexProbeOptions, name: string): Promise<FetchResult> {
  const quota = await withDeadline<FetchResult>(
    options.signal,
    CODEX_PROBE_QUOTA_TIMEOUT_MS,
    { ok: false, error: ERROR_TIMEOUT },
    (signal) => fetchQuota({ ...options, signal }, name),
  );
  if (!quota.ok) {
    return quota;
  }
  const banked = await withDeadline(options.signal, CODEX_RESET_CREDITS_TIMEOUT_MS, null, (signal) =>
    fetchResetCredits({ ...options, signal }),
  );
  return { ok: true, snapshot: { ...quota.snapshot, ...(banked && { banked }) } };
}

/** A failed probe waits at least `minMs`; a longer server `Retry-After` still wins. */
function waitAtLeast(failure: Extract<FetchResult, { ok: false }>, minMs: number): FetchResult {
  return { ...failure, retryAfterMs: Math.max(failure.retryAfterMs ?? 0, minMs) };
}

export interface CodexProbeSourceOptions {
  /** The current `jeqb.codex.probeIntervalMinutes`; read whenever the interval is needed. */
  readonly readIntervalMinutes?: () => unknown;
  readonly authEnvironment?: CodexAuthEnvironment;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * The Codex fallback source for a machine without the `codex` binary. It
 * reads the Codex token (never writes or refreshes it) and sends a minimal
 * request that uses a little quota, so its interval is at least 10 minutes.
 */
export function createCodexProbeSource(options: CodexProbeSourceOptions = {}): QuotaSource {
  const authEnvironment = options.authEnvironment ?? defaultCodexAuthEnvironment();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const intervalMs = (): number => probeIntervalMs(options.readIntervalMinutes?.());
  const fetcher: Fetcher = async (signal) => {
    const auth = await readCodexAuth(authEnvironment);
    if (!auth.ok) {
      // No request was sent, so no quota was used: the normal backoff applies.
      return { ok: false, error: auth.error };
    }
    const result = await probeCodex(
      { accessToken: auth.accessToken, accountId: auth.accountId, fetchImpl, signal, now },
      PROVIDER_NAMES.codex,
    );
    // A failed run may already have used quota, so the next one waits the interval too.
    return result.ok ? result : waitAtLeast(result, intervalMs());
  };
  return {
    provider: "codex",
    label: "probe",
    get definition() {
      return { id: "codex", intervalMs: intervalMs(), timeoutMs: CODEX_PROBE_TIMEOUT_MS };
    },
    get minIntervalMs() {
      return intervalMs();
    },
    fetch: fetcher,
  };
}

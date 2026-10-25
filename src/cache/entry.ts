import type {
  AnnouncedKind,
  AnnouncedReset,
  BankedResets,
  QuotaSnapshot,
  QuotaWindow,
} from "../model";

/** Name of the machine-wide cache file inside the global storage directory. */
export const CACHE_FILE_NAME = "cache.json";

export const CACHE_VERSION = 1;

const MAX_NAME_LENGTH = 32;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ANNOUNCED_KINDS: readonly AnnouncedKind[] = ["announced", "hinted", "estimate"];

/** Error code stored when a source reports something that is not a plain code. */
export const UNKNOWN_ERROR = "unknown_error";

/**
 * What the cache keeps of one source.
 *
 * `snapshot` is the last successful answer, flagged `stale` while later
 * fetches fail. Only derived data is stored: never a token or an identifier.
 */
export interface CacheEntry {
  readonly source: string;
  readonly snapshot: QuotaSnapshot | null;
  /** Error code of the last attempt, `null` after a success. */
  readonly error: string | null;
  readonly failures: number;
  /** Earliest time of the next attempt after failures, ms. */
  readonly nextAttemptAt: number;
}

export interface CacheFile {
  readonly version: number;
  readonly entries: Readonly<Record<string, CacheEntry>>;
}

export const EMPTY_CACHE: CacheFile = { version: CACHE_VERSION, entries: {} };

/** Whether `value` is usable in a file name and as a cache key. */
export function isSourceId(value: string): boolean {
  return SOURCE_ID_PATTERN.test(value);
}

/** Keeps `code` when it is a plain error code, otherwise returns `UNKNOWN_ERROR`. */
export function toErrorCode(code: unknown): string {
  return typeof code === "string" && ERROR_CODE_PATTERN.test(code) ? code : UNKNOWN_ERROR;
}

type Fields = Readonly<Record<string, unknown>>;

function asFields(value: unknown): Fields | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function errorOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toErrorCode(value);
}

function sanitizeWindow(value: unknown): QuotaWindow | undefined {
  const fields = asFields(value);
  if (fields === null) {
    return undefined;
  }
  return {
    usedPercent: finiteOrNull(fields.usedPercent),
    resetsAt: finiteOrNull(fields.resetsAt),
  };
}

function sanitizeBanked(value: unknown): BankedResets | undefined {
  const fields = asFields(value);
  if (fields === null) {
    return undefined;
  }
  return {
    count: finiteOrNull(fields.count),
    nextExpiresAt: finiteOrNull(fields.nextExpiresAt),
  };
}

function sanitizeAnnounced(value: unknown): AnnouncedReset | undefined {
  const fields = asFields(value);
  if (fields === null) {
    return undefined;
  }
  const kind = ANNOUNCED_KINDS.find((candidate) => candidate === fields.kind) ?? null;
  return {
    next: finiteOrNull(fields.next),
    kind,
    last: finiteOrNull(fields.last),
    p24: finiteOrNull(fields.p24),
    p48: finiteOrNull(fields.p48),
    estimate: finiteOrNull(fields.estimate),
  };
}

/**
 * Rebuilds a snapshot from known fields only, so that nothing a source
 * returned beyond the model (a token, an account id) can reach the file.
 */
export function sanitizeSnapshot(value: unknown): QuotaSnapshot | null {
  const fields = asFields(value);
  if (fields === null || typeof fields.name !== "string") {
    return null;
  }
  const fiveHour = sanitizeWindow(fields.fiveHour);
  const week = sanitizeWindow(fields.week);
  const banked = sanitizeBanked(fields.banked);
  const announced = sanitizeAnnounced(fields.announced);
  return {
    name: fields.name.slice(0, MAX_NAME_LENGTH),
    ...(fiveHour && { fiveHour }),
    ...(week && { week }),
    ...(banked && { banked }),
    ...(announced && { announced }),
    fetchedAt: finiteOrNull(fields.fetchedAt),
    stale: fields.stale === true,
    error: errorOrNull(fields.error),
  };
}

/** Rebuilds an entry from known fields only; `null` when it has no valid source id. */
export function sanitizeCacheEntry(value: unknown): CacheEntry | null {
  const fields = asFields(value);
  if (fields === null || typeof fields.source !== "string" || !isSourceId(fields.source)) {
    return null;
  }
  return {
    source: fields.source,
    snapshot: sanitizeSnapshot(fields.snapshot),
    error: errorOrNull(fields.error),
    failures: nonNegativeInteger(fields.failures),
    nextAttemptAt: finiteOrNull(fields.nextAttemptAt) ?? 0,
  };
}

/** Parses the cache file text. Anything unreadable or foreign yields an empty cache. */
export function parseCacheFile(text: string): CacheFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_CACHE;
  }
  const fields = asFields(parsed);
  const rawEntries = asFields(fields?.entries);
  if (fields?.version !== CACHE_VERSION || rawEntries === null) {
    return EMPTY_CACHE;
  }
  const entries: Record<string, CacheEntry> = {};
  for (const [source, raw] of Object.entries(rawEntries)) {
    const entry = sanitizeCacheEntry(raw);
    if (entry !== null && entry.source === source) {
      entries[source] = entry;
    }
  }
  return { version: CACHE_VERSION, entries };
}

export function serializeCacheFile(file: CacheFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

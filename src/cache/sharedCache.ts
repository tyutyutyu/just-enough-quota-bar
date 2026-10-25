import { mkdir } from "node:fs/promises";
import type { QuotaSnapshot } from "../model";
import { retryDelayMs } from "./backoff";
import {
  isSourceId,
  sanitizeSnapshot,
  toErrorCode,
  type CacheEntry,
  type CacheFile,
} from "./entry";
import { CacheFileStore } from "./fileStore";
import { tryAcquireLock } from "./lock";
import { watchCache, type Disposable, type WatchOptions } from "./watcher";

/** An abandoned lock is taken over after this many fetch timeouts. */
const LOCK_TIMEOUT_FACTOR = 2;

export const ERROR_FETCH_FAILED = "fetch_failed";
export const ERROR_INVALID_SNAPSHOT = "invalid_snapshot";
export const ERROR_TIMEOUT = "timeout";

export interface SourceDefinition {
  /** Lowercase id such as `claude`; it names the lock file and the cache entry. */
  readonly id: string;
  /** Data younger than this is not fetched again. */
  readonly intervalMs: number;
  /** One fetch is abandoned after this; a lock older than twice this is stale. */
  readonly timeoutMs: number;
  /**
   * No attempt follows a failed one sooner than this, whatever the backoff
   * says; a longer `Retry-After` still wins.
   */
  readonly minRetryMs?: number;
}

export type FetchResult =
  | { readonly ok: true; readonly snapshot: QuotaSnapshot }
  | {
      readonly ok: false;
      /** Non-sensitive code such as `upstream_429`; anything else is replaced. */
      readonly error: string;
      /** The server's `Retry-After`, in ms. */
      readonly retryAfterMs?: number | null;
    };

export type Fetcher = (signal: AbortSignal) => Promise<FetchResult>;

/**
 * What `refresh` did.
 * - `fetched` / `failed`: this window queried the source.
 * - `fresh`: the entry is younger than the interval.
 * - `backoff`: a failed fetch is waiting for its retry time.
 * - `locked`: another window is querying the source.
 */
export type RefreshOutcome = "fetched" | "failed" | "fresh" | "backoff" | "locked";

export interface SharedCacheOptions {
  readonly now?: () => number;
}

type DueState = "due" | "fresh" | "backoff";

function dueState(entry: CacheEntry | undefined, source: SourceDefinition, nowMs: number): DueState {
  if (entry === undefined) {
    return "due";
  }
  if (nowMs < entry.nextAttemptAt) {
    return "backoff";
  }
  const fetchedAt = entry.snapshot?.fetchedAt ?? null;
  return fetchedAt === null || nowMs - fetchedAt > source.intervalMs ? "due" : "fresh";
}

async function runFetcher(fetcher: Fetcher, timeoutMs: number): Promise<FetchResult> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<FetchResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: ERROR_TIMEOUT });
    }, timeoutMs);
  });
  // A fetcher that throws, synchronously or after the timeout, becomes a
  // failure instead of an escaping error or an unhandled rejection.
  const attempt = Promise.resolve()
    .then(() => fetcher(controller.signal))
    .catch(
    (): FetchResult => ({ ok: false, error: ERROR_FETCH_FAILED }),
  );
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function successEntry(
  source: SourceDefinition,
  previous: CacheEntry | undefined,
  snapshot: QuotaSnapshot,
  nowMs: number,
): CacheEntry {
  const clean = sanitizeSnapshot({ ...snapshot, fetchedAt: nowMs, stale: false, error: null });
  if (clean === null) {
    return failureEntry(source, previous, { ok: false, error: ERROR_INVALID_SNAPSHOT }, nowMs);
  }
  return { source: source.id, snapshot: clean, error: null, failures: 0, nextAttemptAt: 0 };
}

/** Keeps the previous data, flagged stale, and schedules the next attempt. */
function failureEntry(
  source: SourceDefinition,
  previous: CacheEntry | undefined,
  failure: Extract<FetchResult, { ok: false }>,
  nowMs: number,
): CacheEntry {
  const error = toErrorCode(failure.error);
  const failures = (previous?.failures ?? 0) + 1;
  const kept = previous?.snapshot ?? null;
  return {
    source: source.id,
    snapshot: kept && { ...kept, stale: true, error },
    error,
    failures,
    nextAttemptAt:
      nowMs + Math.max(retryDelayMs(failures, failure.retryAfterMs ?? null), source.minRetryMs ?? 0),
  };
}

/**
 * The cache shared by every VS Code window of the machine.
 *
 * Only the window that creates a source's lock file fetches it, and only
 * while the cached entry is older than the source's interval. The other
 * windows learn about the result through `watch`.
 */
export class SharedCache {
  private readonly store: CacheFileStore;
  private readonly now: () => number;

  constructor(directory: string, options: SharedCacheOptions = {}) {
    this.store = new CacheFileStore(directory);
    this.now = options.now ?? Date.now;
  }

  read(): Promise<CacheFile> {
    return this.store.read();
  }

  /** Fetches `source` through `fetcher` when this window is the one to do it. */
  async refresh(source: SourceDefinition, fetcher: Fetcher): Promise<RefreshOutcome> {
    if (!isSourceId(source.id)) {
      throw new Error(`invalid source id: ${source.id}`);
    }
    const early = dueState((await this.store.read()).entries[source.id], source, this.now());
    if (early !== "due") {
      return early;
    }
    await mkdir(this.store.directory, { recursive: true });
    const lock = await tryAcquireLock(this.store.lockPathFor(source.id), {
      staleAfterMs: LOCK_TIMEOUT_FACTOR * source.timeoutMs,
      now: this.now,
    });
    if (lock === null) {
      return "locked";
    }
    try {
      return await this.fetchLocked(source, fetcher);
    } finally {
      await lock.release();
    }
  }

  /** Calls `onChange` when any window changes the cache file. */
  async watch(onChange: (file: CacheFile) => void, options?: WatchOptions): Promise<Disposable> {
    await mkdir(this.store.directory, { recursive: true });
    return watchCache(this.store, onChange, options);
  }

  private async fetchLocked(source: SourceDefinition, fetcher: Fetcher): Promise<RefreshOutcome> {
    // Another window may have finished between the first check and the lock.
    const current = (await this.store.read()).entries[source.id];
    const state = dueState(current, source, this.now());
    if (state !== "due") {
      return state;
    }
    const result = await runFetcher(fetcher, source.timeoutMs);
    const finishedAt = this.now();
    const entry = result.ok
      ? successEntry(source, current, result.snapshot, finishedAt)
      : failureEntry(source, current, result, finishedAt);
    await this.store.writeEntry(entry);
    return entry.error === null ? "fetched" : "failed";
  }
}

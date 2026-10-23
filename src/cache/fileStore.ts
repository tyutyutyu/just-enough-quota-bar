import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CACHE_FILE_NAME,
  CACHE_VERSION,
  parseCacheFile,
  sanitizeCacheEntry,
  serializeCacheFile,
  type CacheEntry,
  type CacheFile,
} from "./entry";
import { tryAcquireLock } from "./lock";

const WRITE_LOCK_NAME = "cache.write.lock";
const WRITE_LOCK_STALE_MS = 10_000;
const WRITE_LOCK_WAIT_MS = 5_000;
const WRITE_LOCK_POLL_MS = 25;
const FILE_RETRIES = 5;
const FILE_RETRY_DELAY_MS = 20;

/** Windows reports a file that another process has open with these codes. */
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !TRANSIENT_CODES.has(code) || attempt >= FILE_RETRIES) {
        throw error;
      }
      await sleep(FILE_RETRY_DELAY_MS);
    }
  }
}

/**
 * The machine-wide cache file inside one directory (the extension's global
 * storage). Writes replace the file atomically, so readers never see a torn
 * file, and are serialized through a short-lived lock so that windows
 * updating different sources do not overwrite each other.
 */
export class CacheFileStore {
  readonly directory: string;
  readonly filePath: string;

  constructor(directory: string) {
    this.directory = directory;
    this.filePath = join(directory, CACHE_FILE_NAME);
  }

  /** Path of the lock that guards fetching of one source. */
  lockPathFor(source: string): string {
    return join(this.directory, `${source}.lock`);
  }

  async read(): Promise<CacheFile> {
    return parseCacheFile((await this.readText()) ?? "");
  }

  /** Raw file content, `null` when the file does not exist yet. */
  async readText(): Promise<string | null> {
    try {
      return await withRetries(() => readFile(this.filePath, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /** Stores `entry` under its source, keeping the entries of other sources. */
  async writeEntry(entry: CacheEntry): Promise<void> {
    const clean = sanitizeCacheEntry(entry);
    if (clean === null) {
      throw new Error("invalid cache entry source");
    }
    await mkdir(this.directory, { recursive: true });
    const release = await this.acquireWriteLock();
    try {
      const current = await this.read();
      await this.replaceFile({
        version: CACHE_VERSION,
        entries: { ...current.entries, [clean.source]: clean },
      });
    } finally {
      await release();
    }
  }

  private async acquireWriteLock(): Promise<() => Promise<void>> {
    const lockPath = join(this.directory, WRITE_LOCK_NAME);
    const deadline = Date.now() + WRITE_LOCK_WAIT_MS;
    for (;;) {
      const handle = await tryAcquireLock(lockPath, { staleAfterMs: WRITE_LOCK_STALE_MS });
      if (handle !== null) {
        return () => handle.release();
      }
      if (Date.now() >= deadline) {
        throw new Error("cache_write_lock_timeout");
      }
      await sleep(WRITE_LOCK_POLL_MS);
    }
  }

  private async replaceFile(file: CacheFile): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serializeCacheFile(file), "utf8");
      await withRetries(() => rename(temporary, this.filePath));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

import { watch, type FSWatcher } from "node:fs";
import { CACHE_FILE_NAME, type CacheFile } from "./entry";
import type { CacheFileStore } from "./fileStore";

/** Fallback when `fs.watch` misses an event or is not available. */
export const DEFAULT_POLL_MS = 15_000;

export interface Disposable {
  dispose(): void;
}

export interface WatchOptions {
  readonly pollMs?: number;
  /** Called when reading the cache failed; the watcher keeps running. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Tells `onChange` whenever the content of the cache file changes, whichever
 * window wrote it. A directory watch gives the fast path; the periodic check
 * is the safety net because `fs.watch` is not reliable on every platform.
 * The file is replaced by rename, so the directory is watched, not the file.
 */
export function watchCache(
  store: CacheFileStore,
  onChange: (file: CacheFile) => void,
  options: WatchOptions = {},
): Disposable {
  let lastText: string | null | undefined;
  let checking = false;
  let disposed = false;

  const check = async (): Promise<void> => {
    if (checking || disposed) {
      return;
    }
    checking = true;
    try {
      const text = await store.readText();
      if (disposed || text === lastText) {
        return;
      }
      const first = lastText === undefined;
      lastText = text;
      if (!first) {
        onChange(await store.read());
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      checking = false;
    }
  };

  const watcher = openDirectoryWatch(store, () => void check(), options.onError);
  const timer = setInterval(() => void check(), options.pollMs ?? DEFAULT_POLL_MS);
  void check();

  return {
    dispose(): void {
      disposed = true;
      clearInterval(timer);
      watcher?.close();
    },
  };
}

function openDirectoryWatch(
  store: CacheFileStore,
  onEvent: () => void,
  onError: ((error: unknown) => void) | undefined,
): FSWatcher | null {
  try {
    const watcher = watch(store.directory, (_event, filename) => {
      if (filename === null || filename === undefined || String(filename) === CACHE_FILE_NAME) {
        onEvent();
      }
    });
    watcher.on("error", (error) => onError?.(error));
    return watcher;
  } catch (error) {
    // The directory may not exist yet; the periodic check still covers it.
    onError?.(error);
    return null;
  }
}

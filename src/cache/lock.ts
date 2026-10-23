import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";

export interface LockHandle {
  /** Removes the lock, unless another window has taken it over meanwhile. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** A lock older than this is considered abandoned and may be taken over. */
  readonly staleAfterMs: number;
  readonly now?: () => number;
  /** Test seam: runs after a stale lock was observed, before taking it over. */
  readonly beforeTakeover?: () => Promise<void>;
}

type ResolvedOptions = Required<Omit<LockOptions, "beforeTakeover">> & Pick<LockOptions, "beforeTakeover">;

/** Suffix of the file that serializes the takeover of an abandoned lock. */
const TAKEOVER_SUFFIX = ".takeover";

/** Errors that mean "somebody else is working on the lock", not a broken disk. */
const CONTENTION_CODES = new Set(["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function isContention(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && CONTENTION_CODES.has(code);
}

/** Creates the lock file atomically (`open wx`); `false` when it already exists. */
async function createExclusive(lockPath: string, token: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(token);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (isContention(error)) {
      return false;
    }
    throw error;
  }
}

async function ageMs(path: string, nowMs: number): Promise<number | null> {
  try {
    return nowMs - (await stat(path)).mtimeMs;
  } catch (error) {
    if (isContention(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Removes an abandoned lock. Takeovers are serialized through an exclusive
 * guard file and the lock's age is checked again while holding it, so a
 * window acting on an old observation never removes a lock that another
 * window has just taken over. `true` when the lock path is free to create.
 */
async function removeAbandoned(lockPath: string, options: ResolvedOptions): Promise<boolean> {
  const guardPath = `${lockPath}${TAKEOVER_SUFFIX}`;
  const guardToken = randomUUID();
  if (!(await createExclusive(guardPath, guardToken))) {
    await clearAbandonedGuard(guardPath, options);
    return false;
  }
  try {
    const age = await ageMs(lockPath, options.now());
    if (age !== null && age <= options.staleAfterMs) {
      return false;
    }
    await unlink(lockPath).catch((error: unknown) => {
      if (!isContention(error)) {
        throw error;
      }
    });
    return true;
  } finally {
    await handleFor(guardPath, guardToken).release();
  }
}

/**
 * A guard is held only for one stat and one unlink, so an old one belongs to
 * a window that died in between. It is removed; the caller retries later.
 */
async function clearAbandonedGuard(guardPath: string, options: ResolvedOptions): Promise<void> {
  const age = await ageMs(guardPath, options.now());
  if (age !== null && age > options.staleAfterMs) {
    await unlink(guardPath).catch((error: unknown) => {
      if (!isContention(error)) {
        throw error;
      }
    });
  }
}

function handleFor(lockPath: string, token: string): LockHandle {
  return {
    async release(): Promise<void> {
      try {
        if ((await readFile(lockPath, "utf8")) === token) {
          await unlink(lockPath);
        }
      } catch (error) {
        if (!isContention(error)) {
          throw error;
        }
      }
    },
  };
}

/**
 * Tries to become the only owner of `lockPath`.
 *
 * Resolves with a handle when this caller created the lock file, and with
 * `null` when someone else holds a live lock.
 */
export async function tryAcquireLock(
  lockPath: string,
  options: LockOptions,
): Promise<LockHandle | null> {
  const resolved: ResolvedOptions = { now: Date.now, ...options };
  const token = randomUUID();
  if (await createExclusive(lockPath, token)) {
    return handleFor(lockPath, token);
  }
  const age = await ageMs(lockPath, resolved.now());
  if (age !== null && age <= resolved.staleAfterMs) {
    return null;
  }
  if (age !== null) {
    await resolved.beforeTakeover?.();
    if (!(await removeAbandoned(lockPath, resolved))) {
      return null;
    }
  }
  return (await createExclusive(lockPath, token)) ? handleFor(lockPath, token) : null;
}

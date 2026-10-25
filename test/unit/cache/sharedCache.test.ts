import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "../../../src/cache/backoff";
import { CACHE_FILE_NAME } from "../../../src/cache/entry";
import {
  SharedCache,
  type FetchResult,
  type Fetcher,
  type SourceDefinition,
} from "../../../src/cache/sharedCache";
import type { QuotaSnapshot } from "../../../src/model";

const MINUTE = 60_000;
const SOURCE: SourceDefinition = { id: "claude", intervalMs: 5 * MINUTE, timeoutMs: 1000 };

let directory: string;
let clock: number;
let cache: SharedCache;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jeqb-cache-"));
  clock = Date.now();
  cache = new SharedCache(directory, { now: () => clock });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const snapshot = (usedPercent: number): QuotaSnapshot => ({
  name: "Claude",
  fiveHour: { usedPercent, resetsAt: clock + 60 * MINUTE },
});

function counting(result: FetchResult | (() => FetchResult)): { fetcher: Fetcher; calls: () => number } {
  let calls = 0;
  const fetcher: Fetcher = async () => {
    calls += 1;
    return typeof result === "function" ? result() : result;
  };
  return { fetcher, calls: () => calls };
}

const failing = (error: string, retryAfterMs?: number): FetchResult => ({
  ok: false,
  error,
  retryAfterMs,
});

describe("SharedCache.refresh", () => {
  it("fetches an unknown source and stores the answer", async () => {
    const { fetcher, calls } = counting({ ok: true, snapshot: snapshot(42) });

    expect(await cache.refresh(SOURCE, fetcher)).toBe("fetched");

    expect(calls()).toBe(1);
    const entry = (await cache.read()).entries.claude;
    expect(entry?.snapshot?.fiveHour?.usedPercent).toBe(42);
    expect(entry?.snapshot).toMatchObject({ fetchedAt: clock, stale: false, error: null });
  });

  it("keeps one entry per source in a single JSON file", async () => {
    const ok: FetchResult = { ok: true, snapshot: snapshot(1) };
    await cache.refresh(SOURCE, counting(ok).fetcher);
    await cache.refresh({ ...SOURCE, id: "codex-probe" }, counting(ok).fetcher);

    const text = await readFile(join(directory, CACHE_FILE_NAME), "utf8");
    expect(Object.keys(JSON.parse(text).entries).sort()).toEqual(["claude", "codex-probe"]);
  });

  it("does not fetch while the entry is younger than the interval", async () => {
    const { fetcher, calls } = counting({ ok: true, snapshot: snapshot(1) });
    await cache.refresh(SOURCE, fetcher);

    clock += SOURCE.intervalMs - 1;
    expect(await cache.refresh(SOURCE, fetcher)).toBe("fresh");
    expect(calls()).toBe(1);
  });

  it("fetches again once the entry is older than the interval", async () => {
    const { fetcher, calls } = counting({ ok: true, snapshot: snapshot(1) });
    await cache.refresh(SOURCE, fetcher);

    clock += SOURCE.intervalMs + 1;
    expect(await cache.refresh(SOURCE, fetcher)).toBe("fetched");
    expect(calls()).toBe(2);
  });

  it("does not fetch while another window holds the lock", async () => {
    await writeFile(join(directory, "claude.lock"), "other-window");
    const { fetcher, calls } = counting({ ok: true, snapshot: snapshot(1) });

    expect(await cache.refresh(SOURCE, fetcher)).toBe("locked");
    expect(calls()).toBe(0);
  });

  it("takes over a lock older than twice the timeout", async () => {
    const lock = join(directory, "claude.lock");
    await writeFile(lock, "abandoned");
    const old = new Date(clock - 2 * SOURCE.timeoutMs - 1000);
    await utimes(lock, old, old);
    const { fetcher, calls } = counting({ ok: true, snapshot: snapshot(1) });

    expect(await cache.refresh(SOURCE, fetcher)).toBe("fetched");
    expect(calls()).toBe(1);
  });

  it("keeps a lock younger than twice the timeout", async () => {
    const lock = join(directory, "claude.lock");
    await writeFile(lock, "busy");
    const recent = new Date(clock - 2 * SOURCE.timeoutMs + 1000);
    await utimes(lock, recent, recent);
    const { fetcher } = counting({ ok: true, snapshot: snapshot(1) });

    expect(await cache.refresh(SOURCE, fetcher)).toBe("locked");
  });

  it("releases the lock after fetching", async () => {
    const { fetcher } = counting({ ok: true, snapshot: snapshot(1) });
    await cache.refresh(SOURCE, fetcher);
    clock += SOURCE.intervalMs + 1;

    expect(await cache.refresh(SOURCE, fetcher)).toBe("fetched");
  });

  it("rejects a source id that is unsafe in a file name", async () => {
    const { fetcher } = counting({ ok: true, snapshot: snapshot(1) });
    await expect(cache.refresh({ ...SOURCE, id: "../x" }, fetcher)).rejects.toThrow(
      "invalid source id",
    );
  });
});

describe("SharedCache failures", () => {
  async function seeded(): Promise<void> {
    await cache.refresh(SOURCE, counting({ ok: true, snapshot: snapshot(42) }).fetcher);
    clock += SOURCE.intervalMs + 1;
  }

  it("keeps the old data marked stale with the error code", async () => {
    await seeded();
    const outcome = await cache.refresh(SOURCE, counting(failing("upstream_500")).fetcher);

    expect(outcome).toBe("failed");
    const entry = (await cache.read()).entries.claude;
    expect(entry?.snapshot).toMatchObject({ stale: true, error: "upstream_500" });
    expect(entry?.snapshot?.fiveHour?.usedPercent).toBe(42);
  });

  it("keeps the time of the last successful fetch", async () => {
    await seeded();
    const fetchedAt = (await cache.read()).entries.claude?.snapshot?.fetchedAt;
    await cache.refresh(SOURCE, counting(failing("upstream_500")).fetcher);

    expect((await cache.read()).entries.claude?.snapshot?.fetchedAt).toBe(fetchedAt);
  });

  it("waits for the backoff before the next attempt", async () => {
    await seeded();
    const { fetcher, calls } = counting(failing("upstream_500"));
    await cache.refresh(SOURCE, fetcher);

    clock += BACKOFF_BASE_MS - 1;
    expect(await cache.refresh(SOURCE, fetcher)).toBe("backoff");
    clock += 1;
    expect(await cache.refresh(SOURCE, fetcher)).toBe("failed");
    expect(calls()).toBe(2);
  });

  it("doubles the wait with every consecutive failure", async () => {
    await seeded();
    const { fetcher } = counting(failing("upstream_500"));
    await cache.refresh(SOURCE, fetcher);
    clock += BACKOFF_BASE_MS;
    await cache.refresh(SOURCE, fetcher);

    const entry = (await cache.read()).entries.claude;
    expect(entry?.failures).toBe(2);
    expect(entry?.nextAttemptAt).toBe(clock + 2 * BACKOFF_BASE_MS);
  });

  it("never waits more than 30 minutes because of the backoff", async () => {
    await seeded();
    const { fetcher } = counting(failing("upstream_500"));
    for (let attempt = 0; attempt < 12; attempt++) {
      await cache.refresh(SOURCE, fetcher);
      clock += BACKOFF_MAX_MS;
    }

    const entry = (await cache.read()).entries.claude;
    expect(entry!.nextAttemptAt - (clock - BACKOFF_MAX_MS)).toBe(BACKOFF_MAX_MS);
  });

  it("honors Retry-After of a 429 answer", async () => {
    await seeded();
    await cache.refresh(SOURCE, counting(failing("upstream_429", 20 * MINUTE)).fetcher);

    expect((await cache.read()).entries.claude?.nextAttemptAt).toBe(clock + 20 * MINUTE);
    clock += 20 * MINUTE - 1;
    expect(await cache.refresh(SOURCE, counting(failing("upstream_429")).fetcher)).toBe("backoff");
  });

  it("honors a Retry-After longer than a day in full", async () => {
    await seeded();
    const twoDays = 48 * 60 * MINUTE;
    await cache.refresh(SOURCE, counting(failing("upstream_429", twoDays)).fetcher);

    expect((await cache.read()).entries.claude?.nextAttemptAt).toBe(clock + twoDays);
    clock += twoDays - 1;
    expect(await cache.refresh(SOURCE, counting(failing("upstream_429")).fetcher)).toBe("backoff");
  });

  it("waits at least the source's minimum retry delay after a failure", async () => {
    const floored: SourceDefinition = { ...SOURCE, minRetryMs: 5 * MINUTE };
    const { fetcher, calls } = counting(failing("upstream_503"));
    await cache.refresh(floored, fetcher);

    expect((await cache.read()).entries.claude?.nextAttemptAt).toBe(clock + 5 * MINUTE);
    clock += 5 * MINUTE - 1;
    expect(await cache.refresh(floored, fetcher)).toBe("backoff");
    clock += 1;
    expect(await cache.refresh(floored, fetcher)).toBe("failed");
    expect(calls()).toBe(2);
  });

  it("lets a Retry-After longer than the minimum retry delay win", async () => {
    const floored: SourceDefinition = { ...SOURCE, minRetryMs: 5 * MINUTE };
    await cache.refresh(floored, counting(failing("upstream_429", 10 * MINUTE)).fetcher);

    expect((await cache.read()).entries.claude?.nextAttemptAt).toBe(clock + 10 * MINUTE);
  });

  it("recovers on success and clears the error", async () => {
    await seeded();
    await cache.refresh(SOURCE, counting(failing("upstream_500")).fetcher);
    clock += BACKOFF_BASE_MS;

    const outcome = await cache.refresh(SOURCE, counting({ ok: true, snapshot: snapshot(10) }).fetcher);

    expect(outcome).toBe("fetched");
    const entry = (await cache.read()).entries.claude;
    expect(entry).toMatchObject({ failures: 0, nextAttemptAt: 0, error: null });
    expect(entry?.snapshot).toMatchObject({ stale: false, error: null });
  });

  it("has no snapshot when the very first fetch fails", async () => {
    await cache.refresh(SOURCE, counting(failing("auth_missing")).fetcher);

    const entry = (await cache.read()).entries.claude;
    expect(entry).toMatchObject({ snapshot: null, error: "auth_missing", failures: 1 });
  });

  it("stores an unknown error code instead of free text", async () => {
    await cache.refresh(SOURCE, counting(failing("Bearer sk-secret rejected")).fetcher);

    const text = await readFile(join(directory, CACHE_FILE_NAME), "utf8");
    expect(text).not.toContain("sk-secret");
    expect((await cache.read()).entries.claude?.error).toBe("unknown_error");
  });

  it("turns a throwing fetcher into a failure without leaking its message", async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error("token sk-secret leaked"));

    expect(await cache.refresh(SOURCE, fetcher)).toBe("failed");
    const text = await readFile(join(directory, CACHE_FILE_NAME), "utf8");
    expect(text).not.toContain("sk-secret");
    expect((await cache.read()).entries.claude?.error).toBe("fetch_failed");
  });

  it("treats a synchronously throwing fetcher as a failure with backoff", async () => {
    await seeded();
    const fetcher: Fetcher = () => {
      throw new Error("token sk-secret leaked");
    };

    expect(await cache.refresh(SOURCE, fetcher)).toBe("failed");
    const entry = (await cache.read()).entries.claude;
    expect(entry).toMatchObject({ error: "fetch_failed", failures: 1, nextAttemptAt: clock + BACKOFF_BASE_MS });
    expect(entry?.snapshot).toMatchObject({ stale: true, error: "fetch_failed" });
    expect(entry?.snapshot?.fiveHour?.usedPercent).toBe(42);
    const text = await readFile(join(directory, CACHE_FILE_NAME), "utf8");
    expect(text).not.toContain("sk-secret");
  });

  it("aborts a fetcher that exceeds the timeout", async () => {
    let aborted = false;
    const fetcher: Fetcher = (signal) =>
      new Promise<FetchResult>(() => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      });

    const outcome = await cache.refresh({ ...SOURCE, timeoutMs: 30 }, fetcher);

    expect(outcome).toBe("failed");
    expect(aborted).toBe(true);
    expect((await cache.read()).entries.claude?.error).toBe("timeout");
  });

  it("treats an invalid snapshot as a failure and keeps the old data", async () => {
    await seeded();
    const invalid = { ok: true, snapshot: {} as unknown as QuotaSnapshot } as const;

    expect(await cache.refresh(SOURCE, counting(invalid).fetcher)).toBe("failed");
    const entry = (await cache.read()).entries.claude;
    expect(entry?.error).toBe("invalid_snapshot");
    expect(entry?.snapshot?.fiveHour?.usedPercent).toBe(42);
  });
});

describe("cache content", () => {
  it("never contains a token or an identifier", async () => {
    const leaky = {
      name: "Claude",
      fiveHour: { usedPercent: 10, resetsAt: clock, accessToken: "sk-ant-oat-SECRET" },
      accountId: "acct-SECRET-ID",
      email: "user@example.com",
      authorization: "Bearer SECRET",
    } as unknown as QuotaSnapshot;

    await cache.refresh(SOURCE, counting({ ok: true, snapshot: leaky }).fetcher);

    const text = await readFile(join(directory, CACHE_FILE_NAME), "utf8");
    expect(text).not.toMatch(/SECRET|user@example|Bearer|accessToken|accountId/);
    expect(JSON.parse(text).entries.claude.snapshot.name).toBe("Claude");
  });

  it("treats a corrupt file as empty and rewrites it", async () => {
    await writeFile(join(directory, CACHE_FILE_NAME), "{broken");

    const outcome = await cache.refresh(SOURCE, counting({ ok: true, snapshot: snapshot(5) }).fetcher);

    expect(outcome).toBe("fetched");
    expect((await cache.read()).entries.claude?.snapshot?.fiveHour?.usedPercent).toBe(5);
  });
});

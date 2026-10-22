import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryAcquireLock } from "../../../src/cache/lock";

const STALE_AFTER_MS = 2000;
let directory: string;
let lockPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jeqb-lock-"));
  lockPath = join(directory, "claude.lock");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function age(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

describe("tryAcquireLock", () => {
  it("creates the lock file", async () => {
    const handle = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    expect(handle).not.toBeNull();
    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it("refuses a second owner while the lock is alive", async () => {
    const first = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    const second = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("can be acquired again after release", async () => {
    const first = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    await first?.release();
    expect(await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS })).not.toBeNull();
  });

  it("does not take over a lock younger than the stale limit", async () => {
    await writeFile(lockPath, "other");
    await age(lockPath, STALE_AFTER_MS - 1000);
    expect(await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS })).toBeNull();
  });

  it("takes over a lock older than the stale limit", async () => {
    await writeFile(lockPath, "abandoned");
    await age(lockPath, STALE_AFTER_MS + 1000);
    const handle = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    expect(handle).not.toBeNull();
    expect(await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS })).toBeNull();
  });

  it("leaves no helper files behind after a takeover", async () => {
    await writeFile(lockPath, "abandoned");
    await age(lockPath, STALE_AFTER_MS + 1000);
    await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    expect(await readdir(directory)).toEqual(["claude.lock"]);
  });

  it("lets only one of many windows take over an abandoned lock", async () => {
    await writeFile(lockPath, "abandoned");
    await age(lockPath, STALE_AFTER_MS + 1000);
    const handles = await Promise.all(
      Array.from({ length: 8 }, () => tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS })),
    );
    expect(handles.filter((handle) => handle !== null)).toHaveLength(1);
  });

  it("does not touch a fresh lock when acting on an old stale observation", async () => {
    await writeFile(lockPath, "abandoned");
    await age(lockPath, STALE_AFTER_MS + 1000);
    let observedStale!: () => void;
    const staleSeen = new Promise<void>((resolve) => (observedStale = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    const late = tryAcquireLock(lockPath, {
      staleAfterMs: STALE_AFTER_MS,
      beforeTakeover: async () => {
        observedStale();
        await resumed;
      },
    });

    await staleSeen;
    const winner = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    const winnerLock = await readFile(lockPath, "utf8");
    const winnerStat = await stat(lockPath);
    resume();

    expect(winner).not.toBeNull();
    expect(await late).toBeNull();
    expect(await readFile(lockPath, "utf8")).toBe(winnerLock);
    expect((await stat(lockPath)).ino).toBe(winnerStat.ino);
    expect(await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS })).toBeNull();
    expect(await readdir(directory)).toEqual(["claude.lock"]);
  });

  it("clears a takeover guard left behind by a crashed window", async () => {
    await writeFile(lockPath, "abandoned");
    await writeFile(`${lockPath}.takeover`, "crashed");
    await age(lockPath, STALE_AFTER_MS + 1000);
    await age(`${lockPath}.takeover`, STALE_AFTER_MS + 1000);

    expect(await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS })).toBeNull();
    expect(await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS })).not.toBeNull();
    expect(await readdir(directory)).toEqual(["claude.lock"]);
  });

  it("waits for a live takeover guard instead of removing the lock", async () => {
    await writeFile(lockPath, "abandoned");
    await writeFile(`${lockPath}.takeover`, "busy");
    await age(lockPath, STALE_AFTER_MS + 1000);

    expect(await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS })).toBeNull();
    expect(await readFile(lockPath, "utf8")).toBe("abandoned");
  });

  it("uses the injected clock for the age", async () => {
    await writeFile(lockPath, "other");
    const future = () => Date.now() + 10 * STALE_AFTER_MS;
    expect(await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS, now: future })).not.toBeNull();
  });

  it("does not remove a lock that another window took over", async () => {
    const first = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    await age(lockPath, STALE_AFTER_MS + 1000);
    const second = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    expect(second).not.toBeNull();
    await first?.release();
    await expect(stat(lockPath)).resolves.toBeDefined();
    await second?.release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releasing twice is harmless", async () => {
    const handle = await tryAcquireLock(lockPath, { staleAfterMs: STALE_AFTER_MS });
    await handle?.release();
    await expect(handle?.release()).resolves.toBeUndefined();
  });
});

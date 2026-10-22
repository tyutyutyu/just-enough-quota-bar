import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheFile } from "../../../src/cache/entry";
import { SharedCache, type SourceDefinition } from "../../../src/cache/sharedCache";
import type { Disposable } from "../../../src/cache/watcher";

const SOURCE: SourceDefinition = { id: "claude", intervalMs: 60_000, timeoutMs: 1000 };
const WAIT = { timeout: 10_000, interval: 25 };

let directory: string;
let writer: SharedCache;
let reader: SharedCache;
let watcher: Disposable | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jeqb-watch-"));
  writer = new SharedCache(directory);
  reader = new SharedCache(directory);
});

afterEach(async () => {
  watcher?.dispose();
  watcher = undefined;
  await rm(directory, { recursive: true, force: true });
});

const fetchUsed = (usedPercent: number) => async () =>
  ({ ok: true, snapshot: { name: "Claude", fiveHour: { usedPercent, resetsAt: null } } }) as const;

describe("SharedCache.watch", () => {
  it("reports a change written by another window through the file watch", async () => {
    const seen: CacheFile[] = [];
    // The periodic check is far away, so only fs.watch can deliver the change.
    watcher = await reader.watch((file) => seen.push(file), { pollMs: 3_600_000 });

    await writer.refresh(SOURCE, fetchUsed(42));

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), WAIT);
    expect(seen.at(-1)?.entries.claude?.snapshot?.fiveHour?.usedPercent).toBe(42);
  });

  it("reports a change through the periodic check when no event arrives", async () => {
    const seen: CacheFile[] = [];
    const quiet = vi.fn();
    watcher = await reader.watch((file) => seen.push(file), { pollMs: 50, onError: quiet });

    await writer.refresh(SOURCE, fetchUsed(7));

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), WAIT);
    expect(seen.at(-1)?.entries.claude?.snapshot?.fiveHour?.usedPercent).toBe(7);
  });

  it("does not report an unchanged file", async () => {
    await writer.refresh(SOURCE, fetchUsed(1));
    const seen: CacheFile[] = [];
    watcher = await reader.watch((file) => seen.push(file), { pollMs: 20 });

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(seen).toHaveLength(0);
  });

  it("stops reporting after dispose", async () => {
    const seen: CacheFile[] = [];
    watcher = await reader.watch((file) => seen.push(file), { pollMs: 20 });
    watcher.dispose();

    await writer.refresh(SOURCE, fetchUsed(3));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(seen).toHaveLength(0);
  });

  it("works when the storage directory does not exist yet", async () => {
    const nested = join(directory, "not", "yet");
    const seen: CacheFile[] = [];
    watcher = await new SharedCache(nested).watch((file) => seen.push(file), { pollMs: 50 });

    await new SharedCache(nested).refresh(SOURCE, fetchUsed(9));

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), WAIT);
  });
});

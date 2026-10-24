import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheEntry, CacheFile } from "../../../src/cache/entry";
import type { RefreshOutcome, SourceDefinition } from "../../../src/cache/sharedCache";
import type { WatchOptions } from "../../../src/cache/watcher";
import type { ProviderId } from "../../../src/constants";
import {
  DUE_CHECK_INTERVAL_MS,
  QuotaController,
  REDRAW_INTERVAL_MS,
  type CacheAccess,
  type StatusBarSink,
} from "../../../src/statusbar/controller";
import type { ItemSpec } from "../../../src/statusbar/layout";
import { readSettings, type Settings } from "../../../src/statusbar/settings";
import type { QuotaSource } from "../../../src/statusbar/source";
import type { QuotaSnapshot } from "../../../src/model";

const START = 1_700_000_000_000;
const MINUTE = 60_000;

class FakeCache implements CacheAccess {
  file: CacheFile = { version: 1, entries: {} };
  refreshed: SourceDefinition[] = [];
  outcome: RefreshOutcome = "fetched";
  failRead = false;
  failRefresh = false;
  disposed = false;
  private listener: ((file: CacheFile) => void) | null = null;
  watchOptions: WatchOptions | undefined;

  async read(): Promise<CacheFile> {
    if (this.failRead) {
      throw new Error("read failed");
    }
    return this.file;
  }

  async refresh(source: SourceDefinition): Promise<RefreshOutcome> {
    if (this.failRefresh) {
      throw new Error("refresh failed");
    }
    this.refreshed.push(source);
    return this.outcome;
  }

  async watch(onChange: (file: CacheFile) => void, options?: WatchOptions) {
    this.listener = onChange;
    this.watchOptions = options;
    return {
      dispose: () => {
        this.disposed = true;
      },
    };
  }

  change(file: CacheFile): void {
    this.file = file;
    this.listener?.(file);
  }
}

class FakeSink implements StatusBarSink {
  readonly groups = new Map<ProviderId, readonly ItemSpec[]>();
  disposed = false;
  updates = 0;

  update(provider: ProviderId, items: readonly ItemSpec[]): void {
    this.groups.set(provider, items);
    this.updates += 1;
  }

  texts(provider: ProviderId): string[] {
    return (this.groups.get(provider) ?? []).map((item) => item.text);
  }

  dispose(): void {
    this.disposed = true;
  }
}

const THRESHOLDS = { "5h.pct": [{ gte: 70, color: "charts.yellow" }] };

let cache: FakeCache;
let sink: FakeSink;
let values: Record<string, unknown>;
let clock: number;
let errors: unknown[];
let controller: QuotaController;

const settings = (): Settings => readSettings((name) => values[name]);

function entryFor(id: string, snapshot: QuotaSnapshot | null, error: string | null = null): CacheEntry {
  return { source: id, snapshot, error, failures: 0, nextAttemptAt: 0 };
}

const claudeSource = (): QuotaSource => ({
  provider: "claude",
  label: "test source",
  definition: { id: "claude-test", intervalMs: 5 * MINUTE, timeoutMs: 1000 },
  minIntervalMs: MINUTE,
  fetch: async () => ({ ok: false, error: "unused" }),
});

const claudeSnapshot = (usedPercent: number): QuotaSnapshot => ({
  name: "Claude",
  fiveHour: { usedPercent, resetsAt: START + 60 * MINUTE },
  fetchedAt: START,
});

beforeEach(() => {
  vi.useFakeTimers();
  cache = new FakeCache();
  sink = new FakeSink();
  values = { thresholds: THRESHOLDS };
  clock = START;
  errors = [];
  controller = new QuotaController({
    cache,
    sink,
    readSettings: settings,
    onError: (error) => errors.push(error),
    now: () => clock,
  });
});

afterEach(() => {
  controller.dispose();
  vi.useRealTimers();
});

describe("QuotaController", () => {
  it("draws the groups of both providers from the cached data of the registered source", async () => {
    cache.file = { version: 1, entries: { "claude-test": entryFor("claude-test", claudeSnapshot(80)) } };
    await controller.start();

    controller.registerSource(claudeSource());

    expect(sink.texts("claude")).toEqual(["C ", "80", "% 1h · W –%"]);
    expect(sink.texts("codex")).toEqual(["X –% – · W –%"]);
  });

  it("removes the group of a disabled provider", async () => {
    values["codex.enabled"] = false;
    await controller.start();

    expect(sink.groups.get("codex")).toEqual([]);
    expect(sink.texts("claude")).toHaveLength(1);
  });

  it("rebuilds the items when the settings change", async () => {
    await controller.start();
    expect(sink.texts("claude")).toEqual(["C –% – · W –%"]);

    values["claude.format"] = "{5h.pct}|{week.pct}";
    controller.render();
    expect(sink.texts("claude")).toEqual(["–|–"]);

    values["claude.enabled"] = false;
    controller.render();
    expect(sink.texts("claude")).toEqual([]);

    values["claude.enabled"] = true;
    values["claude.format"] = "{";
    controller.render();
    expect(sink.texts("claude")).toEqual(["$(warning) Claude"]);
  });

  it("redraws when another window changes the cache", async () => {
    await controller.start();
    controller.registerSource(claudeSource());

    cache.change({ version: 1, entries: { "claude-test": entryFor("claude-test", claudeSnapshot(95)) } });

    expect(sink.texts("claude")[1]).toBe("95");
    expect(sink.groups.get("claude")?.[1]?.color).toBe("charts.yellow");
  });

  it("redraws every 30 seconds without fetching, so relative times move on", async () => {
    cache.file = { version: 1, entries: { "claude-test": entryFor("claude-test", claudeSnapshot(80)) } };
    await controller.start();
    controller.registerSource(claudeSource());
    await vi.advanceTimersByTimeAsync(0);
    const fetches = cache.refreshed.length;
    expect(sink.texts("claude")[2]).toBe("% 1h · W –%");

    clock += 30 * MINUTE;
    vi.advanceTimersByTime(REDRAW_INTERVAL_MS);

    expect(sink.texts("claude")[2]).toBe("% 30m · W –%");
    expect(cache.refreshed).toHaveLength(fetches);
  });

  it("checks for due sources every minute and lets the cache decide", async () => {
    await controller.start();
    controller.registerSource(claudeSource());
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.refreshed).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DUE_CHECK_INTERVAL_MS);

    expect(cache.refreshed).toHaveLength(2);
    expect(cache.refreshed[1]?.intervalMs).toBe(5 * MINUTE);
  });

  it("refreshes with the minimum interval of the source when asked to", async () => {
    await controller.start();
    controller.registerSource(claudeSource());
    await vi.advanceTimersByTimeAsync(0);
    cache.refreshed.length = 0;

    const outcomes = await controller.refresh();

    expect(outcomes).toEqual({ claude: "fetched" });
    expect(cache.refreshed).toEqual([{ id: "claude-test", intervalMs: MINUTE, timeoutMs: 1000 }]);
  });

  it("refreshes only the requested provider and skips disabled ones", async () => {
    await controller.start();
    controller.registerSource(claudeSource());
    controller.registerSource({ ...claudeSource(), provider: "codex", definition: { id: "codex-test", intervalMs: 1, timeoutMs: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    cache.refreshed.length = 0;

    expect(await controller.refresh("codex")).toEqual({ codex: "fetched" });
    values["claude.enabled"] = false;
    expect(await controller.refresh()).toEqual({ codex: "fetched" });
  });

  it("reports the outcome the cache gives, such as a lock held by another window", async () => {
    await controller.start();
    controller.registerSource(claudeSource());
    cache.outcome = "locked";

    expect(await controller.refresh("claude")).toEqual({ claude: "locked" });
  });

  it("shows the source and the error code of a failed fetch in the tooltip", async () => {
    cache.file = {
      version: 1,
      entries: {
        "claude-test": entryFor("claude-test", { ...claudeSnapshot(10), stale: true, error: "upstream_429" }, "upstream_429"),
      },
    };
    await controller.start();
    controller.registerSource(claudeSource());

    const tooltip = sink.groups.get("claude")?.[0]?.tooltip ?? "";
    expect(tooltip).toContain("Claude · test source");
    expect(tooltip).toContain("Stale: upstream_429");
  });

  it("shows the error code of a source that never succeeded", async () => {
    cache.file = { version: 1, entries: { "claude-test": entryFor("claude-test", null, "auth_missing") } };
    await controller.start();
    controller.registerSource(claudeSource());

    expect(sink.groups.get("claude")?.[0]?.tooltip).toContain("Error: auth_missing");
  });

  it("falls back to no source when the registration is disposed", async () => {
    await controller.start();
    const registration = controller.registerSource(claudeSource());
    expect(sink.groups.get("claude")?.[0]?.tooltip).toContain("test source");

    registration.dispose();

    expect(sink.groups.get("claude")?.[0]?.tooltip).toContain("no source");
  });

  it("keeps a newer source when the registration of a replaced one is disposed", async () => {
    await controller.start();
    const first = controller.registerSource(claudeSource());
    controller.registerSource({ ...claudeSource(), label: "second" });

    first.dispose();

    expect(sink.groups.get("claude")?.[0]?.tooltip).toContain("second");
  });

  it("reports failures of the cache instead of throwing", async () => {
    await controller.start();
    controller.registerSource(claudeSource());
    await vi.advanceTimersByTimeAsync(0);
    cache.failRefresh = true;
    cache.failRead = true;

    await expect(controller.refresh()).resolves.toEqual({});

    expect(errors).toHaveLength(2);
  });

  it("reports a failing status bar instead of throwing from a redraw", async () => {
    await controller.start();
    sink.update = () => {
      throw new Error("sink failed");
    };

    controller.render();

    expect(errors).toEqual([new Error("sink failed")]);
  });

  it("stops everything on dispose", async () => {
    await controller.start();
    controller.dispose();
    const updates = sink.updates;

    controller.render();
    vi.advanceTimersByTime(REDRAW_INTERVAL_MS * 3);

    expect(sink.disposed).toBe(true);
    expect(cache.disposed).toBe(true);
    expect(sink.updates).toBe(updates);
  });

  it("releases the watcher when disposed while starting", async () => {
    const starting = controller.start();
    controller.dispose();
    await starting;

    expect(cache.disposed).toBe(true);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SharedCache } from "../../../../src/cache/sharedCache";
import { PROJECT_URL } from "../../../../src/sources/announced/http";
import {
  WHENRESET_ATTRIBUTION,
  WHENRESET_FORECAST_URL,
  WHENRESET_INTERVAL_MS,
  WHENRESET_LATEST_URL,
  WHENRESET_MIN_INTERVAL_MS,
  createWhenresetLatestLoader,
  createWhenresetSource,
  parseWhenresetForecast,
  parseWhenresetLatest,
} from "../../../../src/sources/announced/whenreset";
import { fakeFetch, fixture, signal, type Reply } from "./fakeFetch";

// whenresetLatest.json and whenresetForecast{Claude,Codex}.json are unchanged
// live responses of 2026-10-25, when `scheduled` was still null. The scheduled
// branch is covered by the synthetic whenresetLatestScheduled.json.
const LATEST = fixture("whenresetLatest.json");
const LATEST_SCHEDULED = fixture("whenresetLatestScheduled.json");
const FORECAST_CLAUDE = fixture("whenresetForecastClaude.json");
const FORECAST_CODEX = fixture("whenresetForecastCodex.json");

const NOW = Date.parse("2026-10-25T22:00:00Z");
const MINUTE = 60_000;
const UA = `just-enough-quota-bar/1.2.3 (+${PROJECT_URL})`;
const day = (date: string): number => Date.parse(`${date}T00:00:00Z`);

describe("parseWhenresetLatest", () => {
  it("reads the last regular reset and the estimate of the live response", () => {
    expect(parseWhenresetLatest(LATEST, "claude")).toEqual({
      next: null,
      last: day("2026-10-21"),
      estimate: day("2026-10-29"),
      scheduled: null,
    });
    expect(parseWhenresetLatest(LATEST, "codex")).toMatchObject({
      next: null,
      last: day("2026-10-23"),
      estimate: day("2026-10-26"),
    });
  });

  it("takes the last reset from stats.last_regular_date, never from a banked latest_event", () => {
    const banked = structuredClone(LATEST) as { products: { claude: Record<string, unknown> } };
    banked.products.claude.latest_event = { date: "2026-10-24", ts: "2026-10-24T09:00:00Z", kind: "banked" };

    expect(parseWhenresetLatest(banked, "claude")?.last).toBe(day("2026-10-21"));
  });

  it("is the earliest announced scheduled entry, from a list or a single object", () => {
    expect(parseWhenresetLatest(LATEST_SCHEDULED, "codex")?.next).toBe(Date.parse("2026-10-27T16:00:00Z"));
    expect(parseWhenresetLatest(LATEST_SCHEDULED, "claude")?.next).toBe(day("2026-10-28"));
  });

  it("leaves a field it cannot read missing", () => {
    const payload = { products: { claude: { stats: { last_regular_date: 20261021 }, next_estimate: "soon" } } };

    expect(parseWhenresetLatest(payload, "claude")).toEqual({
      next: null,
      last: null,
      estimate: null,
      scheduled: undefined,
    });
    expect(parseWhenresetLatest({ products: { claude: {} } }, "claude")?.last).toBeNull();
  });

  it("rejects a response without the product", () => {
    expect(parseWhenresetLatest(null, "claude")).toBeNull();
    expect(parseWhenresetLatest({ products: [] }, "claude")).toBeNull();
    expect(parseWhenresetLatest({ products: { codex: {} } }, "claude")).toBeNull();
  });
});

describe("parseWhenresetForecast", () => {
  it("turns the raw 24 and 48 hour fractions into percentages", () => {
    const claude = parseWhenresetForecast(FORECAST_CLAUDE);
    const codex = parseWhenresetForecast(FORECAST_CODEX);

    expect(claude?.p24).toBeCloseTo(7.69);
    expect(claude?.p48).toBeCloseTo(7.69);
    expect(codex?.p24).toBeCloseTo(12.96);
    expect(codex?.p48).toBeCloseTo(29.63);
  });

  it("leaves a value outside 0-1 missing", () => {
    expect(parseWhenresetForecast({ probabilities: { raw_24h: 1.5, raw_48h: "0.3" } })).toEqual({
      p24: null,
      p48: null,
    });
    expect(parseWhenresetForecast({})).toEqual({ p24: null, p48: null });
  });

  it("rejects a response that is not an object", () => {
    expect(parseWhenresetForecast([])).toBeNull();
  });
});

const options = (fetchImpl: typeof fetch, log: string[] = []) => ({
  fetchImpl,
  userAgent: UA,
  now: () => NOW,
  log: (line: string) => log.push(line),
});

function source(replies: Record<string, Reply | Error>, provider: "claude" | "codex" = "claude") {
  const fake = fakeFetch(replies);
  const log: string[] = [];
  const created = createWhenresetSource(provider, options(fake.fetchImpl, log));
  return { source: created, calls: fake.calls, log };
}

/** A `fetch` that answers only when aborted, and records the signal of each request. */
function hangingFetch(): { fetchImpl: typeof fetch; calls: () => number; signals: (AbortSignal | null)[] } {
  const signals: (AbortSignal | null)[] = [];
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal ?? null);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch;
  return { fetchImpl, calls: () => signals.length, signals };
}

const forecastUrl = (product: string): string => `${WHENRESET_FORECAST_URL}?product=${product}`;

describe("createWhenresetSource", () => {
  it("polls every 30 minutes, at most every 5, with an entry per provider", () => {
    const { source: claude } = source({});

    expect(claude.definition).toMatchObject({
      id: "claude-whenreset",
      intervalMs: WHENRESET_INTERVAL_MS,
      minRetryMs: WHENRESET_MIN_INTERVAL_MS,
    });
    expect(WHENRESET_INTERVAL_MS).toBe(30 * MINUTE);
    expect(claude.minIntervalMs).toBe(WHENRESET_MIN_INTERVAL_MS);
    expect(WHENRESET_MIN_INTERVAL_MS).toBe(5 * MINUTE);
    expect(claude.attribution).toEqual(WHENRESET_ATTRIBUTION);
    expect(claude.attribution.url).toBe("https://whenreset.app/");
  });

  it("combines latest.json and the forecast of the product", async () => {
    const { source: codex, calls } = source(
      {
        [WHENRESET_LATEST_URL]: { body: LATEST },
        [forecastUrl("codex")]: { body: FORECAST_CODEX },
      },
      "codex",
    );

    const result = await codex.fetch(signal());

    expect(result).toEqual({
      ok: true,
      snapshot: {
        name: "Codex",
        announced: {
          next: null,
          kind: null,
          last: day("2026-10-23"),
          p24: expect.closeTo(12.96),
          p48: expect.closeTo(29.63),
          estimate: day("2026-10-26"),
        },
      },
    });
    expect(calls.map((call) => call.url).sort()).toEqual([forecastUrl("codex"), WHENRESET_LATEST_URL].sort());
  });

  it("sends every request with the identifying User-Agent", async () => {
    const { source: claude, calls } = source({
      [WHENRESET_LATEST_URL]: { body: LATEST },
      [forecastUrl("claude")]: { body: FORECAST_CLAUDE },
    });

    await claude.fetch(signal());

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("user-agent")).toBe(UA);
      expect(call.init?.method).toBe("GET");
    }
  });

  it("marks an announced reset with its kind", async () => {
    const { source: claude } = source({
      [WHENRESET_LATEST_URL]: { body: LATEST_SCHEDULED },
      [forecastUrl("claude")]: { body: FORECAST_CLAUDE },
    });

    const result = await claude.fetch(signal());

    expect(result.ok && result.snapshot.announced).toMatchObject({
      next: day("2026-10-28"),
      kind: "announced",
    });
  });

  it("logs the shape of a non-null scheduled field once, without its content", async () => {
    const { source: codex, log } = source(
      {
        [WHENRESET_LATEST_URL]: { body: LATEST_SCHEDULED },
        [forecastUrl("codex")]: { body: FORECAST_CODEX },
      },
      "codex",
    );

    await codex.fetch(signal());
    await codex.fetch(signal());

    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^whenreset codex: scheduled has the shape \[/);
    expect(log[0]).toContain('"certainty":"string"');
    expect(log[0]).not.toContain("2026");
    expect(log[0]).not.toContain("announced");
  });

  it("logs nothing while scheduled is null", async () => {
    const { source: claude, log } = source({
      [WHENRESET_LATEST_URL]: { body: LATEST },
      [forecastUrl("claude")]: { body: FORECAST_CLAUDE },
    });

    await claude.fetch(signal());

    expect(log).toEqual([]);
  });

  it("fails with the code of a failed request", async () => {
    const latestDown = source({
      [WHENRESET_LATEST_URL]: { status: 503, headers: { "retry-after": "120" } },
      [forecastUrl("claude")]: { body: FORECAST_CLAUDE },
    });
    const forecastDown = source({
      [WHENRESET_LATEST_URL]: { body: LATEST },
      [forecastUrl("claude")]: { status: 429 },
    });

    expect(await latestDown.source.fetch(signal())).toEqual({
      ok: false,
      error: "upstream_503",
      retryAfterMs: 120_000,
    });
    expect(await forecastDown.source.fetch(signal())).toMatchObject({ ok: false, error: "upstream_429" });
  });

  it("fails with invalid_announced_response for an unusable body", async () => {
    const noProduct = source({
      [WHENRESET_LATEST_URL]: { body: { products: {} } },
      [forecastUrl("claude")]: { body: FORECAST_CLAUDE },
    });
    const badForecast = source({
      [WHENRESET_LATEST_URL]: { body: LATEST },
      [forecastUrl("claude")]: { body: [1, 2] },
    });

    expect(await noProduct.source.fetch(signal())).toEqual({ ok: false, error: "invalid_announced_response" });
    expect(await badForecast.source.fetch(signal())).toEqual({ ok: false, error: "invalid_announced_response" });
  });

  it("logs the scheduled shape of latest.json even when the forecast fails", async () => {
    const forecastDown = source({
      [WHENRESET_LATEST_URL]: { body: LATEST_SCHEDULED },
      [forecastUrl("claude")]: { status: 503 },
    });
    const badForecast = source({
      [WHENRESET_LATEST_URL]: { body: LATEST_SCHEDULED },
      [forecastUrl("claude")]: { body: [1, 2] },
    });

    expect(await forecastDown.source.fetch(signal())).toMatchObject({ ok: false, error: "upstream_503" });
    expect(await badForecast.source.fetch(signal())).toEqual({ ok: false, error: "invalid_announced_response" });

    for (const { log } of [forecastDown, badForecast]) {
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/^whenreset claude: scheduled has the shape /);
      expect(log[0]).not.toContain("2026");
      expect(log[0]).not.toContain("announced");
    }
  });
});

describe("createWhenresetLatestLoader", () => {
  it("shares one latest.json request between the products fetched together", async () => {
    const fake = fakeFetch({
      [WHENRESET_LATEST_URL]: { body: LATEST },
      [forecastUrl("claude")]: { body: FORECAST_CLAUDE },
      [forecastUrl("codex")]: { body: FORECAST_CODEX },
    });
    const shared = options(fake.fetchImpl);
    const loadLatest = createWhenresetLatestLoader(shared);
    const claude = createWhenresetSource("claude", shared, loadLatest);
    const codex = createWhenresetSource("codex", shared, loadLatest);

    const results = await Promise.all([claude.fetch(signal()), codex.fetch(signal())]);

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(fake.calls.filter((call) => call.url === WHENRESET_LATEST_URL)).toHaveLength(1);
  });

  it("asks again once the shared request has finished", async () => {
    const fake = fakeFetch({ [WHENRESET_LATEST_URL]: { body: LATEST } });
    const loadLatest = createWhenresetLatestLoader(options(fake.fetchImpl));

    await loadLatest(signal());
    await loadLatest(signal());

    expect(fake.calls).toHaveLength(2);
  });

  it("cancels the shared request only when every waiting fetch is cancelled", async () => {
    const hanging = hangingFetch();
    const loadLatest = createWhenresetLatestLoader(options(hanging.fetchImpl));
    const first = new AbortController();
    const second = new AbortController();
    const firstResult = loadLatest(first.signal);
    const secondResult = loadLatest(second.signal);

    first.abort();
    const abortedAfterFirst = hanging.signals[0]?.aborted;
    second.abort();

    expect(abortedAfterFirst).toBe(false);
    expect(hanging.signals[0]?.aborted).toBe(true);
    expect(await firstResult).toEqual({ ok: false, error: "timeout" });
    expect(await secondResult).toEqual({ ok: false, error: "timeout" });
    expect(hanging.calls()).toBe(1);
  });

  it("cancels at once for a fetch that is already cancelled", async () => {
    const hanging = hangingFetch();
    const loadLatest = createWhenresetLatestLoader(options(hanging.fetchImpl));
    const cancelled = new AbortController();
    cancelled.abort();

    expect(await loadLatest(cancelled.signal)).toEqual({ ok: false, error: "timeout" });
  });
});

describe("whenreset through the shared cache", () => {
  let directory: string;
  let clock: number;
  let cache: SharedCache;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "jeqb-whenreset-"));
    clock = NOW;
    cache = new SharedCache(directory, { now: () => clock });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const at = (minutes: number): void => {
    clock = NOW + minutes * MINUTE;
  };

  it("waits 5 minutes after a 503 without Retry-After", async () => {
    const { source: claude, calls } = source({
      [WHENRESET_LATEST_URL]: { status: 503 },
      [forecastUrl("claude")]: { body: FORECAST_CLAUDE },
    });
    const latestRequests = (): number => calls.filter((call) => call.url === WHENRESET_LATEST_URL).length;

    expect(await cache.refresh(claude.definition, claude.fetch)).toBe("failed");
    for (const minutes of [1, 4]) {
      at(minutes);
      expect(await cache.refresh(claude.definition, claude.fetch)).toBe("backoff");
    }
    expect(latestRequests()).toBe(1);

    at(5);
    expect(await cache.refresh(claude.definition, claude.fetch)).toBe("failed");
    expect(latestRequests()).toBe(2);
  });

  it("waits 5 minutes after a timeout", async () => {
    const hanging = hangingFetch();
    const claude = createWhenresetSource("claude", options(hanging.fetchImpl));
    const definition = { ...claude.definition, timeoutMs: 10 };

    expect(await cache.refresh(definition, claude.fetch)).toBe("failed");
    expect((await cache.read()).entries[definition.id]?.error).toBe("timeout");
    const afterFirst = hanging.calls();
    for (const minutes of [1, 4]) {
      at(minutes);
      expect(await cache.refresh(definition, claude.fetch)).toBe("backoff");
    }
    expect(hanging.calls()).toBe(afterFirst);

    at(5);
    expect(await cache.refresh(definition, claude.fetch)).toBe("failed");
    expect(hanging.calls()).toBe(2 * afterFirst);
  });

  it("still waits for a longer Retry-After", async () => {
    const { source: claude } = source({
      [WHENRESET_LATEST_URL]: { status: 503, headers: { "retry-after": "600" } },
      [forecastUrl("claude")]: { body: FORECAST_CLAUDE },
    });

    await cache.refresh(claude.definition, claude.fetch);
    at(5);
    expect(await cache.refresh(claude.definition, claude.fetch)).toBe("backoff");
    at(10);
    expect(await cache.refresh(claude.definition, claude.fetch)).toBe("failed");
  });
});

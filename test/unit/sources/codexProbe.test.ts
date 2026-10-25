import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedCache, type RefreshOutcome } from "../../../src/cache/sharedCache";
import {
  CODEX_MODELS_URL,
  CODEX_PROBE_MIN_INTERVAL_MS,
  CODEX_PROBE_QUOTA_TIMEOUT_MS,
  CODEX_PROBE_TIMEOUT_MS,
  CODEX_RESET_CREDITS_TIMEOUT_MS,
  CODEX_RESET_CREDITS_URL,
  CODEX_RESPONSES_URL,
  createCodexProbeSource,
  parseProbeResetCredits,
  parseQuotaHeaders,
  probeCodex,
  probeIntervalMs,
} from "../../../src/sources/codexProbe";
import type { CodexAuthEnvironment } from "../../../src/sources/codexAuth";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(__dirname, "fixtures", name), "utf8")) as T;
}

const HEADERS = fixture<Record<string, string>>("codexProbeHeaders.json");
const RESET_CREDITS = fixture<unknown>("codexResetCredits.json");
const AUTH_TEXT = readFileSync(resolve(__dirname, "fixtures/codexAuth.json"), "utf8");

const NOW = Date.parse("2026-10-25T12:00:00Z");
const MINUTE_MS = 60_000;

function headersWithout(...names: string[]): Headers {
  const copy = { ...HEADERS };
  names.forEach((name) => delete copy[name]);
  return new Headers(copy);
}

describe("parseQuotaHeaders", () => {
  it("reads both windows and turns reset-after-seconds into a reset time", () => {
    const result = parseQuotaHeaders(new Headers(HEADERS), "Codex", NOW);

    expect(result).toEqual({
      name: "Codex",
      fiveHour: { usedPercent: 42, resetsAt: NOW + 9000 * 1000 },
      week: { usedPercent: 67, resetsAt: NOW + 590400 * 1000 },
    });
  });

  it("identifies the windows by their length, not by primary or secondary", () => {
    const swapped = new Headers({
      "x-codex-primary-used-percent": "10",
      "x-codex-primary-reset-after-seconds": "100",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-secondary-used-percent": "20",
      "x-codex-secondary-reset-after-seconds": "200",
      "x-codex-secondary-window-minutes": "300",
    });

    const result = parseQuotaHeaders(swapped, "Codex", NOW);

    expect(result?.fiveHour?.usedPercent).toBe(20);
    expect(result?.week?.usedPercent).toBe(10);
  });

  it("keeps the one complete window when the other is incomplete", () => {
    const result = parseQuotaHeaders(
      headersWithout("x-codex-secondary-reset-after-seconds"),
      "Codex",
      NOW,
    );

    expect(result?.fiveHour?.usedPercent).toBe(42);
    expect(result).not.toHaveProperty("week");
  });

  it("ignores a window of another length", () => {
    const other = new Headers({ ...HEADERS, "x-codex-secondary-window-minutes": "60" });

    expect(parseQuotaHeaders(other, "Codex", NOW)).not.toHaveProperty("week");
  });

  it.each([
    ["no headers", new Headers()],
    ["missing used-percent", headersWithout("x-codex-primary-used-percent", "x-codex-secondary-used-percent")],
    ["a percentage above 100", new Headers({ ...HEADERS, "x-codex-primary-used-percent": "101", "x-codex-secondary-used-percent": "abc" })],
    ["a negative reset", new Headers({ ...HEADERS, "x-codex-primary-reset-after-seconds": "-1", "x-codex-secondary-reset-after-seconds": "" })],
    ["a zero window", new Headers({ ...HEADERS, "x-codex-primary-window-minutes": "0", "x-codex-secondary-window-minutes": "NaN" })],
  ])("returns null for %s", (_label, headers) => {
    expect(parseQuotaHeaders(headers, "Codex", NOW)).toBeNull();
  });
});

describe("parseProbeResetCredits", () => {
  it("counts the credits and takes the earliest expiry of the available ones", () => {
    expect(parseProbeResetCredits(RESET_CREDITS)).toEqual({
      count: 2,
      nextExpiresAt: Date.parse("2026-10-28T08:30:00Z"),
    });
  });

  it("counts the available credits when available_count is missing", () => {
    const payload = { credits: [{ status: "available" }, { status: "used" }] };

    expect(parseProbeResetCredits(payload)).toEqual({ count: 1, nextExpiresAt: null });
  });

  it("ignores an expiry without a time zone", () => {
    const payload = { available_count: 1, credits: [{ status: "available", expires_at: "2026-10-28T08:30:00" }] };

    expect(parseProbeResetCredits(payload)).toEqual({ count: 1, nextExpiresAt: null });
  });

  it.each([[null], ["x"], [[]], [{}], [{ credits: "no" }]])("returns null for %j", (payload) => {
    expect(parseProbeResetCredits(payload)).toBeNull();
  });
});

describe("probeIntervalMs", () => {
  it("is at least 10 minutes, whatever the setting says", () => {
    expect(probeIntervalMs(1)).toBe(CODEX_PROBE_MIN_INTERVAL_MS);
    expect(probeIntervalMs(0)).toBe(CODEX_PROBE_MIN_INTERVAL_MS);
    expect(probeIntervalMs(-5)).toBe(CODEX_PROBE_MIN_INTERVAL_MS);
    expect(probeIntervalMs(9.9)).toBe(CODEX_PROBE_MIN_INTERVAL_MS);
  });

  it("uses a longer configured interval", () => {
    expect(probeIntervalMs(30)).toBe(30 * MINUTE_MS);
  });

  it.each([[undefined], [null], ["5"], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "falls back to 10 minutes for %j",
    (value) => {
      expect(probeIntervalMs(value)).toBe(CODEX_PROBE_MIN_INTERVAL_MS);
    },
  );
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Step = (signal?: AbortSignal | null) => Response | Promise<Response>;

interface Script {
  models?: Step;
  responses?: Step;
  credits?: Step;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function sseWithHeaders(headers: Record<string, string> = HEADERS, status = 200): Response {
  return new Response("data: {}\n\n", { status, headers });
}

const GOOD: Required<Script> = {
  models: () => json({ models: [{ slug: " " }, { slug: "gpt-fixture" }] }),
  responses: () => sseWithHeaders(),
  credits: () => json(RESET_CREDITS),
};

function scripted(script: Script = {}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const steps = { ...GOOD, ...script };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url === CODEX_MODELS_URL) return steps.models(init?.signal);
    if (url === CODEX_RESPONSES_URL) return steps.responses(init?.signal);
    if (url === CODEX_RESET_CREDITS_URL) return steps.credits(init?.signal);
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls };
}

/** A request that never answers; it fails only when its signal is aborted. */
const stall: Step = (signal) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });

/** Real time `settle` waits for the cache's file I/O; `Date` is not faked. */
const SETTLE_REAL_LIMIT_MS = 4_000;

/** Settles `promise` under fake timers, moving the clock one second at a time while real I/O runs. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  const realDeadline = Date.now() + SETTLE_REAL_LIMIT_MS;
  while (!settled) {
    if (Date.now() > realDeadline) {
      throw new Error("did not settle");
    }
    await new Promise<void>((done) => setImmediate(done));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return tracked;
}

function run(script: Script = {}, signal: AbortSignal = new AbortController().signal) {
  const { fetchImpl, calls } = scripted(script);
  const result = probeCodex(
    { accessToken: "fixture-access-token", accountId: "fixture-account-id", fetchImpl, signal, now: () => NOW },
    "Codex",
  );
  return { result, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("probeCodex", () => {
  it("asks models, then responses, then reset credits, with the token and account id", async () => {
    const { result, calls } = run();

    expect(await result).toEqual({
      ok: true,
      snapshot: {
        name: "Codex",
        fiveHour: { usedPercent: 42, resetsAt: NOW + 9_000_000 },
        week: { usedPercent: 67, resetsAt: NOW + 590_400_000 },
        banked: { count: 2, nextExpiresAt: Date.parse("2026-10-28T08:30:00Z") },
      },
    });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", CODEX_MODELS_URL],
      ["POST", CODEX_RESPONSES_URL],
      ["GET", CODEX_RESET_CREDITS_URL],
    ]);
    for (const call of calls) {
      expect(call.headers.Authorization).toBe("Bearer fixture-access-token");
      expect(call.headers["chatgpt-account-id"]).toBe("fixture-account-id");
    }
    expect(calls[1]?.body).toMatchObject({ model: "gpt-fixture", stream: true, store: false });
  });

  it("keeps the quotas when the reset-credits request fails", async () => {
    const { result } = run({ credits: () => new Response("no", { status: 500 }) });

    const outcome = await result;

    expect(outcome.ok && outcome.snapshot.week?.usedPercent).toBe(67);
    expect(outcome.ok && outcome.snapshot.banked).toBeUndefined();
  });

  it("keeps the quotas when the reset-credits request throws or is not JSON", async () => {
    const thrown = await run({
      credits: () => {
        throw new Error("boom");
      },
    }).result;
    const garbled = await run({ credits: () => new Response("<html>") }).result;

    expect(thrown.ok && thrown.snapshot.banked).toBeUndefined();
    expect(garbled.ok && garbled.snapshot.banked).toBeUndefined();
  });

  it("keeps the quotas when the reset-credits request stalls, inside the overall budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const outcome = await settle(run({ credits: stall }).result);

    expect(outcome.ok && outcome.snapshot.week?.usedPercent).toBe(67);
    expect(outcome.ok && outcome.snapshot.banked).toBeUndefined();
    expect(CODEX_PROBE_QUOTA_TIMEOUT_MS + CODEX_RESET_CREDITS_TIMEOUT_MS).toBeLessThan(
      CODEX_PROBE_TIMEOUT_MS,
    );
  });

  it("reports timeout when the responses request stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    expect(await settle(run({ responses: stall }).result)).toEqual({ ok: false, error: "timeout" });
  });

  it("reports a non-sensitive code when the headers are incomplete, and asks no reset credits", async () => {
    const { result, calls } = run({ responses: () => sseWithHeaders({ "x-codex-primary-used-percent": "5" }) });

    expect(await result).toEqual({ ok: false, error: "invalid_quota_headers" });
    expect(calls.map((call) => call.url)).not.toContain(CODEX_RESET_CREDITS_URL);
  });

  it.each([
    ["models 401", { models: () => new Response("", { status: 401 }) }, "upstream_401"],
    ["responses 403", { responses: () => sseWithHeaders(HEADERS, 403) }, "upstream_403"],
    ["models without a slug", { models: () => json({ models: [{}] }) }, "models_invalid"],
    ["models that are not JSON", { models: () => new Response("x") }, "models_invalid"],
  ] as const)("reports %s as a code", async (_label, script, code) => {
    expect(await run(script).result).toMatchObject({ ok: false, error: code });
  });

  it("passes the Retry-After of a rate limit on", async () => {
    const { result } = run({
      responses: () =>
        sseWithHeaders({ "retry-after": "120" }, 429),
    });

    expect(await result).toEqual({ ok: false, error: "upstream_429", retryAfterMs: 120_000 });
  });

  it("reports network_error when a request throws, and timeout when aborted", async () => {
    const failing = {
      models: () => {
        throw new TypeError("fetch failed: secret-host");
      },
    };
    const controller = new AbortController();
    controller.abort();

    expect(await run(failing).result).toEqual({ ok: false, error: "network_error" });
    expect(await run(failing, controller.signal).result).toEqual({ ok: false, error: "timeout" });
  });
});

describe("createCodexProbeSource", () => {
  function authEnvironment(files: Record<string, string>): CodexAuthEnvironment {
    return {
      codexHome: undefined,
      homeDir: "/home/tester",
      readFile: async (filePath) => {
        const content = Object.entries(files).find(([name]) => filePath.endsWith(name))?.[1];
        if (content === undefined) {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        }
        return content;
      },
    };
  }

  const signal = (): AbortSignal => new AbortController().signal;

  it("is the Codex probe source with a 10 minute interval, never shorter", () => {
    let minutes: unknown = 3;
    const source = createCodexProbeSource({ readIntervalMinutes: () => minutes });

    expect(source.provider).toBe("codex");
    expect(source.label).toBe("probe");
    expect(source.definition.id).toBe("codex");
    expect(source.definition.intervalMs).toBe(10 * MINUTE_MS);
    expect(source.minIntervalMs).toBe(10 * MINUTE_MS);

    minutes = 45;
    expect(source.definition.intervalMs).toBe(45 * MINUTE_MS);
    expect(source.minIntervalMs).toBe(45 * MINUTE_MS);
  });

  it("fetches with the token of auth.json", async () => {
    const { fetchImpl, calls } = scripted();
    const source = createCodexProbeSource({
      authEnvironment: authEnvironment({ "auth.json": AUTH_TEXT }),
      fetchImpl,
      now: () => NOW,
    });

    const result = await source.fetch(signal());

    expect(result.ok).toBe(true);
    expect(calls[0]?.headers.Authorization).toBe("Bearer fixture-access-token");
  });

  it("sends no request and reports auth_missing without auth.json", async () => {
    const { fetchImpl, calls } = scripted();
    const source = createCodexProbeSource({ authEnvironment: authEnvironment({}), fetchImpl });

    expect(await source.fetch(signal())).toEqual({ ok: false, error: "auth_missing" });
    expect(calls).toHaveLength(0);
  });

  it("reports auth_invalid for a broken auth.json", async () => {
    const { fetchImpl, calls } = scripted();
    const source = createCodexProbeSource({
      authEnvironment: authEnvironment({ "auth.json": "{" }),
      fetchImpl,
    });

    expect(await source.fetch(signal())).toEqual({ ok: false, error: "auth_invalid" });
    expect(calls).toHaveLength(0);
  });

  it("makes a failed probe wait the interval, but keeps a longer Retry-After", async () => {
    const failures: Script[] = [
      { responses: () => sseWithHeaders({ "x-codex-primary-used-percent": "5" }) },
      { models: () => new Response("", { status: 401 }) },
      { responses: () => sseWithHeaders({ "retry-after": "1200" }, 429) },
    ];
    const expected = [10 * MINUTE_MS, 10 * MINUTE_MS, 20 * MINUTE_MS];

    for (const [index, script] of failures.entries()) {
      const { fetchImpl } = scripted(script);
      const source = createCodexProbeSource({
        authEnvironment: authEnvironment({ "auth.json": AUTH_TEXT }),
        fetchImpl,
        now: () => NOW,
      });
      expect(await source.fetch(signal())).toMatchObject({ ok: false, retryAfterMs: expected[index] });
    }
  });
});

describe("the probe in the shared cache", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  function harness(script: Script, readIntervalMinutes: () => unknown = () => 3) {
    let clock = NOW;
    let calls = 0;
    let steps = script;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input) === CODEX_RESPONSES_URL) {
        calls += 1;
      }
      return scripted(steps).fetchImpl(input, init);
    };
    const source = createCodexProbeSource({
      authEnvironment: {
        codexHome: undefined,
        homeDir: "/home/tester",
        readFile: async () => AUTH_TEXT,
      },
      fetchImpl,
      now: () => clock,
      readIntervalMinutes,
    });
    return {
      async refreshAt(minutes: number): Promise<RefreshOutcome> {
        directory ??= await mkdtemp(join(tmpdir(), "jeqb-probe-"));
        clock = NOW + minutes * MINUTE_MS;
        return new SharedCache(directory, { now: () => clock }).refresh(source.definition, source.fetch);
      },
      responsesCalls: () => calls,
      answer(next: Script) {
        steps = next;
      },
      cacheDirectory: () => directory as string,
    };
  }

  it("does not send another responses request for 10 minutes after invalid headers", async () => {
    const probe = harness({ responses: () => sseWithHeaders({ "x-codex-primary-used-percent": "5" }) });

    expect(await probe.refreshAt(0)).toBe("failed");
    probe.answer({});
    for (const minutes of [1, 5, 9]) {
      expect(await probe.refreshAt(minutes)).toBe("backoff");
    }
    expect(probe.responsesCalls()).toBe(1);

    expect(await probe.refreshAt(10)).toBe("fetched");
    expect(probe.responsesCalls()).toBe(2);
  });

  it("waits a Retry-After longer than the interval", async () => {
    const probe = harness({ responses: () => sseWithHeaders({ "retry-after": "1500" }, 429) });

    expect(await probe.refreshAt(0)).toBe("failed");
    probe.answer({});
    expect(await probe.refreshAt(10)).toBe("backoff");
    expect(await probe.refreshAt(24)).toBe("backoff");
    expect(await probe.refreshAt(25)).toBe("fetched");
    expect(probe.responsesCalls()).toBe(2);
  });

  it("waits the interval after a stalled responses request times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const probe = harness({ responses: stall });

    expect(await settle(probe.refreshAt(0))).toBe("failed");
    probe.answer({});
    expect(await settle(probe.refreshAt(9))).toBe("backoff");
    expect(await settle(probe.refreshAt(11))).toBe("fetched");
  });

  it("stores the quotas without banked resets when the reset credits stall", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const probe = harness({ credits: stall });

    expect(await settle(probe.refreshAt(0))).toBe("fetched");

    const entry = (await new SharedCache(probe.cacheDirectory()).read()).entries.codex;
    expect(entry?.snapshot?.fiveHour?.usedPercent).toBe(42);
    expect(entry?.snapshot?.week?.usedPercent).toBe(67);
    expect(entry?.snapshot).not.toHaveProperty("banked");
  });
});

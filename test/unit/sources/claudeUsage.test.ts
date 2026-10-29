import { describe, expect, it } from "vitest";
import { MAX_RETRY_AFTER_MS } from "../../../src/cache/backoff";
import {
  CLAUDE_USAGE_URL,
  MAX_RESET_CREDITS,
  MAX_RESET_GRANTS,
  RESET_CREDITS_USER_AGENT,
  USAGE_USER_AGENT,
  fetchUsage,
  parseBankedResets,
  parseUsage,
} from "../../../src/sources/claudeUsage";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const HOUR_MS = 3_600_000;

const FIVE_HOUR = { utilization: 42.4, resets_at: "2026-10-24T15:00:00+00:00" };
const SEVEN_DAY = { utilization: 87, resets_at: "2026-10-28T09:30:00Z" };

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resets_left: 2,
    paused: false,
    starts_at: "2026-10-20T00:00:00Z",
    ends_at: "2026-10-30T00:00:00Z",
    ...overrides,
  };
}

function usage(cedarEmber?: unknown): Record<string, unknown> {
  return {
    five_hour: FIVE_HOUR,
    seven_day: SEVEN_DAY,
    ...(cedarEmber === undefined ? {} : { cedar_ember: cedarEmber }),
  };
}

describe("parseUsage", () => {
  it("reads the utilization and the reset time of both windows", () => {
    const result = parseUsage(usage(), "Claude", NOW);

    expect(result).toEqual({
      ok: true,
      snapshot: {
        name: "Claude",
        fiveHour: { usedPercent: 42, resetsAt: Date.parse("2026-10-24T15:00:00Z") },
        week: { usedPercent: 87, resetsAt: Date.parse("2026-10-28T09:30:00Z") },
      },
    });
  });

  it("leaves the banked block out when cedar_ember is absent", () => {
    const result = parseUsage(usage(), "Claude", NOW);

    expect(result.ok && result.snapshot.banked).toBeUndefined();
  });

  it("includes the banked resets of an eligible cedar_ember block", () => {
    const result = parseUsage(usage({ eligible: true, grants: [grant()] }), "Claude", NOW);

    expect(result.ok && result.snapshot.banked).toEqual({
      count: 2,
      nextExpiresAt: Date.parse("2026-10-30T00:00:00Z"),
    });
  });

  it("keeps the weekly window when the five-hour window is invalid", () => {
    const result = parseUsage({ five_hour: { utilization: "x" }, seven_day: SEVEN_DAY }, "Claude", NOW);

    expect(result.ok).toBe(true);
    expect(result.ok && result.snapshot.fiveHour).toBeUndefined();
    expect(result.ok && result.snapshot.week?.usedPercent).toBe(87);
  });

  it.each([
    ["a string", "text"],
    ["null", null],
    ["an array", []],
    ["an empty object", {}],
    ["no weekly window", { five_hour: FIVE_HOUR }],
    ["a weekly window that is not an object", { seven_day: 5 }],
    ["a weekly utilization that is not a number", { seven_day: { ...SEVEN_DAY, utilization: "87" } }],
    ["a negative utilization", { seven_day: { ...SEVEN_DAY, utilization: -1 } }],
    ["a utilization above 100", { seven_day: { ...SEVEN_DAY, utilization: 100.5 } }],
    ["an infinite utilization", { seven_day: { ...SEVEN_DAY, utilization: Infinity } }],
    ["no reset time", { seven_day: { utilization: 5 } }],
    ["a reset time that is not text", { seven_day: { utilization: 5, resets_at: 5 } }],
    ["a reset time without a zone", { seven_day: { utilization: 5, resets_at: "2026-10-28T09:30:00" } }],
    ["an unparseable reset time", { seven_day: { utilization: 5, resets_at: "tomorrowZ" } }],
  ])("returns invalid_usage_response for %s", (_label, payload) => {
    expect(parseUsage(payload, "Claude", NOW)).toEqual({
      ok: false,
      error: "invalid_usage_response",
    });
  });
});

describe("parseBankedResets", () => {
  it("sums resets_left and takes the earliest end of the usable grants", () => {
    const banked = parseBankedResets(
      {
        cedar_ember: {
          eligible: true,
          grants: [
            grant({ resets_left: 2, ends_at: "2026-11-05T00:00:00Z" }),
            grant({ resets_left: 3, ends_at: "2026-10-26T00:00:00Z" }),
          ],
        },
      },
      NOW,
    );

    expect(banked).toEqual({ count: 5, nextExpiresAt: Date.parse("2026-10-26T00:00:00Z") });
  });

  it("counts a grant that starts exactly now and skips one that ends exactly now", () => {
    const banked = parseBankedResets(
      {
        cedar_ember: {
          eligible: true,
          grants: [
            grant({ resets_left: 1, starts_at: new Date(NOW).toISOString() }),
            grant({ resets_left: 4, ends_at: new Date(NOW).toISOString() }),
          ],
        },
      },
      NOW,
    );

    expect(banked?.count).toBe(1);
  });

  it.each([
    ["paused", { paused: true }],
    ["paused flag missing", { paused: undefined }],
    ["paused flag not boolean", { paused: "false" }],
    ["not started yet", { starts_at: new Date(NOW + HOUR_MS).toISOString() }],
    ["already ended", { ends_at: new Date(NOW - HOUR_MS).toISOString() }],
    ["without resets left", { resets_left: 0 }],
    ["negative resets left", { resets_left: -1 }],
    ["fractional resets left", { resets_left: 1.5 }],
    ["string resets left", { resets_left: "2" }],
    ["missing start", { starts_at: undefined }],
    ["unparseable end", { ends_at: "never" }],
  ])("skips a grant that is %s", (_label, overrides) => {
    const banked = parseBankedResets(
      { cedar_ember: { eligible: true, grants: [grant(overrides), grant({ resets_left: 1 })] } },
      NOW,
    );

    expect(banked?.count).toBe(1);
  });

  it("reports zero resets and no expiry when no grant is usable", () => {
    expect(
      parseBankedResets({ cedar_ember: { eligible: true, grants: [grant({ paused: true })] } }, NOW),
    ).toEqual({ count: 0, nextExpiresAt: null });
  });

  it("ignores grants that are not objects", () => {
    expect(
      parseBankedResets({ cedar_ember: { eligible: true, grants: [null, 5, "x", grant()] } }, NOW)?.count,
    ).toBe(2);
  });

  it.each([
    ["absent", {}],
    ["not an object", { cedar_ember: "yes" }],
    ["not eligible", { cedar_ember: { eligible: false, grants: [grant()] } }],
    ["eligible as text", { cedar_ember: { eligible: "true", grants: [grant()] } }],
    ["without grants", { cedar_ember: { eligible: true } }],
    ["with grants that are not a list", { cedar_ember: { eligible: true, grants: {} } }],
    ["payload not an object", null],
  ])("is null when cedar_ember is %s", (_label, payload) => {
    expect(parseBankedResets(payload, NOW)).toBeNull();
  });

  it("accepts exactly the upper bounds and rejects anything above them", () => {
    const atCreditLimit = { cedar_ember: { eligible: true, grants: [grant({ resets_left: MAX_RESET_CREDITS })] } };
    const aboveCreditLimit = { cedar_ember: { eligible: true, grants: [grant({ resets_left: MAX_RESET_CREDITS + 1 })] } };
    const grants = (count: number): unknown[] =>
      Array.from({ length: count }, () => grant({ resets_left: 0 }));

    expect(parseBankedResets(atCreditLimit, NOW)?.count).toBe(MAX_RESET_CREDITS);
    expect(parseBankedResets(aboveCreditLimit, NOW)).toBeNull();
    expect(parseBankedResets({ cedar_ember: { eligible: true, grants: grants(MAX_RESET_GRANTS) } }, NOW)).toEqual({
      count: 0,
      nextExpiresAt: null,
    });
    expect(parseBankedResets({ cedar_ember: { eligible: true, grants: grants(MAX_RESET_GRANTS + 1) } }, NOW)).toBeNull();
  });

  it("accepts unix times in seconds and milliseconds", () => {
    const banked = parseBankedResets(
      {
        cedar_ember: {
          eligible: true,
          grants: [
            grant({ starts_at: 1_700_000_000, ends_at: Math.floor(NOW / 1000) + 86_400 }),
            grant({ starts_at: 1_700_000_000_000, ends_at: NOW + 2 * 86_400_000 }),
          ],
        },
      },
      NOW,
    );

    expect(banked).toEqual({ count: 4, nextExpiresAt: (Math.floor(NOW / 1000) + 86_400) * 1000 });
  });
});

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal | null | undefined;
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function fakeFetch(responses: (Response | Error)[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      signal: init?.signal,
    });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("unexpected request");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetchImpl, calls };
}

function run(responses: (Response | Error)[], signal = new AbortController().signal) {
  const { fetchImpl, calls } = fakeFetch(responses);
  const result = fetchUsage({ accessToken: "secret-token", fetchImpl, signal }, "Claude", () => NOW);
  return { result, calls };
}

describe("fetchUsage", () => {
  it("asks with cedar_ember=1 and the headers of the sample", async () => {
    const { result, calls } = run([respond(200, usage())]);

    expect((await result).ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${CLAUDE_USAGE_URL}?cedar_ember=1`);
    expect(calls[0]?.headers).toEqual({
      Authorization: "Bearer secret-token",
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
      "User-Agent": RESET_CREDITS_USER_AGENT,
    });
    expect(RESET_CREDITS_USER_AGENT).toBe("claude-cli/2.1.296 (external, cli)");
  });

  it.each([400, 403])("asks once more without the parameter after a %i", async (status) => {
    const { result, calls } = run([respond(status, {}), respond(200, usage())]);

    expect((await result).ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([`${CLAUDE_USAGE_URL}?cedar_ember=1`, CLAUDE_USAGE_URL]);
    expect(calls[1]?.headers["User-Agent"]).toBe(USAGE_USER_AGENT);
    expect(calls[1]?.headers.Authorization).toBe("Bearer secret-token");
  });

  it("does not repeat the request more than once", async () => {
    const { result, calls } = run([respond(403, {}), respond(403, {}), respond(200, usage())]);

    expect(await result).toEqual({ ok: false, error: "upstream_403", retryAfterMs: null });
    expect(calls).toHaveLength(2);
  });

  it.each([401, 404, 500])("does not repeat the request after a %i", async (status) => {
    const { result, calls } = run([respond(status, {})]);

    expect(await result).toEqual({ ok: false, error: `upstream_${status}`, retryAfterMs: null });
    expect(calls).toHaveLength(1);
  });

  it("passes the Retry-After of a 429 on", async () => {
    const { result } = run([respond(429, {}, { "Retry-After": "90" })]);

    expect(await result).toEqual({ ok: false, error: "upstream_429", retryAfterMs: 90_000 });
  });

  it("caps a huge Retry-After of a 429 at 24 hours", async () => {
    const { result } = run([respond(429, {}, { "Retry-After": "999999999" })]);

    expect(await result).toEqual({ ok: false, error: "upstream_429", retryAfterMs: MAX_RETRY_AFTER_MS });
  });

  it("returns invalid_usage_response for a body that is not JSON or not a usage", async () => {
    expect(await run([respond(200, "<html>")]).result).toEqual({ ok: false, error: "invalid_usage_response" });
    expect(await run([respond(200, [])]).result).toEqual({ ok: false, error: "invalid_usage_response" });
    expect(await run([respond(200, { five_hour: FIVE_HOUR })]).result).toEqual({
      ok: false,
      error: "invalid_usage_response",
    });
  });

  it("returns network_error when the request fails", async () => {
    expect(await run([new TypeError("fetch failed: secret-token")]).result).toEqual({
      ok: false,
      error: "network_error",
    });
  });

  it("returns timeout when the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(await run([new DOMException("aborted", "AbortError")], controller.signal).result).toEqual({
      ok: false,
      error: "timeout",
    });
  });

  it("never lets the token or the body into the result", async () => {
    const results = await Promise.all([
      run([respond(500, { detail: "secret-token" })]).result,
      run([new Error("secret-token")]).result,
      run([respond(200, "secret-token")]).result,
    ]);

    expect(JSON.stringify(results)).not.toContain("secret-token");
  });
});

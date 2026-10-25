import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ERROR_INVALID_RATE_LIMITS_RESPONSE,
  parseRateLimits,
  parseResetCredits,
} from "../../../src/sources/codexRateLimits";

/** The parts of the JSON the tests reach into; the rest stays unchecked. */
interface LimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number | null;
}

interface Response {
  rateLimits: { primary: LimitWindow; secondary: LimitWindow };
  rateLimitResetCredits: { credits: object[] } | null;
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/accountRateLimits.json"), "utf8"),
) as Response;

/** A deep copy of the fixture that the test may change. */
function response(): Response {
  return structuredClone(fixture);
}

describe("fixture", () => {
  // The fields of `codex app-server generate-ts` (codex-cli 0.164.0).
  it("has exactly the fields of GetAccountRateLimitsResponse", () => {
    expect(Object.keys(fixture).sort()).toEqual(
      [
        "ordinaryUsageAllowed",
        "rateLimits",
        "rateLimitsByLimitId",
        "rateLimitResetCredits",
        "accountId",
        "rateLimitUpsell",
      ].sort(),
    );
  });

  it("has exactly the fields of RateLimitSnapshot, RateLimitWindow and RateLimitResetCredit", () => {
    expect(Object.keys(fixture.rateLimits).sort()).toEqual(
      [
        "limitId",
        "limitName",
        "normalModelSlug",
        "primary",
        "secondary",
        "credits",
        "individualLimit",
        "spendControlReached",
        "planType",
        "rateLimitReachedType",
      ].sort(),
    );
    expect(Object.keys(fixture.rateLimits.primary).sort()).toEqual(
      ["usedPercent", "windowDurationMins", "resetsAt"].sort(),
    );
    expect(Object.keys(fixture.rateLimitResetCredits ?? {}).sort()).toEqual(["availableCount", "credits"]);
    expect(Object.keys(fixture.rateLimitResetCredits?.credits[0] ?? {}).sort()).toEqual(
      ["id", "resetType", "status", "grantedAt", "expiresAt", "title", "description"].sort(),
    );
  });
});

describe("parseRateLimits", () => {
  it("reads both windows, with the reset in unix seconds converted to ms, and the banked resets", () => {
    expect(parseRateLimits(response(), "Codex")).toEqual({
      ok: true,
      snapshot: {
        name: "Codex",
        fiveHour: { usedPercent: 42, resetsAt: 1792954746 * 1000 },
        week: { usedPercent: 67, resetsAt: 1793541546 * 1000 },
        banked: { count: 2, nextExpiresAt: 1793293042 * 1000 },
      },
    });
  });

  it("identifies the windows by their duration, not by primary/secondary", () => {
    const swapped = response();
    const { primary, secondary } = swapped.rateLimits;
    swapped.rateLimits.primary = secondary;
    swapped.rateLimits.secondary = primary;

    const result = parseRateLimits(swapped, "Codex");

    expect(result.ok && result.snapshot.fiveHour?.usedPercent).toBe(42);
    expect(result.ok && result.snapshot.week?.usedPercent).toBe(67);
  });

  it("leaves a window out when no window has its duration", () => {
    const weekOnly = response();
    weekOnly.rateLimits.primary = { usedPercent: 5, windowDurationMins: 60, resetsAt: 1 };

    const result = parseRateLimits(weekOnly, "Codex");

    expect(result.ok && result.snapshot.fiveHour).toBeUndefined();
    expect(result.ok && result.snapshot.week?.usedPercent).toBe(67);
  });

  it("keeps a window whose reset time is unknown", () => {
    const noReset = response();
    noReset.rateLimits.primary.resetsAt = null;

    const result = parseRateLimits(noReset, "Codex");

    expect(result.ok && result.snapshot.fiveHour).toEqual({ usedPercent: 42, resetsAt: null });
  });

  it("rounds the used percentage", () => {
    const fractional = response();
    fractional.rateLimits.primary.usedPercent = 41.6;

    const result = parseRateLimits(fractional, "Codex");

    expect(result.ok && result.snapshot.fiveHour?.usedPercent).toBe(42);
  });

  it("leaves the banked block out when the response has none", () => {
    const noCredits = response();
    noCredits.rateLimitResetCredits = null;

    const result = parseRateLimits(noCredits, "Codex");

    expect(result.ok && result.snapshot.banked).toBeUndefined();
  });

  it.each([
    ["not an object", "text"],
    ["an array", []],
    ["without rateLimits", {}],
    ["with null rateLimits", { rateLimits: null }],
    ["without any window", { rateLimits: { primary: null, secondary: null } }],
    [
      "with windows of unknown durations",
      { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 60, resetsAt: 1 } } },
    ],
    [
      "with a window without a duration",
      { rateLimits: { primary: { usedPercent: 1, windowDurationMins: null, resetsAt: 1 } } },
    ],
    [
      "with a percentage out of range",
      { rateLimits: { primary: { usedPercent: 101, windowDurationMins: 300, resetsAt: 1 } } },
    ],
    [
      "with a negative percentage",
      { rateLimits: { primary: { usedPercent: -1, windowDurationMins: 300, resetsAt: 1 } } },
    ],
    [
      "with a non-numeric percentage",
      { rateLimits: { primary: { usedPercent: "3", windowDurationMins: 300, resetsAt: 1 } } },
    ],
    ["with a window that is not an object", { rateLimits: { primary: 5 } }],
  ])("fails for a response %s", (_name, payload) => {
    expect(parseRateLimits(payload, "Codex")).toEqual({
      ok: false,
      error: ERROR_INVALID_RATE_LIMITS_RESPONSE,
    });
  });
});

describe("parseResetCredits", () => {
  const credit = (status: string, expiresAt: number | null): Record<string, unknown> => ({
    id: "c",
    resetType: "codexRateLimits",
    status,
    grantedAt: 1,
    expiresAt,
    title: null,
    description: null,
  });

  it("counts availableCount, not the length of the credits list", () => {
    expect(parseResetCredits({ availableCount: 5, credits: [credit("available", 100)] })).toEqual({
      count: 5,
      nextExpiresAt: 100_000,
    });
  });

  it("takes the earliest expiry of the available credits only", () => {
    const banked = parseResetCredits({
      availableCount: 2,
      credits: [
        credit("redeemed", 10),
        credit("available", 300),
        credit("redeeming", 20),
        credit("available", 200),
        credit("unknown", 30),
      ],
    });

    expect(banked).toEqual({ count: 2, nextExpiresAt: 200_000 });
  });

  it("does not let a credit that never expires hide the one that does", () => {
    const banked = parseResetCredits({
      availableCount: 2,
      credits: [credit("available", null), credit("available", 500)],
    });

    expect(banked?.nextExpiresAt).toBe(500_000);
  });

  it("has no expiry when every available credit never expires", () => {
    expect(
      parseResetCredits({ availableCount: 1, credits: [credit("available", null)] }),
    ).toEqual({ count: 1, nextExpiresAt: null });
  });

  it("has no expiry when the details were not read", () => {
    expect(parseResetCredits({ availableCount: 3, credits: null })).toEqual({
      count: 3,
      nextExpiresAt: null,
    });
    expect(parseResetCredits({ availableCount: 0, credits: [] })).toEqual({
      count: 0,
      nextExpiresAt: null,
    });
  });

  it("ignores credits that are not objects", () => {
    expect(parseResetCredits({ availableCount: 1, credits: ["x", null, credit("available", 7)] })).toEqual({
      count: 1,
      nextExpiresAt: 7000,
    });
  });

  it.each([
    ["null", null],
    ["a number", 3],
    ["without a count", { credits: [] }],
    ["a fractional count", { availableCount: 1.5 }],
    ["a negative count", { availableCount: -1 }],
    ["a text count", { availableCount: "2" }],
  ])("is null for %s", (_name, value) => {
    expect(parseResetCredits(value)).toBeNull();
  });
});

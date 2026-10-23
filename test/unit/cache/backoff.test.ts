import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  parseRetryAfter,
  retryDelayMs,
} from "../../../src/cache/backoff";

describe("retryDelayMs", () => {
  it("starts with the base delay after the first failure", () => {
    expect(retryDelayMs(1)).toBe(BACKOFF_BASE_MS);
  });

  it("doubles with every further failure", () => {
    expect(retryDelayMs(2)).toBe(2 * BACKOFF_BASE_MS);
    expect(retryDelayMs(3)).toBe(4 * BACKOFF_BASE_MS);
  });

  it("never exceeds 30 minutes", () => {
    expect(retryDelayMs(50)).toBe(BACKOFF_MAX_MS);
    expect(BACKOFF_MAX_MS).toBe(30 * 60_000);
  });

  it("treats zero failures like the first", () => {
    expect(retryDelayMs(0)).toBe(BACKOFF_BASE_MS);
  });

  it("honors a Retry-After longer than the backoff", () => {
    expect(retryDelayMs(1, 10 * 60_000)).toBe(10 * 60_000);
  });

  it("honors a Retry-After above the 30 minute cap", () => {
    expect(retryDelayMs(1, 2 * 60 * 60_000)).toBe(2 * 60 * 60_000);
  });

  it("keeps the backoff when Retry-After is shorter", () => {
    expect(retryDelayMs(3, 1000)).toBe(4 * BACKOFF_BASE_MS);
  });

  it("ignores a Retry-After that is not a usable number", () => {
    expect(retryDelayMs(1, Number.NaN)).toBe(BACKOFF_BASE_MS);
    expect(retryDelayMs(1, -5)).toBe(BACKOFF_BASE_MS);
  });

  it("honors a Retry-After of several days in full", () => {
    const threeDays = 3 * 24 * 60 * 60_000;
    expect(retryDelayMs(1, threeDays)).toBe(threeDays);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 9, 12, 10, 0, 0);

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
  });

  it("reads an HTTP date relative to now", () => {
    expect(parseRetryAfter("Mon, 12 Oct 2026 10:05:00 GMT", now)).toBe(5 * 60_000);
  });

  it("does not return a negative wait for a date in the past", () => {
    expect(parseRetryAfter("Mon, 12 Oct 2026 09:00:00 GMT", now)).toBe(0);
  });

  it("returns null for absent or malformed headers", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter("  ", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
  });
});

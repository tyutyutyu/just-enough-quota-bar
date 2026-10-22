import { describe, expect, it } from "vitest";
import {
  CACHE_VERSION,
  EMPTY_CACHE,
  UNKNOWN_ERROR,
  isSourceId,
  parseCacheFile,
  sanitizeCacheEntry,
  sanitizeSnapshot,
  serializeCacheFile,
  toErrorCode,
  type CacheFile,
} from "../../../src/cache/entry";
import type { QuotaSnapshot } from "../../../src/model";

const FULL: QuotaSnapshot = {
  name: "Claude",
  fiveHour: { usedPercent: 42, resetsAt: 1000 },
  week: { usedPercent: 67, resetsAt: 2000 },
  banked: { count: 2, nextExpiresAt: 3000 },
  announced: { next: 4000, kind: "announced", last: 500, p24: 12, p48: 60 },
  fetchedAt: 900,
  stale: false,
  error: null,
};

describe("sanitizeSnapshot", () => {
  it("keeps every model field", () => {
    expect(sanitizeSnapshot(FULL)).toEqual(FULL);
  });

  it("drops fields that are not part of the model", () => {
    const dirty = {
      ...FULL,
      accessToken: "sk-secret-token",
      accountId: "acct-123",
      fiveHour: { ...FULL.fiveHour, authorization: "Bearer abc" },
    };
    const text = JSON.stringify(sanitizeSnapshot(dirty));
    expect(text).not.toContain("sk-secret-token");
    expect(text).not.toContain("acct-123");
    expect(text).not.toContain("Bearer");
  });

  it("replaces an error that is not a plain code", () => {
    expect(sanitizeSnapshot({ ...FULL, error: "Bearer abc failed for user@example.com" })?.error).toBe(
      UNKNOWN_ERROR,
    );
  });

  it("nulls non-finite numbers and unknown announced kinds", () => {
    const snapshot = sanitizeSnapshot({
      name: "Codex",
      fiveHour: { usedPercent: Number.NaN, resetsAt: "later" },
      announced: { next: Infinity, kind: "secret", last: null, p24: 1, p48: 2 },
    });
    expect(snapshot?.fiveHour).toEqual({ usedPercent: null, resetsAt: null });
    expect(snapshot?.announced).toEqual({ next: null, kind: null, last: null, p24: 1, p48: 2 });
    expect(snapshot?.fetchedAt).toBeNull();
    expect(snapshot?.stale).toBe(false);
  });

  it("limits the length of the name", () => {
    expect(sanitizeSnapshot({ name: "x".repeat(500) })?.name).toHaveLength(32);
  });

  it("rejects values that are not snapshots", () => {
    expect(sanitizeSnapshot(null)).toBeNull();
    expect(sanitizeSnapshot([])).toBeNull();
    expect(sanitizeSnapshot({ fiveHour: {} })).toBeNull();
  });
});

describe("toErrorCode and isSourceId", () => {
  it("accepts plain codes only", () => {
    expect(toErrorCode("upstream_429")).toBe("upstream_429");
    expect(toErrorCode("Auth Missing")).toBe(UNKNOWN_ERROR);
    expect(toErrorCode(42)).toBe(UNKNOWN_ERROR);
  });

  it("accepts ids that are safe in a file name", () => {
    expect(isSourceId("codex-probe")).toBe(true);
    expect(isSourceId("../evil")).toBe(false);
    expect(isSourceId("a.b")).toBe(false);
    expect(isSourceId("")).toBe(false);
  });
});

describe("sanitizeCacheEntry", () => {
  const entry = { source: "claude", snapshot: FULL, error: null, failures: 0, nextAttemptAt: 0 };

  it("keeps a valid entry", () => {
    expect(sanitizeCacheEntry(entry)).toEqual(entry);
  });

  it("rejects an entry without a valid source", () => {
    expect(sanitizeCacheEntry({ ...entry, source: "../x" })).toBeNull();
    expect(sanitizeCacheEntry({ ...entry, source: 1 })).toBeNull();
    expect(sanitizeCacheEntry(null)).toBeNull();
  });

  it("repairs counters", () => {
    const repaired = sanitizeCacheEntry({ ...entry, failures: -2, nextAttemptAt: "x" });
    expect(repaired?.failures).toBe(0);
    expect(repaired?.nextAttemptAt).toBe(0);
  });
});

describe("parseCacheFile", () => {
  it("round-trips through serialize", () => {
    const file: CacheFile = {
      version: CACHE_VERSION,
      entries: {
        claude: { source: "claude", snapshot: FULL, error: null, failures: 0, nextAttemptAt: 0 },
      },
    };
    expect(parseCacheFile(serializeCacheFile(file))).toEqual(file);
  });

  it("returns an empty cache for broken or foreign content", () => {
    expect(parseCacheFile("")).toBe(EMPTY_CACHE);
    expect(parseCacheFile("{not json")).toBe(EMPTY_CACHE);
    expect(parseCacheFile("[]")).toBe(EMPTY_CACHE);
    expect(parseCacheFile('{"version":99,"entries":{}}')).toBe(EMPTY_CACHE);
    expect(parseCacheFile('{"version":1,"entries":[]}')).toBe(EMPTY_CACHE);
  });

  it("skips entries whose key does not match their source", () => {
    const text = JSON.stringify({
      version: CACHE_VERSION,
      entries: {
        claude: { source: "codex", snapshot: null },
        "../x": { source: "../x", snapshot: null },
        codex: { source: "codex", snapshot: null, token: "sk-secret" },
      },
    });
    const parsed = parseCacheFile(text);
    expect(Object.keys(parsed.entries)).toEqual(["codex"]);
    expect(JSON.stringify(parsed)).not.toContain("sk-secret");
  });
});

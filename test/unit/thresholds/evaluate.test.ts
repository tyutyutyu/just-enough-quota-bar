import { describe, expect, it } from "vitest";
import type { QuotaSnapshot } from "../../../src/model";
import { colorFor, type ColorContext } from "../../../src/thresholds/evaluate";
import { parseThresholds } from "../../../src/thresholds/parse";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 12, 10, 0);
const FRESH: ColorContext = { nowMs: NOW, stale: false, staleColor: "disabledForeground" };

const THRESHOLDS = parseThresholds({
  "5h.pct": [
    { gte: 70, color: "charts.yellow" },
    { gte: 90, color: "errorForeground", background: "error" },
  ],
  "week.left": [{ lt: 10, color: "charts.red" }],
  "banked.count": [{ gt: 0, color: "charts.green" }],
  "banked.expires": [
    { lte: "3d", color: "charts.orange" },
    { lte: "1d", color: "errorForeground" },
  ],
  "announced.kind": [{ eq: "estimate", color: "charts.blue" }],
  "week.pct": [{ gte: 70, color: "charts.yellow" }],
}).thresholds;

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return { name: "Claude", ...overrides };
}

const used = (usedPercent: number | null): QuotaSnapshot =>
  snapshot({ fiveHour: { usedPercent, resetsAt: null } });

describe("colorFor", () => {
  it("gives no color below every step", () => {
    expect(colorFor("5h.pct", used(69.9), THRESHOLDS, FRESH)).toBeNull();
  });

  it("matches gte on its boundary", () => {
    expect(colorFor("5h.pct", used(70), THRESHOLDS, FRESH)).toEqual({ color: "charts.yellow" });
  });

  it("lets the last matching step win", () => {
    expect(colorFor("5h.pct", used(95), THRESHOLDS, FRESH)).toEqual({
      color: "errorForeground",
      background: "error",
    });
  });

  it("evaluates in list order rather than by severity", () => {
    const descending = parseThresholds({
      "5h.pct": [
        { gte: 90, color: "errorForeground" },
        { gte: 70, color: "charts.yellow" },
      ],
    }).thresholds;
    expect(colorFor("5h.pct", used(95), descending, FRESH)).toEqual({ color: "charts.yellow" });
  });

  it("has no color for a variable without steps", () => {
    expect(
      colorFor("week.pct", snapshot({ week: { usedPercent: 99, resetsAt: null } }), new Map(), FRESH),
    ).toBeNull();
  });

  it("has no color for an absent value", () => {
    expect(colorFor("5h.pct", used(null), THRESHOLDS, FRESH)).toBeNull();
    expect(colorFor("5h.pct", snapshot(), THRESHOLDS, FRESH)).toBeNull();
  });

  it("honors gt and lt as strict comparisons", () => {
    const left = (usedPercent: number) => snapshot({ week: { usedPercent, resetsAt: null } });
    expect(colorFor("week.left", left(90), THRESHOLDS, FRESH)).toBeNull();
    expect(colorFor("week.left", left(90.5), THRESHOLDS, FRESH)).toEqual({ color: "charts.red" });
    expect(
      colorFor(
        "banked.count",
        snapshot({ banked: { count: 0, nextExpiresAt: null } }),
        THRESHOLDS,
        FRESH,
      ),
    ).toBeNull();
    expect(
      colorFor(
        "banked.count",
        snapshot({ banked: { count: 1, nextExpiresAt: null } }),
        THRESHOLDS,
        FRESH,
      ),
    ).toEqual({
      color: "charts.green",
    });
  });

  describe("time variables", () => {
    const expiresIn = (ms: number) => snapshot({ banked: { count: 1, nextExpiresAt: NOW + ms } });

    it("compares the remaining duration", () => {
      expect(colorFor("banked.expires", expiresIn(4 * DAY), THRESHOLDS, FRESH)).toBeNull();
      expect(colorFor("banked.expires", expiresIn(3 * DAY), THRESHOLDS, FRESH)).toEqual({
        color: "charts.orange",
      });
      expect(colorFor("banked.expires", expiresIn(2 * DAY), THRESHOLDS, FRESH)).toEqual({
        color: "charts.orange",
      });
      expect(colorFor("banked.expires", expiresIn(DAY), THRESHOLDS, FRESH)).toEqual({
        color: "errorForeground",
      });
    });

    it("treats a time in the past as a negative remaining duration", () => {
      expect(colorFor("banked.expires", expiresIn(-HOUR), THRESHOLDS, FRESH)).toEqual({
        color: "errorForeground",
      });
    });

    it("moves with the reference time", () => {
      const later = { ...FRESH, nowMs: NOW + 3 * DAY };
      expect(colorFor("banked.expires", expiresIn(4 * DAY), THRESHOLDS, later)).toEqual({
        color: "errorForeground",
      });
    });
  });

  describe("text variables", () => {
    const kind = (value: "announced" | "estimate") =>
      snapshot({ announced: { next: null, kind: value, last: null, p24: null, p48: null } });

    it("matches eq on equal text only", () => {
      expect(colorFor("announced.kind", kind("estimate"), THRESHOLDS, FRESH)).toEqual({
        color: "charts.blue",
      });
      expect(colorFor("announced.kind", kind("announced"), THRESHOLDS, FRESH)).toBeNull();
    });
  });

  describe("stale data", () => {
    const stale: ColorContext = { ...FRESH, stale: true, staleColor: "#808080" };

    it("takes the stale color above a matching threshold", () => {
      expect(colorFor("5h.pct", used(95), THRESHOLDS, stale)).toEqual({ color: "#808080" });
    });

    it("takes the stale color where no threshold matches", () => {
      expect(colorFor("5h.pct", used(10), THRESHOLDS, stale)).toEqual({ color: "#808080" });
    });

    it("drops the threshold background", () => {
      expect(colorFor("5h.pct", used(95), THRESHOLDS, stale)).not.toHaveProperty("background");
    });

    it("still leaves absent values uncolored", () => {
      expect(colorFor("5h.pct", used(null), THRESHOLDS, stale)).toBeNull();
    });
  });
});

import { describe, expect, it } from "vitest";
import type { QuotaSnapshot } from "../../../src/model";
import { applyElapsedResets } from "../../../src/statusbar/elapsed";

const NOW = 1_000_000;

describe("applyElapsedResets", () => {
  it("returns the snapshot itself while no reset has been reached", () => {
    const snapshot: QuotaSnapshot = {
      name: "Claude",
      fiveHour: { usedPercent: 40, resetsAt: NOW + 1 },
      week: { usedPercent: 10, resetsAt: null },
    };

    expect(applyElapsedResets(snapshot, NOW)).toBe(snapshot);
  });

  it("returns the snapshot itself when it has no windows", () => {
    const snapshot: QuotaSnapshot = { name: "Claude" };

    expect(applyElapsedResets(snapshot, NOW)).toBe(snapshot);
  });

  it("zeroes a window whose reset time has passed and marks the snapshot stale", () => {
    const snapshot: QuotaSnapshot = {
      name: "Claude",
      fiveHour: { usedPercent: 99, resetsAt: NOW },
      week: { usedPercent: 50, resetsAt: NOW + 5000 },
    };

    const result = applyElapsedResets(snapshot, NOW);

    expect(result.fiveHour).toEqual({ usedPercent: 0, resetsAt: NOW });
    expect(result.week).toBe(snapshot.week);
    expect(result.stale).toBe(true);
    expect(snapshot.fiveHour?.usedPercent).toBe(99);
  });

  it("zeroes the weekly window as well", () => {
    const snapshot: QuotaSnapshot = { name: "Codex", week: { usedPercent: 80, resetsAt: NOW - 1 } };

    expect(applyElapsedResets(snapshot, NOW).week?.usedPercent).toBe(0);
  });
});

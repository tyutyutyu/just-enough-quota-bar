import type { QuotaSnapshot, QuotaWindow } from "../model";

function resetWindow(window: QuotaWindow | undefined, nowMs: number): QuotaWindow | undefined {
  if (window === undefined || window.resetsAt === null || window.resetsAt > nowMs) {
    return undefined;
  }
  return { usedPercent: 0, resetsAt: window.resetsAt };
}

/**
 * Applies the resets that happened since the data was fetched: a window whose
 * reset time has passed reads 0% and the snapshot counts as stale until the
 * next successful fetch. Returns `snapshot` itself when nothing has elapsed.
 */
export function applyElapsedResets(snapshot: QuotaSnapshot, nowMs: number): QuotaSnapshot {
  const fiveHour = resetWindow(snapshot.fiveHour, nowMs);
  const week = resetWindow(snapshot.week, nowMs);
  if (fiveHour === undefined && week === undefined) {
    return snapshot;
  }
  return {
    ...snapshot,
    ...(fiveHour && { fiveHour }),
    ...(week && { week }),
    stale: true,
  };
}

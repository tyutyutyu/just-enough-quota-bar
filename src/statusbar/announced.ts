import type { AnnouncedReset } from "../model";

const DAY_MS = 86_400_000;

/**
 * The announced values as shown. Without an announced reset, and only when
 * estimates are enabled, the tracker's estimate becomes `next` with the
 * `estimate` kind. The estimate is a fixed day that never moves forward: once
 * that day is over it only means the typical interval has passed, so it
 * counts as missing.
 */
export function resolveAnnounced(
  values: AnnouncedReset,
  includeEstimates: boolean,
  nowMs: number,
): AnnouncedReset {
  const estimate = values.estimate ?? null;
  if (values.next !== null || !includeEstimates || estimate === null || nowMs >= estimate + DAY_MS) {
    return values;
  }
  return { ...values, next: estimate, kind: "estimate" };
}

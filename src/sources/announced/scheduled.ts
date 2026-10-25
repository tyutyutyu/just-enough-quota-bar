import { isRecord, parseIsoTime, parseUtcDate } from "./http";

/**
 * One entry of whenreset's `scheduled` field.
 *
 * The field was `null` whenever it was checked, so only `certainty`
 * (`announced` / `hinted`) is documented. The time fields are an assumption
 * consistent with the v1 event schema: `ts` (ISO UTC), otherwise `date`
 * (`YYYY-MM-DD`, the start of that UTC day).
 */
export interface ScheduledReset {
  readonly certainty: string;
  /** Unix time in ms. */
  readonly at: number;
}

const MAX_SHAPE_DEPTH = 5;
const MAX_SHAPE_ITEMS = 5;

function parseEntry(value: unknown): ScheduledReset | null {
  if (!isRecord(value) || typeof value.certainty !== "string") {
    return null;
  }
  const at = parseIsoTime(value.ts) ?? parseUtcDate(value.date);
  return at === null ? null : { certainty: value.certainty, at };
}

/**
 * Reads `scheduled` tolerantly: `null`, a list or a single object are all
 * accepted, and an entry that cannot be read is left out instead of failing.
 */
export function parseScheduled(value: unknown): readonly ScheduledReset[] {
  if (value === null || value === undefined) {
    return [];
  }
  const entries: readonly unknown[] = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    const parsed = parseEntry(entry);
    return parsed === null ? [] : [parsed];
  });
}

/** The earliest `certainty: announced` entry, as ms; `null` when there is none. */
export function earliestAnnounced(entries: readonly ScheduledReset[]): number | null {
  const times = entries.filter((entry) => entry.certainty === "announced").map((entry) => entry.at);
  return times.length === 0 ? null : Math.min(...times);
}

type Shape = string | readonly Shape[] | { readonly [key: string]: Shape };

function shapeOf(value: unknown, depth: number): Shape {
  if (Array.isArray(value)) {
    return depth < MAX_SHAPE_DEPTH
      ? value.slice(0, MAX_SHAPE_ITEMS).map((item) => shapeOf(item, depth + 1))
      : "array";
  }
  if (isRecord(value)) {
    return depth < MAX_SHAPE_DEPTH
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shapeOf(item, depth + 1)]))
      : "object";
  }
  return value === null ? "null" : typeof value;
}

/** The keys and value types of `value`, without any of its content. */
export function describeShape(value: unknown): string {
  return JSON.stringify(shapeOf(value, 0));
}

import type { QuotaSnapshot } from "../model";

export type VariableKind = "number" | "time" | "text";

export interface NumberVariable {
  readonly kind: "number";
  readonly resolve: (snapshot: QuotaSnapshot) => number | null;
}

/** Resolves to a unix timestamp in milliseconds. */
export interface TimeVariable {
  readonly kind: "time";
  readonly resolve: (snapshot: QuotaSnapshot) => number | null;
}

export interface TextVariable {
  readonly kind: "text";
  readonly resolve: (snapshot: QuotaSnapshot) => string | null;
}

export type VariableDefinition = NumberVariable | TimeVariable | TextVariable;

const PERCENT_MAX = 100;
// Largest timestamp a Date can represent.
const MAX_TIME_MS = 8.64e15;

function finite(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function validTime(value: number | null | undefined): number | null {
  const time = finite(value);
  return time !== null && Math.abs(time) <= MAX_TIME_MS ? time : null;
}

function remainingPct(usedPercent: number | null | undefined): number | null {
  const used = finite(usedPercent);
  return used === null ? null : Math.min(PERCENT_MAX, Math.max(0, PERCENT_MAX - used));
}

export const VARIABLES = {
  "5h.pct": { kind: "number", resolve: (s) => finite(s.fiveHour?.usedPercent) },
  "5h.left": { kind: "number", resolve: (s) => remainingPct(s.fiveHour?.usedPercent) },
  "5h.reset": { kind: "time", resolve: (s) => validTime(s.fiveHour?.resetsAt) },
  "week.pct": { kind: "number", resolve: (s) => finite(s.week?.usedPercent) },
  "week.left": { kind: "number", resolve: (s) => remainingPct(s.week?.usedPercent) },
  "week.reset": { kind: "time", resolve: (s) => validTime(s.week?.resetsAt) },
  "banked.count": { kind: "number", resolve: (s) => finite(s.banked?.count) },
  "banked.expires": { kind: "time", resolve: (s) => validTime(s.banked?.nextExpiresAt) },
  "announced.next": { kind: "time", resolve: (s) => validTime(s.announced?.next) },
  "announced.kind": { kind: "text", resolve: (s) => s.announced?.kind ?? null },
  "announced.last": { kind: "time", resolve: (s) => validTime(s.announced?.last) },
  "announced.p24": { kind: "number", resolve: (s) => finite(s.announced?.p24) },
  "announced.p48": { kind: "number", resolve: (s) => finite(s.announced?.p48) },
  name: { kind: "text", resolve: (s) => s.name },
} as const satisfies Record<string, VariableDefinition>;

export type VariableName = keyof typeof VARIABLES;

export function isVariableName(name: string): name is VariableName {
  return Object.hasOwn(VARIABLES, name);
}

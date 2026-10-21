import type { QuotaSnapshot } from "../model";
import { VARIABLES, type VariableName } from "../format/variables";
import type { ThresholdMap, ThresholdOperator, ThresholdStep } from "./parse";
import type { ThresholdStyle } from "./style";

export interface ColorContext {
  /** Reference of the remaining time of time variables. */
  readonly nowMs: number;
  /** Stale data is dimmed with `staleColor` whatever the thresholds say. */
  readonly stale: boolean;
  /** The `jeqb.staleColor` setting, already validated with `parseColor`. */
  readonly staleColor: string;
}

/**
 * The style of one variable, or `null` when it has none.
 *
 * Steps are evaluated in order and the last matching one wins. Time variables
 * compare their remaining duration; an absent value is never colored.
 */
export function colorFor(
  variable: VariableName,
  snapshot: QuotaSnapshot,
  thresholds: ThresholdMap,
  context: ColorContext,
): ThresholdStyle | null {
  const value = comparableValue(variable, snapshot, context.nowMs);
  if (value === null) {
    return null;
  }
  if (context.stale) {
    return { color: context.staleColor };
  }
  const matching = (thresholds.get(variable) ?? []).filter((step) => matches(step, value));
  return matching.at(-1)?.style ?? null;
}

function comparableValue(
  variable: VariableName,
  snapshot: QuotaSnapshot,
  nowMs: number,
): number | string | null {
  const definition = VARIABLES[variable];
  const value = definition.resolve(snapshot);
  return definition.kind === "time" && typeof value === "number" ? value - nowMs : value;
}

function matches(step: ThresholdStep, value: number | string): boolean {
  if (typeof value !== typeof step.operand) {
    return false;
  }
  return compare(step.operator, value, step.operand);
}

function compare(
  operator: ThresholdOperator,
  value: number | string,
  operand: number | string,
): boolean {
  switch (operator) {
    case "gte":
      return value >= operand;
    case "gt":
      return value > operand;
    case "lte":
      return value <= operand;
    case "lt":
      return value < operand;
    case "eq":
      return value === operand;
  }
}

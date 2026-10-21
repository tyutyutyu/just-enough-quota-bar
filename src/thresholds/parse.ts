import { specError, specOk, type SpecResult } from "../format/errors";
import {
  VARIABLES,
  isVariableName,
  type VariableKind,
  type VariableName,
} from "../format/variables";
import { parseDuration } from "./duration";
import { parseBackground, parseColor, type ThresholdStyle } from "./style";

export type ThresholdOperator = "gte" | "gt" | "lte" | "lt" | "eq";

const OPERATORS: readonly ThresholdOperator[] = ["gte", "gt", "lte", "lt", "eq"];
const STEP_KEYS: ReadonlySet<string> = new Set([...OPERATORS, "color", "background"]);

/** One validated step: `operand` is a number, milliseconds of a duration, or text. */
export interface ThresholdStep {
  readonly operator: ThresholdOperator;
  readonly operand: number | string;
  readonly style: ThresholdStyle;
}

/** Validated step lists by variable; only variables with a valid list appear. */
export type ThresholdMap = ReadonlyMap<VariableName, readonly ThresholdStep[]>;

/** One rejected entry; the rest of the configuration keeps working. */
export interface ThresholdError {
  /** The configured key, which is not necessarily a known variable. */
  readonly variable: string;
  /** Zero-based position in the step list; `null` when the whole key is rejected. */
  readonly index: number | null;
  readonly message: string;
}

export interface ParsedThresholds {
  readonly thresholds: ThresholdMap;
  readonly errors: readonly ThresholdError[];
}

/** Validates a `jeqb.thresholds`-shaped value; bad entries become errors, never exceptions. */
export function parseThresholds(raw: unknown): ParsedThresholds {
  if (raw === undefined || raw === null) {
    return { thresholds: new Map(), errors: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      thresholds: new Map(),
      errors: [
        {
          variable: "",
          index: null,
          message: "Thresholds must be an object keyed by variable name",
        },
      ],
    };
  }

  const thresholds = new Map<VariableName, readonly ThresholdStep[]>();
  const errors: ThresholdError[] = [];
  for (const [variable, list] of Object.entries(raw)) {
    if (!isVariableName(variable)) {
      errors.push({ variable, index: null, message: `Unknown variable "${variable}"` });
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push({ variable, index: null, message: "Expected a list of steps" });
      continue;
    }
    const steps: ThresholdStep[] = [];
    list.forEach((entry: unknown, index) => {
      const step = parseStep(entry, VARIABLES[variable].kind);
      if (step.ok) {
        steps.push(step.spec);
      } else {
        errors.push({ variable, index, message: step.message });
      }
    });
    thresholds.set(variable, steps);
  }
  return { thresholds, errors };
}

/** Provider steps replace the global steps of the same variable, key by key. */
export function mergeThresholds(base: ThresholdMap, override: ThresholdMap): ThresholdMap {
  return new Map([...base, ...override]);
}

/** Parses the global and the provider block and merges them, errors of both included. */
export function resolveThresholds(globalRaw: unknown, providerRaw: unknown): ParsedThresholds {
  const global = parseThresholds(globalRaw);
  const provider = parseThresholds(providerRaw);
  return {
    thresholds: mergeThresholds(global.thresholds, provider.thresholds),
    errors: [...global.errors, ...provider.errors],
  };
}

function parseStep(entry: unknown, kind: VariableKind): SpecResult<ThresholdStep> {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return specError('Expected a step object such as { "gte": 70, "color": "charts.red" }');
  }
  const record = entry as Readonly<Record<string, unknown>>;

  const unknownKey = Object.keys(record).find((key) => !STEP_KEYS.has(key));
  if (unknownKey !== undefined) {
    return specError(`Unknown key "${unknownKey}"`);
  }
  const operators = OPERATORS.filter((operator) => Object.hasOwn(record, operator));
  const [operator] = operators;
  if (operator === undefined || operators.length > 1) {
    return specError(`Expected exactly one condition of ${OPERATORS.join(", ")}`);
  }

  const operand = parseOperand(operator, record[operator], kind);
  if (!operand.ok) {
    return operand;
  }
  const color = parseColor(record["color"]);
  if (!color.ok) {
    return color;
  }
  if (!Object.hasOwn(record, "background")) {
    return specOk({ operator, operand: operand.spec, style: { color: color.spec } });
  }
  const background = parseBackground(record["background"]);
  return background.ok
    ? specOk({
        operator,
        operand: operand.spec,
        style: { color: color.spec, background: background.spec },
      })
    : background;
}

function parseOperand(
  operator: ThresholdOperator,
  value: unknown,
  kind: VariableKind,
): SpecResult<number | string> {
  if (kind === "text") {
    return operator === "eq" && typeof value === "string"
      ? specOk(value)
      : specError(`Text variables only support "eq" with a text value`);
  }
  if (operator === "eq") {
    return specError(`"eq" is only supported for text variables`);
  }
  if (kind === "time") {
    return typeof value === "string"
      ? parseDuration(value)
      : specError(`"${operator}" needs a duration such as "90m" or "3d" for a time variable`);
  }
  return typeof value === "number" && Number.isFinite(value)
    ? specOk(value)
    : specError(`"${operator}" needs a number for a number variable`);
}

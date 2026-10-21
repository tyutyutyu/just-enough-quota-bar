import type { QuotaSnapshot } from "../model";
import type { FieldToken, Token } from "./parser";
import { formatNumber } from "./numberSpec";
import { formatText } from "./textSpec";
import { formatTime } from "./timeSpec";
import type { VariableKind, VariableName } from "./variables";

export interface LiteralSegment {
  readonly type: "literal";
  readonly text: string;
}

export interface VariableSegment {
  readonly type: "variable";
  readonly variable: VariableName;
  readonly valueKind: VariableKind;
  /** The displayed text; the missing-value text when the value is absent. */
  readonly text: string;
  /**
   * The unformatted value: a number, a timestamp in milliseconds for time
   * variables, or text. `null` when the value is absent.
   */
  readonly raw: number | string | null;
}

export type Segment = LiteralSegment | VariableSegment;

/**
 * Evaluates a parsed format against a snapshot, as segments in format order.
 * `nowMs` is the reference of relative times; absent values render as
 * `missingValue` whatever their spec says.
 */
export function render(
  tokens: readonly Token[],
  snapshot: QuotaSnapshot,
  nowMs: number,
  missingValue: string,
): readonly Segment[] {
  return tokens.map((token) =>
    token.type === "literal" ? token : renderField(token, snapshot, nowMs, missingValue),
  );
}

function renderField(
  field: FieldToken,
  snapshot: QuotaSnapshot,
  nowMs: number,
  missingValue: string,
): VariableSegment {
  const segment = (text: string, raw: number | string | null): VariableSegment => ({
    type: "variable",
    variable: field.variable,
    valueKind: field.kind,
    text,
    raw,
  });

  switch (field.kind) {
    case "number": {
      const value = field.resolve(snapshot);
      return value === null ? segment(missingValue, null) : segment(formatNumber(value, field.spec), value);
    }
    case "time": {
      const value = field.resolve(snapshot);
      return value === null
        ? segment(missingValue, null)
        : segment(formatTime(value, nowMs, field.spec), value);
    }
    case "text": {
      const value = field.resolve(snapshot);
      return value === null ? segment(missingValue, null) : segment(formatText(value, field.spec), value);
    }
  }
}

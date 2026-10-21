import { specError, specOk, type SpecResult } from "./errors";
import { applyPad, parseAlignWidthPrecision, type PadSpec } from "./pad";

export interface NumberSpec {
  readonly pad: PadSpec;
  /** Digits after the decimal point; integers by default. */
  readonly precision: number;
}

const DEFAULT_PRECISION = 0;

/** Parses `[[fill]align][width][.precision]` for number variables. */
export function parseNumberSpec(spec: string): SpecResult<NumberSpec> {
  const parsed = parseAlignWidthPrecision(spec, ">");
  if (!parsed.ok) {
    return specError(`${parsed.message}; expected [[fill]align][width][.precision] for numbers`);
  }
  return specOk({
    pad: parsed.spec.pad,
    precision: parsed.spec.precision ?? DEFAULT_PRECISION,
  });
}

export function formatNumber(value: number, spec: NumberSpec): string {
  // `toFixed` keeps the sign of values that round to zero ("-0").
  const text = value.toFixed(spec.precision).replace(/^-(0(?:\.0*)?)$/, "$1");
  return applyPad(text, spec.pad);
}

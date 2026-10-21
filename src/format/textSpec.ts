import { specError, specOk, type SpecResult } from "./errors";
import { applyPad, parseAlignWidthPrecision, type PadSpec } from "./pad";

export interface TextSpec {
  readonly pad: PadSpec;
}

/** Parses `[[fill]align][width]` for text variables. */
export function parseTextSpec(spec: string): SpecResult<TextSpec> {
  const parsed = parseAlignWidthPrecision(spec, "<");
  if (!parsed.ok) {
    return specError(`${parsed.message}; expected [[fill]align][width] for text`);
  }
  if (parsed.spec.precision !== null) {
    return specError(`Invalid format spec "${spec}"; text has no precision, expected [[fill]align][width]`);
  }
  return specOk({ pad: parsed.spec.pad });
}

export function formatText(value: string, spec: TextSpec): string {
  return applyPad(value, spec.pad);
}

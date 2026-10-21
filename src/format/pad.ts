import { specError, specOk, type SpecResult } from "./errors";

export type Align = "<" | ">" | "^";

export interface PadSpec {
  readonly fill: string;
  readonly align: Align;
  /** Minimum width in characters; 0 means no padding. */
  readonly width: number;
}

export interface ParsedSpec {
  readonly pad: PadSpec;
  readonly precision: number | null;
}

export const MAX_WIDTH = 100;
export const MAX_PRECISION = 10;

const DEFAULT_FILL = " ";

// [[fill]align][width][.precision]; the width has no leading zero, use a fill
// such as `0>3` for zero padding.
const ALIGN_WIDTH_PRECISION = /^(?:(.)?([<>^]))?([1-9]\d*)?(?:\.(\d+))?$/su;

/**
 * Parses `[[fill]align][width][.precision]`. `defaultAlign` applies when the
 * spec has no explicit alignment (numbers right-align, text left-aligns).
 */
export function parseAlignWidthPrecision(
  spec: string,
  defaultAlign: Align,
): SpecResult<ParsedSpec> {
  const match = ALIGN_WIDTH_PRECISION.exec(spec);
  if (match === null) {
    return specError(`Invalid format spec "${spec}"`);
  }
  const [, fill, align, widthText, precisionText] = match;
  const width = widthText === undefined ? 0 : Number(widthText);
  const precision = precisionText === undefined ? null : Number(precisionText);
  if (width > MAX_WIDTH) {
    return specError(`Width ${width} exceeds the maximum of ${MAX_WIDTH}`);
  }
  if (precision !== null && precision > MAX_PRECISION) {
    return specError(`Precision ${precision} exceeds the maximum of ${MAX_PRECISION}`);
  }
  return specOk({
    pad: {
      fill: fill ?? DEFAULT_FILL,
      align: (align as Align | undefined) ?? defaultAlign,
      width,
    },
    precision,
  });
}

/** Pads `text` to the spec width; text longer than the width is kept whole. */
export function applyPad(text: string, pad: PadSpec): string {
  const missing = pad.width - [...text].length;
  if (missing <= 0) {
    return text;
  }
  switch (pad.align) {
    case "<":
      return text + pad.fill.repeat(missing);
    case ">":
      return pad.fill.repeat(missing) + text;
    case "^": {
      const left = Math.floor(missing / 2);
      return pad.fill.repeat(left) + text + pad.fill.repeat(missing - left);
    }
  }
}

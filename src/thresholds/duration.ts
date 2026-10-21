import { specError, specOk, type SpecResult } from "../format/errors";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const UNIT_MS: Readonly<Record<string, number>> = {
  s: SECOND_MS,
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)([smhd])$/;

/** Parses a duration such as `90m`, `3d` or `1.5h` into milliseconds. */
export function parseDuration(text: string): SpecResult<number> {
  const match = DURATION_PATTERN.exec(text.trim());
  if (match === null) {
    return specError(
      `Invalid duration "${text}"; expected a number and a unit s, m, h or d, such as 90m or 3d`,
    );
  }
  const [, amount = "", unit = ""] = match;
  const milliseconds = Number(amount) * (UNIT_MS[unit] ?? Number.NaN);
  return Number.isFinite(milliseconds)
    ? specOk(milliseconds)
    : specError(`Duration "${text}" is too large`);
}

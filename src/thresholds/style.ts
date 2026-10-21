import { specError, specOk, type SpecResult } from "../format/errors";

export const BACKGROUNDS = ["warning", "error"] as const;

export type ThresholdBackground = (typeof BACKGROUNDS)[number];

/** What a matching step paints: a foreground and optionally a background. */
export interface ThresholdStyle {
  /** A theme color ID such as `charts.red`, or `#rrggbb`. */
  readonly color: string;
  /** VS Code only allows the warning and error status bar backgrounds. */
  readonly background?: ThresholdBackground;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** Dotted `\w` segments, like the color ID pattern of VS Code's `colors` contribution point. */
const THEME_COLOR_ID = /^\w+(?:\.\w+)*$/;

/** Accepts a theme color ID or `#rrggbb`. */
export function parseColor(value: unknown): SpecResult<string> {
  if (typeof value !== "string" || (!HEX_COLOR.test(value) && !THEME_COLOR_ID.test(value))) {
    return specError(
      `Invalid color ${JSON.stringify(value)}; expected a theme color ID such as charts.red or #rrggbb`,
    );
  }
  return specOk(value);
}

export function parseBackground(value: unknown): SpecResult<ThresholdBackground> {
  const background = BACKGROUNDS.find((candidate) => candidate === value);
  return background === undefined
    ? specError(`Invalid background ${JSON.stringify(value)}; expected "warning" or "error"`)
    : specOk(background);
}

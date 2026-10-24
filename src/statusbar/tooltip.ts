import { formatRelative } from "../format/timeSpec";
import type { QuotaSnapshot } from "../model";

export interface TooltipInput {
  readonly name: string;
  /** Label of the registered source; `null` when none is connected. */
  readonly sourceLabel: string | null;
  readonly snapshot: QuotaSnapshot | null;
  /** Non-sensitive error code of the last failed fetch. */
  readonly errorCode: string | null;
  /** Credit of the announced-reset provider; `null` when the format shows none. */
  readonly attribution: string | null;
  readonly nowMs: number;
}

const NO_SOURCE = "no source";

/** What the user can do about an error code; the extension never refreshes the token itself. */
const ERROR_HINTS: Readonly<Record<string, string>> = {
  auth_expired: "Run Claude Code to refresh the token.",
};

/** The minimal tooltip: provider and source, last update, stale or error code, attribution. */
export function buildTooltip(input: TooltipInput): string {
  const lines = [`${input.name} · ${input.sourceLabel ?? NO_SOURCE}`, lastUpdate(input)];
  const status = statusLine(input);
  if (status !== null) {
    lines.push(status);
  }
  const hint = input.errorCode === null ? undefined : ERROR_HINTS[input.errorCode];
  if (hint !== undefined) {
    lines.push(hint);
  }
  if (input.attribution !== null) {
    lines.push(input.attribution);
  }
  return lines.join("\n");
}

function lastUpdate({ snapshot, nowMs }: TooltipInput): string {
  const fetchedAt = snapshot?.fetchedAt ?? null;
  return fetchedAt === null
    ? "Last update: never"
    : `Last update: ${formatRelative(nowMs - fetchedAt)} ago`;
}

function statusLine({ snapshot, errorCode }: TooltipInput): string | null {
  const stale = snapshot?.stale === true;
  if (stale) {
    return errorCode === null ? "Stale" : `Stale: ${errorCode}`;
  }
  return errorCode === null ? null : `Error: ${errorCode}`;
}

/** The tooltip of a provider whose configuration is unusable. */
export function buildErrorTooltip(name: string, problems: readonly string[]): string {
  return [`${name}: invalid configuration`, ...problems.map((problem) => `• ${problem}`)].join("\n");
}

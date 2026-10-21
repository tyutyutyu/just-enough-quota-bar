import { specError, specOk, type SpecResult } from "./errors";

export type StrftimeDirective = "a" | "d" | "H" | "M" | "b" | "m" | "Y";

export type StrftimePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "directive"; readonly code: StrftimeDirective };

export type TimeSpec =
  | { readonly style: "rel" }
  | { readonly style: "iso" }
  | { readonly style: "strftime"; readonly parts: readonly StrftimePart[] };

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

const WEEKDAYS = "SunMonTueWedThuFriSat";
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";
const ABBREVIATION_LENGTH = 3;

const DIRECTIVES: ReadonlySet<string> = new Set(["a", "d", "H", "M", "b", "m", "Y"]);

/** Parses `rel` (also the empty spec), `iso` or a strftime-subset pattern. */
export function parseTimeSpec(spec: string): SpecResult<TimeSpec> {
  if (spec === "" || spec === "rel") {
    return specOk({ style: "rel" });
  }
  if (spec === "iso") {
    return specOk({ style: "iso" });
  }
  if (!spec.includes("%")) {
    return specError(
      `Invalid format spec "${spec}"; expected rel, iso or a pattern such as %a %H:%M for times`,
    );
  }
  return parseStrftime(spec);
}

function parseStrftime(pattern: string): SpecResult<TimeSpec> {
  const parts: StrftimePart[] = [];
  let text = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern.charAt(i);
    if (char !== "%") {
      text += char;
      continue;
    }
    const code = pattern.charAt(i + 1);
    if (code === "%") {
      text += "%";
    } else if (isDirective(code)) {
      if (text !== "") {
        parts.push({ type: "text", text });
        text = "";
      }
      parts.push({ type: "directive", code });
    } else {
      const shown = code === "" ? "%" : `%${code}`;
      return specError(`Unsupported time directive "${shown}"; supported: %a %d %H %M %b %m %Y %%`);
    }
    i += 1;
  }
  if (text !== "") {
    parts.push({ type: "text", text });
  }
  return specOk({ style: "strftime", parts });
}

function isDirective(code: string): code is StrftimeDirective {
  return DIRECTIVES.has(code);
}

/** Formats `timeMs` for `spec`; `nowMs` is the reference of the relative style. */
export function formatTime(timeMs: number, nowMs: number, spec: TimeSpec): string {
  switch (spec.style) {
    case "rel":
      return formatRelative(timeMs - nowMs);
    case "iso":
      return new Date(timeMs).toISOString().replace(".000Z", "Z");
    case "strftime":
      return formatStrftime(new Date(timeMs), spec.parts);
  }
}

/**
 * The two largest non-zero units of the remaining time (`2d3h`, `1h12m`).
 * Elapsed time, not calendar time, so a DST change does not shift the result;
 * a reset in the past counts as `0m`.
 */
export function formatRelative(remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(remainingMs / MINUTE_MS));
  const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
  const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function formatStrftime(date: Date, parts: readonly StrftimePart[]): string {
  return parts
    .map((part) => (part.type === "text" ? part.text : formatDirective(date, part.code)))
    .join("");
}

function formatDirective(date: Date, code: StrftimeDirective): string {
  switch (code) {
    case "a":
      return abbreviation(WEEKDAYS, date.getDay());
    case "b":
      return abbreviation(MONTHS, date.getMonth());
    case "d":
      return twoDigits(date.getDate());
    case "H":
      return twoDigits(date.getHours());
    case "M":
      return twoDigits(date.getMinutes());
    case "m":
      return twoDigits(date.getMonth() + 1);
    case "Y":
      return String(date.getFullYear()).padStart(4, "0");
  }
}

function abbreviation(names: string, index: number): string {
  const start = index * ABBREVIATION_LENGTH;
  return names.slice(start, start + ABBREVIATION_LENGTH);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

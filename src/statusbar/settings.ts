import { PROVIDER_IDS, qualify, type ProviderId } from "../constants";

/** Reads one `jeqb.*` setting by its name without the prefix; `undefined` when unset. */
export type SettingReader = (name: string) => unknown;

export type Alignment = "left" | "right";

/** The third-party trackers an announced reset can come from; `off` fetches nothing. */
export type AnnouncedSourceId = "whenreset" | "codexReset";
export type AnnouncedSourceSetting = AnnouncedSourceId | "off";

/** The values `jeqb.<provider>.announcedSource` accepts: codex-reset.com only covers Codex. */
export const ANNOUNCED_SOURCE_CHOICES: Readonly<Record<ProviderId, readonly AnnouncedSourceSetting[]>> =
  {
    claude: ["whenreset", "off"],
    codex: ["whenreset", "codexReset", "off"],
  };

/** Settings every provider shares. */
export interface SharedSettings {
  readonly alignment: Alignment;
  readonly missingValue: string;
  readonly staleColor: string;
  /** Show the tracker's estimate as `announced.next` when nothing is announced. */
  readonly includeEstimates: boolean;
  /** The raw `jeqb.thresholds`; `parseThresholds` validates it. */
  readonly thresholds: unknown;
  /** Settings that hold a value of the wrong type; those fall back to their default. */
  readonly errors: readonly string[];
}

export interface ProviderSettings {
  readonly enabled: boolean;
  readonly format: string;
  readonly priority: number;
  readonly announcedSource: AnnouncedSourceSetting;
  /** The raw `jeqb.<provider>.thresholds`. */
  readonly thresholds: unknown;
  readonly errors: readonly string[];
}

export interface Settings {
  readonly shared: SharedSettings;
  readonly providers: Readonly<Record<ProviderId, ProviderSettings>>;
}

/** Fallbacks for values of the wrong type; the same defaults are declared in `package.json`. */
export const DEFAULT_ALIGNMENT: Alignment = "right";
export const DEFAULT_MISSING_VALUE = "–";
export const DEFAULT_STALE_COLOR = "disabledForeground";
export const DEFAULT_ANNOUNCED_SOURCE: AnnouncedSourceSetting = "whenreset";
export const DEFAULT_INCLUDE_ESTIMATES = false;

export const DEFAULT_FORMATS: Readonly<Record<ProviderId, string>> = {
  claude: "C {5h.pct}% {5h.reset:rel} · W {week.pct}%",
  codex: "X {5h.pct}% {5h.reset:rel} · W {week.pct}%",
};

/** Far apart so that the items of one group never reach the next one. */
export const DEFAULT_PRIORITIES: Readonly<Record<ProviderId, number>> = {
  claude: 200,
  codex: 100,
};

type Guard<T> = (value: unknown) => value is T;

const isBoolean: Guard<boolean> = (value): value is boolean => typeof value === "boolean";
const isString: Guard<string> = (value): value is string => typeof value === "string";
const isInteger: Guard<number> = (value): value is number => Number.isSafeInteger(value);
const isAlignment: Guard<Alignment> = (value): value is Alignment =>
  value === "left" || value === "right";
const isAnnouncedSourceOf =
  (provider: ProviderId): Guard<AnnouncedSourceSetting> =>
  (value): value is AnnouncedSourceSetting =>
    ANNOUNCED_SOURCE_CHOICES[provider].some((choice) => choice === value);

/** The setting value when it has the expected type, otherwise the fallback and a message. */
function pick<T>(
  read: SettingReader,
  name: string,
  guard: Guard<T>,
  fallback: T,
  errors: string[],
): T {
  const value = read(name);
  if (value === undefined || value === null) {
    return fallback;
  }
  if (guard(value)) {
    return value;
  }
  errors.push(`${qualify(name)} has an invalid value; using ${JSON.stringify(fallback)}`);
  return fallback;
}

export function readSettings(read: SettingReader): Settings {
  const sharedErrors: string[] = [];
  const shared: SharedSettings = {
    alignment: pick(read, "alignment", isAlignment, DEFAULT_ALIGNMENT, sharedErrors),
    missingValue: pick(read, "missingValue", isString, DEFAULT_MISSING_VALUE, sharedErrors),
    staleColor: pick(read, "staleColor", isString, DEFAULT_STALE_COLOR, sharedErrors),
    includeEstimates: pick(
      read,
      "announced.includeEstimates",
      isBoolean,
      DEFAULT_INCLUDE_ESTIMATES,
      sharedErrors,
    ),
    thresholds: read("thresholds"),
    errors: sharedErrors,
  };
  const providers = Object.fromEntries(
    PROVIDER_IDS.map((provider) => [provider, readProvider(read, provider)]),
  ) as Record<ProviderId, ProviderSettings>;
  return { shared, providers };
}

function readProvider(read: SettingReader, provider: ProviderId): ProviderSettings {
  const errors: string[] = [];
  return {
    enabled: pick(read, `${provider}.enabled`, isBoolean, true, errors),
    format: pick(read, `${provider}.format`, isString, DEFAULT_FORMATS[provider], errors),
    priority: pick(read, `${provider}.priority`, isInteger, DEFAULT_PRIORITIES[provider], errors),
    announcedSource: pick(
      read,
      `${provider}.announcedSource`,
      isAnnouncedSourceOf(provider),
      DEFAULT_ANNOUNCED_SOURCE,
      errors,
    ),
    thresholds: read(`${provider}.thresholds`),
    errors,
  };
}

import { PROVIDER_NAMES, qualify, type ProviderId } from "../constants";
import { parseFormat, type Token } from "../format/parser";
import { render, type Segment } from "../format/render";
import type { QuotaSnapshot } from "../model";
import { colorFor, type ColorContext } from "../thresholds/evaluate";
import {
  mergeThresholds,
  parseThresholds,
  type ParsedThresholds,
  type ThresholdMap,
} from "../thresholds/parse";
import { parseColor, type ThresholdBackground, type ThresholdStyle } from "../thresholds/style";
import { applyElapsedResets } from "./elapsed";
import type { Alignment, ProviderSettings, Settings } from "./settings";
import { buildErrorTooltip, buildTooltip } from "./tooltip";

/** What one `StatusBarItem` must show. */
export interface ItemSpec {
  readonly text: string;
  readonly tooltip: string;
  /** Theme color ID or `#rrggbb`; `null` keeps the default foreground. */
  readonly color: string | null;
  readonly background: ThresholdBackground | null;
  readonly alignment: Alignment;
  readonly priority: number;
}

export interface SourceInfo {
  readonly label: string;
  readonly announcedAttribution: string | null;
}

export interface LayoutInput {
  readonly provider: ProviderId;
  readonly settings: Settings;
  /** `null` while no source is registered for the provider. */
  readonly source: SourceInfo | null;
  /** The cache entry of the provider's source, if any. */
  readonly snapshot: QuotaSnapshot | null;
  readonly errorCode: string | null;
  readonly nowMs: number;
}

const ERROR_TEXT_ICON = "$(warning)";

/**
 * The items of one provider, in display order. A valid configuration gives one
 * item per colored variable and one per run of the text between them; an
 * invalid one gives a single error item that explains the problem.
 */
export function layoutProvider(input: LayoutInput): readonly ItemSpec[] {
  const { provider, settings } = input;
  const providerSettings = settings.providers[provider];
  const name = PROVIDER_NAMES[provider];
  const alignment = settings.shared.alignment;

  const parsedFormat = parseFormat(providerSettings.format);
  const thresholds = resolveThresholds(provider, settings);
  const staleColor = parseColor(settings.shared.staleColor);
  const problems = [
    ...settings.shared.errors,
    ...providerSettings.errors,
    ...(parsedFormat.ok
      ? []
      : parsedFormat.errors.map(
          (error) => `${qualify(`${provider}.format`)}, position ${error.position}: ${error.message}`,
        )),
    ...thresholds.errors,
    ...(staleColor.ok ? [] : [`${qualify("staleColor")}: ${staleColor.message}`]),
  ];

  if (!parsedFormat.ok || !staleColor.ok || problems.length > 0) {
    return [errorItem(name, problems, alignment, providerSettings)];
  }

  const snapshot = applyElapsedResets(input.snapshot ?? { name }, input.nowMs);
  const context: ColorContext = {
    nowMs: input.nowMs,
    stale: snapshot.stale === true,
    staleColor: staleColor.spec,
  };
  const segments = render(parsedFormat.tokens, snapshot, input.nowMs, settings.shared.missingValue);
  const tooltip = buildTooltip({
    name,
    sourceLabel: input.source?.label ?? null,
    snapshot: input.snapshot === null ? null : snapshot,
    errorCode: input.errorCode,
    attribution: usesAnnounced(parsedFormat.tokens) ? (input.source?.announcedAttribution ?? null) : null,
    nowMs: input.nowMs,
  });

  return groupSegments(segments, (segment) =>
    colorFor(segment.variable, snapshot, thresholds.thresholds, context),
  ).map((group, index) => ({
    text: group.text,
    tooltip,
    color: group.style?.color ?? null,
    background: group.style?.background ?? null,
    alignment,
    priority: providerSettings.priority - index,
  }));
}

interface ThresholdResolution {
  readonly thresholds: ThresholdMap;
  readonly errors: readonly string[];
}

function resolveThresholds(provider: ProviderId, settings: Settings): ThresholdResolution {
  const global = parseThresholds(settings.shared.thresholds);
  const own = parseThresholds(settings.providers[provider].thresholds);
  return {
    thresholds: mergeThresholds(global.thresholds, own.thresholds),
    errors: [
      ...describeThresholdErrors(qualify("thresholds"), global),
      ...describeThresholdErrors(qualify(`${provider}.thresholds`), own),
    ],
  };
}

function describeThresholdErrors(setting: string, parsed: ParsedThresholds): readonly string[] {
  return parsed.errors.map((error) => {
    const key = error.variable === "" ? "" : ` "${error.variable}"`;
    const step = error.index === null ? "" : ` step ${error.index + 1}`;
    return `${setting}${key}${step}: ${error.message}`;
  });
}

function errorItem(
  name: string,
  problems: readonly string[],
  alignment: Alignment,
  settings: ProviderSettings,
): ItemSpec {
  return {
    text: `${ERROR_TEXT_ICON} ${name}`,
    tooltip: buildErrorTooltip(name, problems),
    color: null,
    background: "error",
    alignment,
    priority: settings.priority,
  };
}

function usesAnnounced(tokens: readonly Token[]): boolean {
  return tokens.some((token) => token.type === "field" && token.variable.startsWith("announced."));
}

interface Group {
  readonly text: string;
  readonly style: ThresholdStyle | null;
}

/**
 * A colored variable is a group of its own; the literals and uncolored
 * variables between two of them are joined into one neutral group.
 */
function groupSegments(
  segments: readonly Segment[],
  styleOf: (segment: Extract<Segment, { type: "variable" }>) => ThresholdStyle | null,
): readonly Group[] {
  const groups: Group[] = [];
  for (const segment of segments) {
    const style = segment.type === "variable" ? styleOf(segment) : null;
    const previous = groups.at(-1);
    if (style === null && previous !== undefined && previous.style === null) {
      groups[groups.length - 1] = { text: previous.text + segment.text, style: null };
    } else {
      groups.push({ text: segment.text, style });
    }
  }
  return groups;
}

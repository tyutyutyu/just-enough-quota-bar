import type { Fetcher, SourceDefinition } from "../cache/sharedCache";
import type { ProviderId } from "../constants";

/** A quota source that feeds one provider's status bar group. */
export interface QuotaSource {
  readonly provider: ProviderId;
  /** Shown in the tooltip, e.g. `OAuth usage` or `app-server`. */
  readonly label: string;
  /** Cache key, automatic interval and timeout of the source. */
  readonly definition: SourceDefinition;
  /** Shortest time between two fetches, which a click on the status bar also respects. */
  readonly minIntervalMs: number;
  readonly fetch: Fetcher;
  /** Visible credit of the announced-reset provider, e.g. `Data: codex-reset.com`. */
  readonly announcedAttribution?: string;
}

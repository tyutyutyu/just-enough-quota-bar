import type { Fetcher, SourceDefinition } from "../cache/sharedCache";
import type { ProviderId } from "../constants";
import type { AnnouncedSourceId } from "./settings";

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
}

/** The visible credit of a data source, linked to its site. */
export interface Attribution {
  /** E.g. `Data: codex-reset.com`. */
  readonly text: string;
  readonly url: string;
}

/**
 * The common interface of the announced-reset providers: a third-party tracker
 * that fills the `announced.*` variables of one provider. It has a cache entry
 * of its own, so its failure leaves every other variable working.
 */
export interface AnnouncedSource {
  readonly provider: ProviderId;
  /** The value of `jeqb.<provider>.announcedSource` that selects this source. */
  readonly sourceId: AnnouncedSourceId;
  /** Shown in the tooltip whenever the format uses an `announced.*` variable. */
  readonly attribution: Attribution;
  readonly definition: SourceDefinition;
  readonly minIntervalMs: number;
  /** Answers a snapshot whose only data is its `announced` block. */
  readonly fetch: Fetcher;
}

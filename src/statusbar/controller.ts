import type { CacheEntry, CacheFile } from "../cache/entry";
import type { Fetcher, RefreshOutcome, SourceDefinition } from "../cache/sharedCache";
import type { Disposable, WatchOptions } from "../cache/watcher";
import { PROVIDER_IDS, type ProviderId } from "../constants";
import { formatUsesAnnounced, layoutProvider, type AnnouncedInput, type ItemSpec } from "./layout";
import type { AnnouncedSource, QuotaSource } from "./source";
import type { Settings } from "./settings";

/** Relative times are redrawn this often; the redraw never touches the network. */
export const REDRAW_INTERVAL_MS = 30_000;

/** How often the sources are checked for being due; the cache decides whether a fetch happens. */
export const DUE_CHECK_INTERVAL_MS = 60_000;

/** The part of `SharedCache` the controller uses. */
export interface CacheAccess {
  read(): Promise<CacheFile>;
  refresh(source: SourceDefinition, fetcher: Fetcher): Promise<RefreshOutcome>;
  watch(onChange: (file: CacheFile) => void, options?: WatchOptions): Promise<Disposable>;
}

/** Shows the items of a provider; an empty list removes the provider's group. */
export interface StatusBarSink {
  update(provider: ProviderId, items: readonly ItemSpec[]): void;
  dispose(): void;
}

export interface ControllerDependencies {
  readonly cache: CacheAccess;
  readonly sink: StatusBarSink;
  readonly readSettings: () => Settings;
  readonly onError: (error: unknown) => void;
  readonly now?: () => number;
}

export type RefreshOutcomes = Partial<Record<ProviderId, RefreshOutcome>>;

const EMPTY_FILE: CacheFile = { version: 0, entries: {} };

/** What a fetch needs of a quota or an announced-reset source. */
type Fetchable = Pick<QuotaSource | AnnouncedSource, "definition" | "minIntervalMs" | "fetch">;

/**
 * Connects the registered quota sources, the shared cache, the settings and
 * the status bar: it redraws on every change and on a 30 second timer, and
 * fetches through the cache so its interval, backoff and lock rules apply.
 */
export class QuotaController {
  private readonly sources = new Map<ProviderId, QuotaSource>();
  private readonly announcedSources = new Set<AnnouncedSource>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;
  private file: CacheFile = EMPTY_FILE;
  private watcher: Disposable | null = null;
  private disposed = false;

  constructor(private readonly deps: ControllerDependencies) {
    this.now = deps.now ?? Date.now;
  }

  /** Reads the cache, follows other windows' changes and starts the timers. */
  async start(): Promise<void> {
    await this.reload();
    const watcher = await this.deps.cache.watch((file) => this.accept(file), {
      onError: this.deps.onError,
    });
    if (this.disposed) {
      watcher.dispose();
      return;
    }
    this.watcher = watcher;
    this.timers.push(
      setInterval(() => this.render(), REDRAW_INTERVAL_MS),
      setInterval(() => void this.refreshDue(), DUE_CHECK_INTERVAL_MS),
    );
  }

  /** Connects a source to its provider, replacing the previous one, and fetches it when due. */
  registerSource(source: QuotaSource): Disposable {
    this.sources.set(source.provider, source);
    this.render();
    void this.refreshDue();
    return {
      dispose: () => {
        if (this.sources.get(source.provider) === source) {
          this.sources.delete(source.provider);
          this.render();
        }
      },
    };
  }

  /**
   * Adds an announced-reset source. It is fetched and shown only while
   * `jeqb.<provider>.announcedSource` selects it and the format uses an
   * `announced.*` variable; of two sources with the same choice, the newer one.
   */
  registerAnnouncedSource(source: AnnouncedSource): Disposable {
    this.announcedSources.add(source);
    this.render();
    void this.refreshDue();
    return {
      dispose: () => {
        if (this.announcedSources.delete(source)) {
          this.render();
        }
      },
    };
  }

  /** Redraws from the cached data; the settings are read again, so changes apply at once. */
  render(): void {
    if (this.disposed) {
      return;
    }
    try {
      const settings = this.deps.readSettings();
      const nowMs = this.now();
      for (const provider of PROVIDER_IDS) {
        this.deps.sink.update(
          provider,
          settings.providers[provider].enabled ? this.layout(provider, settings, nowMs) : [],
        );
      }
    } catch (error) {
      this.deps.onError(error);
    }
  }

  /**
   * Asks the sources for fresh data now: all of them, or just `provider`'s.
   * The cache still applies the source's minimum interval, its backoff and the lock.
   */
  async refresh(provider?: ProviderId): Promise<RefreshOutcomes> {
    return this.fetchSources(provider, (source) => ({
      ...source.definition,
      intervalMs: source.minIntervalMs,
    }));
  }

  dispose(): void {
    this.disposed = true;
    this.timers.forEach((timer) => clearInterval(timer));
    this.timers.length = 0;
    this.watcher?.dispose();
    this.watcher = null;
    this.deps.sink.dispose();
  }

  private async refreshDue(): Promise<void> {
    await this.fetchSources(undefined, (source) => source.definition);
  }

  private async fetchSources(
    only: ProviderId | undefined,
    definitionOf: (source: Fetchable) => SourceDefinition,
  ): Promise<RefreshOutcomes> {
    const settings = this.deps.readSettings();
    const wanted = (provider: ProviderId): boolean =>
      (only === undefined || provider === only) && settings.providers[provider].enabled;
    const quotaTargets = [...this.sources.values()].filter((source) => wanted(source.provider));
    const announcedTargets = PROVIDER_IDS.filter(wanted).flatMap((provider) => {
      const source = this.selectedAnnounced(provider, settings);
      return source === null ? [] : [source];
    });
    const outcomes: RefreshOutcomes = {};
    await Promise.all([
      ...quotaTargets.map(async (source) => {
        const outcome = await this.fetchOne(source, definitionOf);
        if (outcome !== null) {
          outcomes[source.provider] = outcome;
        }
      }),
      ...announcedTargets.map((source) => this.fetchOne(source, definitionOf)),
    ]);
    await this.reload();
    return outcomes;
  }

  private async fetchOne(
    source: Fetchable,
    definitionOf: (source: Fetchable) => SourceDefinition,
  ): Promise<RefreshOutcome | null> {
    try {
      return await this.deps.cache.refresh(definitionOf(source), source.fetch);
    } catch (error) {
      this.deps.onError(error);
      return null;
    }
  }

  /** The announced-reset source the settings select for `provider`, if its format shows one. */
  private selectedAnnounced(provider: ProviderId, settings: Settings): AnnouncedSource | null {
    const { announcedSource, format } = settings.providers[provider];
    if (announcedSource === "off" || !formatUsesAnnounced(format)) {
      return null;
    }
    // The newest registration wins, like a replaced quota source.
    let selected: AnnouncedSource | null = null;
    for (const source of this.announcedSources) {
      if (source.provider === provider && source.sourceId === announcedSource) {
        selected = source;
      }
    }
    return selected;
  }

  private announcedInput(provider: ProviderId, settings: Settings): AnnouncedInput | null {
    const source = this.selectedAnnounced(provider, settings);
    if (source === null) {
      return null;
    }
    const entry = this.file.entries[source.definition.id];
    const usable = entry !== undefined && entry.error === null;
    return {
      attribution: source.attribution,
      values: usable ? (entry.snapshot?.announced ?? null) : null,
    };
  }

  private async reload(): Promise<void> {
    try {
      this.accept(await this.deps.cache.read());
    } catch (error) {
      this.deps.onError(error);
    }
  }

  private accept(file: CacheFile): void {
    this.file = file;
    this.render();
  }

  private layout(provider: ProviderId, settings: Settings, nowMs: number): readonly ItemSpec[] {
    const source = this.sources.get(provider);
    const entry: CacheEntry | undefined =
      source === undefined ? undefined : this.file.entries[source.definition.id];
    const snapshot = entry?.snapshot ?? null;
    return layoutProvider({
      provider,
      settings,
      source: source === undefined ? null : { label: source.label },
      snapshot,
      errorCode: snapshot?.error ?? entry?.error ?? null,
      announced: this.announcedInput(provider, settings),
      nowMs,
    });
  }
}

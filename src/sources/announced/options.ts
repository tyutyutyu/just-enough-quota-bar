/** What every announced-reset provider needs from its environment. */
export interface AnnouncedProviderOptions {
  readonly fetchImpl: typeof fetch;
  /** Identifies the extension and its project URL to the tracker. */
  readonly userAgent: string;
  readonly now: () => number;
  /** Writes one line to the extension's log; never given response content. */
  readonly log: (line: string) => void;
}

import type { AnnouncedSource } from "../../statusbar/source";
import { createCodexResetSource } from "./codexReset";
import { announcedUserAgent } from "./http";
import type { AnnouncedProviderOptions } from "./options";
import { createWhenresetLatestLoader, createWhenresetSource } from "./whenreset";

export interface AnnouncedSourcesOptions {
  /** The extension version, sent in the `User-Agent`. */
  readonly version?: string;
  readonly log: (line: string) => void;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Every announced-reset source the settings can choose: whenreset.app for
 * both providers, codex-reset.com for Codex only.
 */
export function createAnnouncedSources(options: AnnouncedSourcesOptions): readonly AnnouncedSource[] {
  const providerOptions: AnnouncedProviderOptions = {
    fetchImpl: options.fetchImpl ?? fetch,
    userAgent: announcedUserAgent(options.version),
    now: options.now ?? Date.now,
    log: options.log,
  };
  // Both products read the same latest.json, so a refresh of both requests it once.
  const loadLatest = createWhenresetLatestLoader(providerOptions);
  return [
    createWhenresetSource("claude", providerOptions, loadLatest),
    createWhenresetSource("codex", providerOptions, loadLatest),
    createCodexResetSource(providerOptions),
  ];
}

import type { SourceDefinition } from "../cache/sharedCache";
import type { QuotaSource } from "../statusbar/source";
import { resolveCodexBinary } from "./codexBinary";
import { createCodexAppServerSource, type CodexAppServerSourceOptions } from "./codex";
import { createCodexProbeSource, type CodexProbeSourceOptions } from "./codexProbe";

export const CODEX_SOURCE_MODES = ["auto", "appServer", "probe"] as const;
export type CodexSourceMode = (typeof CODEX_SOURCE_MODES)[number];

/** The mode that actually runs; `auto` has resolved to one of the two. */
type ActiveMode = Exclude<CodexSourceMode, "auto">;

export const DEFAULT_CODEX_SOURCE_MODE: CodexSourceMode = "auto";

/** An unknown value of `jeqb.codex.source` falls back to `auto`. */
export function toCodexSourceMode(value: unknown): CodexSourceMode {
  return CODEX_SOURCE_MODES.find((mode) => mode === value) ?? DEFAULT_CODEX_SOURCE_MODE;
}

export interface CodexSourceOptions {
  /** The current `jeqb.codex.source`; read at every fetch. */
  readonly readSourceMode?: () => unknown;
  readonly appServer?: CodexAppServerSourceOptions;
  readonly probe?: CodexProbeSourceOptions;
}

/**
 * The Codex source of `jeqb.codex.source`. `appServer` and `probe` force their
 * source; `auto` runs the app-server when the `codex` binary is found and the
 * probe otherwise. The binary is looked up at every fetch, so installing it
 * applies at once, and a failing app-server never falls back to the probe,
 * which uses quota.
 *
 * The interval and the label follow the source that ran last. Until `auto`
 * has chosen, the probe's longer interval applies, so quota is never used
 * faster than the probe allows.
 */
export function createCodexSource(options: CodexSourceOptions = {}): QuotaSource {
  const appServer = createCodexAppServerSource(options.appServer);
  const probe = createCodexProbeSource(options.probe);
  let lastAutoChoice: ActiveMode = "probe";

  const configuredMode = (): CodexSourceMode => toCodexSourceMode(options.readSourceMode?.());
  const activeMode = (): ActiveMode => {
    const mode = configuredMode();
    return mode === "auto" ? lastAutoChoice : mode;
  };
  const activeSource = (): QuotaSource => (activeMode() === "appServer" ? appServer : probe);

  const chooseForFetch = async (): Promise<ActiveMode> => {
    const mode = configuredMode();
    if (mode !== "auto") {
      return mode;
    }
    const binary = await resolveCodexBinary(
      options.appServer?.readBinaryPath?.(),
      options.appServer?.binaryEnvironment,
    );
    lastAutoChoice = binary === null ? "probe" : "appServer";
    return lastAutoChoice;
  };

  return {
    provider: "codex",
    get label(): string {
      return activeSource().label;
    },
    get definition(): SourceDefinition {
      const definition = activeSource().definition;
      // `auto` may switch source at the next fetch, so it waits for the slower one.
      return configuredMode() === "auto"
        ? {
            ...definition,
            timeoutMs: Math.max(appServer.definition.timeoutMs, probe.definition.timeoutMs),
          }
        : definition;
    },
    get minIntervalMs(): number {
      return activeSource().minIntervalMs;
    },
    fetch: async (signal) => {
      const mode = await chooseForFetch();
      return (mode === "appServer" ? appServer : probe).fetch(signal);
    },
  };
}

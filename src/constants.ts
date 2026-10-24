/** Configuration and command namespace shared by every contribution point. */
export const PREFIX = "jeqb";

/** Builds a fully qualified identifier such as `jeqb.refresh`. */
export function qualify(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new Error("name must not be empty");
  }
  return `${PREFIX}.${trimmed}`;
}

export const COMMAND_REFRESH = qualify("refresh");

export const PROVIDER_IDS = ["claude", "codex"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  claude: "Claude",
  codex: "Codex",
};

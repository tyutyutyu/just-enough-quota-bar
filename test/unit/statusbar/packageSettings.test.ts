import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANNOUNCED_SOURCE_CHOICES,
  DEFAULT_ALIGNMENT,
  DEFAULT_ANNOUNCED_SOURCE,
  DEFAULT_FORMATS,
  DEFAULT_INCLUDE_ESTIMATES,
  DEFAULT_MISSING_VALUE,
  DEFAULT_PRIORITIES,
  DEFAULT_STALE_COLOR,
} from "../../../src/statusbar/settings";

interface Property {
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly description?: string;
  readonly markdownDescription?: string;
}

const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, Property> } };
};
const properties = manifest.contributes.configuration.properties;

describe("contributes.configuration", () => {
  it("declares every setting of the extension", () => {
    expect(Object.keys(properties).sort()).toEqual(
      [
        "jeqb.alignment",
        "jeqb.announced.includeEstimates",
        "jeqb.claude.announcedSource",
        "jeqb.claude.enabled",
        "jeqb.claude.format",
        "jeqb.claude.priority",
        "jeqb.claude.thresholds",
        "jeqb.codex.announcedSource",
        "jeqb.codex.binaryPath",
        "jeqb.codex.enabled",
        "jeqb.codex.format",
        "jeqb.codex.priority",
        "jeqb.codex.probeIntervalMinutes",
        "jeqb.codex.source",
        "jeqb.codex.thresholds",
        "jeqb.missingValue",
        "jeqb.staleColor",
        "jeqb.thresholds",
      ].sort(),
    );
  });

  it.each(Object.entries(properties))("%s has a description and a default", (_name, property) => {
    expect(property.markdownDescription ?? property.description ?? "").not.toBe("");
    expect(property).toHaveProperty("default");
  });

  it("matches the defaults the code falls back to", () => {
    expect(properties["jeqb.alignment"]?.default).toBe(DEFAULT_ALIGNMENT);
    expect(properties["jeqb.missingValue"]?.default).toBe(DEFAULT_MISSING_VALUE);
    expect(properties["jeqb.staleColor"]?.default).toBe(DEFAULT_STALE_COLOR);
    expect(properties["jeqb.announced.includeEstimates"]?.default).toBe(DEFAULT_INCLUDE_ESTIMATES);
    for (const provider of ["claude", "codex"] as const) {
      expect(properties[`jeqb.${provider}.enabled`]?.default).toBe(true);
      expect(properties[`jeqb.${provider}.format`]?.default).toBe(DEFAULT_FORMATS[provider]);
      expect(properties[`jeqb.${provider}.priority`]?.default).toBe(DEFAULT_PRIORITIES[provider]);
      expect(properties[`jeqb.${provider}.announcedSource`]?.default).toBe(DEFAULT_ANNOUNCED_SOURCE);
      expect(properties[`jeqb.${provider}.announcedSource`]?.enum).toEqual(ANNOUNCED_SOURCE_CHOICES[provider]);
    }
    expect(DEFAULT_ANNOUNCED_SOURCE).toBe("whenreset");
  });
});

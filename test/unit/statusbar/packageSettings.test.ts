import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALIGNMENT,
  DEFAULT_FORMATS,
  DEFAULT_MISSING_VALUE,
  DEFAULT_PRIORITIES,
  DEFAULT_STALE_COLOR,
} from "../../../src/statusbar/settings";

interface Property {
  readonly default?: unknown;
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
        "jeqb.claude.enabled",
        "jeqb.claude.format",
        "jeqb.claude.priority",
        "jeqb.claude.thresholds",
        "jeqb.codex.enabled",
        "jeqb.codex.format",
        "jeqb.codex.priority",
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
    for (const provider of ["claude", "codex"] as const) {
      expect(properties[`jeqb.${provider}.enabled`]?.default).toBe(true);
      expect(properties[`jeqb.${provider}.format`]?.default).toBe(DEFAULT_FORMATS[provider]);
      expect(properties[`jeqb.${provider}.priority`]?.default).toBe(DEFAULT_PRIORITIES[provider]);
    }
  });
});

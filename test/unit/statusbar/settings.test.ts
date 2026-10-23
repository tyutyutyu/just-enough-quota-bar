import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORMATS,
  DEFAULT_PRIORITIES,
  readSettings,
  type SettingReader,
} from "../../../src/statusbar/settings";

const readFrom =
  (values: Record<string, unknown>): SettingReader =>
  (name) =>
    values[name];

describe("readSettings", () => {
  it("uses the defaults when nothing is configured", () => {
    const settings = readSettings(readFrom({}));

    expect(settings.shared).toMatchObject({
      alignment: "right",
      missingValue: "–",
      staleColor: "disabledForeground",
      errors: [],
    });
    expect(settings.providers.claude).toMatchObject({
      enabled: true,
      format: DEFAULT_FORMATS.claude,
      priority: DEFAULT_PRIORITIES.claude,
      errors: [],
    });
    expect(settings.providers.codex.priority).toBe(DEFAULT_PRIORITIES.codex);
  });

  it("reads configured values", () => {
    const settings = readSettings(
      readFrom({
        alignment: "left",
        missingValue: "n/a",
        staleColor: "#112233",
        "codex.enabled": false,
        "codex.format": "{name}",
        "codex.priority": 7,
        thresholds: { "5h.pct": [] },
        "claude.thresholds": { "week.pct": [] },
      }),
    );

    expect(settings.shared).toMatchObject({ alignment: "left", missingValue: "n/a", staleColor: "#112233" });
    expect(settings.providers.codex).toMatchObject({ enabled: false, format: "{name}", priority: 7 });
    expect(settings.shared.thresholds).toEqual({ "5h.pct": [] });
    expect(settings.providers.claude.thresholds).toEqual({ "week.pct": [] });
  });

  it("falls back to the default and reports a value of the wrong type", () => {
    const settings = readSettings(
      readFrom({ alignment: "middle", "claude.priority": 1.5, "claude.enabled": "yes", "codex.format": 3 }),
    );

    expect(settings.shared.alignment).toBe("right");
    expect(settings.shared.errors).toEqual([expect.stringContaining("jeqb.alignment")]);
    expect(settings.providers.claude.priority).toBe(DEFAULT_PRIORITIES.claude);
    expect(settings.providers.claude.enabled).toBe(true);
    expect(settings.providers.claude.errors).toHaveLength(2);
    expect(settings.providers.codex.format).toBe(DEFAULT_FORMATS.codex);
    expect(settings.providers.codex.errors).toEqual([expect.stringContaining("jeqb.codex.format")]);
  });

  it("treats null like an unset value", () => {
    const settings = readSettings(readFrom({ "claude.format": null }));

    expect(settings.providers.claude.format).toBe(DEFAULT_FORMATS.claude);
    expect(settings.providers.claude.errors).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildErrorTooltip,
  buildTooltip,
  tooltipMarkdown,
  type TooltipInput,
} from "../../../src/statusbar/tooltip";

const NOW = 10_000_000;
const MINUTE = 60_000;

const base: TooltipInput = {
  name: "Claude",
  sourceLabel: "OAuth usage",
  snapshot: { name: "Claude", fetchedAt: NOW - 3 * MINUTE },
  errorCode: null,
  nowMs: NOW,
};

describe("buildTooltip", () => {
  it("shows only the provider, the source and the last successful update", () => {
    expect(buildTooltip(base)).toBe("Claude · OAuth usage\nLast update: 3m ago");
  });

  it("says so when there is no source or no update yet", () => {
    const text = buildTooltip({ ...base, sourceLabel: null, snapshot: null });

    expect(text).toBe("Claude · no source\nLast update: never");
  });

  it("shows the stale flag with the error code", () => {
    const text = buildTooltip({
      ...base,
      snapshot: { name: "Claude", fetchedAt: NOW - 90 * MINUTE, stale: true },
      errorCode: "upstream_429",
    });

    expect(text).toBe("Claude · OAuth usage\nLast update: 1h30m ago\nStale: upstream_429");
  });

  it("shows stale without a code when the data merely aged", () => {
    const text = buildTooltip({ ...base, snapshot: { name: "Claude", fetchedAt: NOW, stale: true } });

    expect(text.split("\n").at(-1)).toBe("Stale");
  });

  it("shows the error code when there is no data to be stale", () => {
    const text = buildTooltip({ ...base, snapshot: null, errorCode: "auth_missing" });

    expect(text).toBe("Claude · OAuth usage\nLast update: never\nError: auth_missing");
  });

  it("suggests running Claude Code when the token has expired", () => {
    const text = buildTooltip({
      ...base,
      snapshot: { name: "Claude", fetchedAt: NOW - 90 * MINUTE, stale: true },
      errorCode: "auth_expired",
    });

    expect(text).toBe(
      "Claude · OAuth usage\nLast update: 1h30m ago\nStale: auth_expired\nRun Claude Code to refresh the token.",
    );
  });

  it("suggests running Claude Code also when there is no data yet", () => {
    const text = buildTooltip({ ...base, snapshot: null, errorCode: "auth_expired" });

    expect(text.split("\n").slice(-2)).toEqual([
      "Error: auth_expired",
      "Run Claude Code to refresh the token.",
    ]);
  });

});

describe("tooltipMarkdown", () => {
  const credit = { text: "Data: codex-reset.com", url: "https://codex-reset.com/" };

  it("ends with the credit linked to the source", () => {
    const markdown = tooltipMarkdown("Codex · app-server\nLast update: 3m ago", credit);

    expect(markdown.split("  \n")).toEqual([
      "Codex · app\\-server",
      "Last update: 3m ago",
      "[Data: codex\\-reset\\.com](https://codex-reset.com/)",
    ]);
  });

  it("escapes the text so that an error code is not read as Markdown", () => {
    const markdown = tooltipMarkdown("Stale: upstream_429 [x](y) *z*", credit);

    expect(markdown.split("  \n")[0]).toBe("Stale: upstream\\_429 \\[x\\]\\(y\\) \\*z\\*");
  });
});

describe("buildErrorTooltip", () => {
  it("lists every problem", () => {
    expect(buildErrorTooltip("Codex", ["a", "b"])).toBe("Codex: invalid configuration\n• a\n• b");
  });
});

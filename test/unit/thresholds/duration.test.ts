import { describe, expect, it } from "vitest";
import { parseDuration } from "../../../src/thresholds/duration";

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000],
    ["90m", 5_400_000],
    ["2h", 7_200_000],
    ["3d", 259_200_000],
    ["1.5h", 5_400_000],
    [" 1d ", 86_400_000],
  ])("parses %s", (text, expected) => {
    expect(parseDuration(text)).toEqual({ ok: true, spec: expected });
  });

  it.each(["", "90", "m", "-1d", "1w", "1 d", "1e3m", "1d2h"])("rejects %j", (text) => {
    expect(parseDuration(text)).toMatchObject({ ok: false });
  });

  it("rejects a duration beyond the finite range", () => {
    expect(parseDuration(`${"9".repeat(400)}d`)).toMatchObject({
      ok: false,
      message: expect.stringContaining("too large"),
    });
  });
});

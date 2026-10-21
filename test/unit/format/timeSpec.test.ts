import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatRelative, formatTime, parseTimeSpec } from "../../../src/format/timeSpec";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function spec(text: string) {
  const parsed = parseTimeSpec(text);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return parsed.spec;
}

function format(timeMs: number, nowMs: number, text: string): string {
  return formatTime(timeMs, nowMs, spec(text));
}

describe("parseTimeSpec", () => {
  it("defaults to rel for an empty spec", () => {
    expect(parseTimeSpec("")).toEqual({ ok: true, spec: { style: "rel" } });
    expect(parseTimeSpec("rel")).toEqual({ ok: true, spec: { style: "rel" } });
  });

  it("parses iso", () => {
    expect(parseTimeSpec("iso")).toEqual({ ok: true, spec: { style: "iso" } });
  });

  it("parses a strftime pattern into text and directive parts", () => {
    expect(parseTimeSpec("%a %H:%M")).toEqual({
      ok: true,
      spec: {
        style: "strftime",
        parts: [
          { type: "directive", code: "a" },
          { type: "text", text: " " },
          { type: "directive", code: "H" },
          { type: "text", text: ":" },
          { type: "directive", code: "M" },
        ],
      },
    });
  });

  it("parses a literal percent sign", () => {
    expect(parseTimeSpec("%d%%")).toMatchObject({
      ok: true,
      spec: { parts: [{ type: "directive", code: "d" }, { type: "text", text: "%" }] },
    });
  });

  it("rejects text without a directive", () => {
    const result = parseTimeSpec("tomorrow");

    expect(!result.ok && result.message).toContain("expected rel, iso or a pattern");
  });

  it("rejects number specs", () => {
    expect(parseTimeSpec(">3").ok).toBe(false);
  });

  it.each([
    ["%Z", "%Z"],
    ["%H:%S", "%S"],
    ["%y", "%y"],
    ["100%", "%"],
  ])("rejects the unsupported directive in %j", (pattern, shown) => {
    const result = parseTimeSpec(pattern);

    expect(!result.ok && result.message).toContain(`Unsupported time directive "${shown}"`);
  });
});

describe("formatRelative", () => {
  it("shows minutes only below an hour", () => {
    expect(formatRelative(12 * MINUTE)).toBe("12m");
    expect(formatRelative(59 * MINUTE + 59_000)).toBe("59m");
  });

  it("shows hours and minutes, dropping a zero minute part", () => {
    expect(formatRelative(HOUR + 12 * MINUTE)).toBe("1h12m");
    expect(formatRelative(5 * HOUR)).toBe("5h");
  });

  it("shows the two largest units from a day up, dropping zero and smaller parts", () => {
    expect(formatRelative(2 * DAY + 3 * HOUR + 40 * MINUTE)).toBe("2d3h");
    expect(formatRelative(2 * DAY + 40 * MINUTE)).toBe("2d");
    expect(formatRelative(7 * DAY)).toBe("7d");
  });

  it("truncates seconds instead of rounding up", () => {
    expect(formatRelative(HOUR + 12 * MINUTE + 59_999)).toBe("1h12m");
    expect(formatRelative(59_999)).toBe("0m");
  });

  it("shows 0m when the time is now or in the past", () => {
    expect(formatRelative(0)).toBe("0m");
    expect(formatRelative(-3 * HOUR)).toBe("0m");
  });
});

describe("formatTime rel", () => {
  it("measures the remaining time from now", () => {
    const now = Date.UTC(2026, 9, 12, 10, 0);

    expect(format(now + 2 * DAY + 3 * HOUR, now, "rel")).toBe("2d3h");
    expect(format(now + HOUR + 12 * MINUTE, now, "")).toBe("1h12m");
  });

  it("shows 0m for a reset in the past", () => {
    const now = Date.UTC(2026, 9, 12, 10, 0);

    expect(format(now - DAY, now, "rel")).toBe("0m");
  });
});

describe("formatTime iso", () => {
  it("prints UTC without milliseconds", () => {
    expect(format(Date.UTC(2026, 9, 12, 20, 23), 0, "iso")).toBe("2026-10-12T20:23:00Z");
  });

  it("keeps non-zero milliseconds and drops only .000", () => {
    expect(format(Date.UTC(2026, 9, 12, 20, 23, 5, 678), 0, "iso")).toBe("2026-10-12T20:23:05.678Z");
  });
});

describe("formatTime strftime", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "Europe/Budapest";
  });

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it("formats every supported directive in the local time zone", () => {
    // 2026-10-12 20:23 UTC is Monday 22:23 in Budapest (CEST, UTC+2).
    const time = Date.UTC(2026, 9, 12, 20, 23);

    expect(format(time, 0, "%a %d %H:%M %b %m %Y")).toBe("Mon 12 22:23 Oct 10 2026");
  });

  it("moves the date across midnight with the local offset", () => {
    // 22:30 UTC on Sunday is 00:30 on Monday in Budapest.
    const time = Date.UTC(2026, 9, 11, 22, 30);

    expect(format(time, 0, "%a %d %H:%M")).toBe("Mon 12 00:30");
  });

  it("zero-pads day, month, hour and minute", () => {
    const time = Date.UTC(2026, 0, 5, 3, 4);

    expect(format(time, 0, "%d.%m. %H:%M")).toBe("05.01. 04:04");
  });

  it("names every weekday and month", () => {
    const sundays = Array.from({ length: 7 }, (_, day) => Date.UTC(2026, 9, 11 + day, 12));
    const firsts = Array.from({ length: 12 }, (_, month) => Date.UTC(2026, month, 1, 12));

    expect(sundays.map((time) => format(time, 0, "%a")).join(" ")).toBe("Sun Mon Tue Wed Thu Fri Sat");
    expect(firsts.map((time) => format(time, 0, "%b")).join(" ")).toBe(
      "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec",
    );
  });

  it("pads the year to four digits", () => {
    expect(format(Date.UTC(900, 5, 1, 12), 0, "%Y")).toBe("0900");
  });

  it("keeps literal text and escaped percent signs", () => {
    expect(format(Date.UTC(2026, 9, 12, 12), 0, "at %H%% x")).toBe("at 14% x");
  });

  it("shows the spring-forward gap: 01:30 UTC on 2026-03-29 is 03:30 local", () => {
    const afterShift = Date.UTC(2026, 2, 29, 1, 30);
    const beforeShift = Date.UTC(2026, 2, 29, 0, 30);

    expect(format(beforeShift, 0, "%H:%M")).toBe("01:30");
    expect(format(afterShift, 0, "%H:%M")).toBe("03:30");
  });

  it("shows the fall-back hour twice: 00:30 and 01:30 UTC on 2026-10-25 are both 02:30 local", () => {
    const firstPass = Date.UTC(2026, 9, 25, 0, 30);
    const secondPass = Date.UTC(2026, 9, 25, 1, 30);

    expect(format(firstPass, 0, "%H:%M")).toBe("02:30");
    expect(format(secondPass, 0, "%H:%M")).toBe("02:30");
  });

  it("counts elapsed time across a DST change for rel", () => {
    // Sat 12:00 to Sun 12:00 local over the spring-forward night is 23 hours.
    const saturdayNoon = Date.UTC(2026, 2, 28, 11, 0);
    const sundayNoon = Date.UTC(2026, 2, 29, 10, 0);

    expect(format(sundayNoon, saturdayNoon, "rel")).toBe("23h");
  });
});

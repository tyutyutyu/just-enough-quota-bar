import { describe, expect, it } from "vitest";
import {
  describeShape,
  earliestAnnounced,
  parseScheduled,
} from "../../../../src/sources/announced/scheduled";

const at = (iso: string): number => Date.parse(iso);

describe("parseScheduled", () => {
  it("accepts null and a missing field as no entries", () => {
    expect(parseScheduled(null)).toEqual([]);
    expect(parseScheduled(undefined)).toEqual([]);
  });

  it("accepts a list and a single object", () => {
    const entry = { certainty: "announced", ts: "2026-10-27T16:00:00Z" };

    expect(parseScheduled([entry])).toEqual([{ certainty: "announced", at: at("2026-10-27T16:00:00Z") }]);
    expect(parseScheduled(entry)).toEqual(parseScheduled([entry]));
  });

  it("takes the time from ts, otherwise from date as the start of that UTC day", () => {
    expect(
      parseScheduled([
        { certainty: "announced", ts: "2026-10-27T16:00:00+02:00", date: "2026-10-01" },
        { certainty: "hinted", date: "2026-10-29" },
        { certainty: "hinted", ts: null, date: "2026-10-30" },
      ]),
    ).toEqual([
      { certainty: "announced", at: at("2026-10-27T14:00:00Z") },
      { certainty: "hinted", at: at("2026-10-29T00:00:00Z") },
      { certainty: "hinted", at: at("2026-10-30T00:00:00Z") },
    ]);
  });

  it("leaves out entries it cannot read, without failing", () => {
    expect(
      parseScheduled([
        "text",
        42,
        null,
        [],
        { ts: "2026-10-27T16:00:00Z" },
        { certainty: 1, ts: "2026-10-27T16:00:00Z" },
        { certainty: "announced" },
        { certainty: "announced", ts: "soon", date: "27/10/2026" },
        { certainty: "announced", ts: "2026-10-27T16:00:00" },
        { certainty: "announced", date: "2026-02-31" },
      ]),
    ).toEqual([]);
    expect(parseScheduled("announced tomorrow")).toEqual([]);
    expect(parseScheduled(7)).toEqual([]);
  });
});

describe("earliestAnnounced", () => {
  it("is the earliest announced entry; hinted ones do not count", () => {
    expect(
      earliestAnnounced([
        { certainty: "hinted", at: 1 },
        { certainty: "announced", at: 30 },
        { certainty: "announced", at: 20 },
      ]),
    ).toBe(20);
  });

  it("is null without an announced entry", () => {
    expect(earliestAnnounced([])).toBeNull();
    expect(earliestAnnounced([{ certainty: "hinted", at: 1 }])).toBeNull();
  });
});

describe("describeShape", () => {
  it("keeps the keys and value types, never the content", () => {
    const shape = describeShape([
      { certainty: "announced", ts: "2026-10-27T16:00:00Z", note: "secret text", n: 1, ok: true, x: null },
    ]);

    expect(JSON.parse(shape)).toEqual([
      { certainty: "string", ts: "string", note: "string", n: "number", ok: "boolean", x: "null" },
    ]);
    expect(shape).not.toContain("secret text");
    expect(shape).not.toContain("2026");
  });

  it("stops at five levels and five list items", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const long = [1, 2, 3, 4, 5, 6, 7];

    expect(describeShape(deep)).toBe('{"a":{"b":{"c":{"d":{"e":"object"}}}}}');
    expect(describeShape([[[[[["x"]]]]]])).toBe('[[[[["array"]]]]]');
    expect(JSON.parse(describeShape(long))).toHaveLength(5);
  });
});

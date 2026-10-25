import { describe, expect, it } from "vitest";
import {
  PROJECT_URL,
  announcedUserAgent,
  getJson,
  parseIsoTime,
  parseUtcDate,
} from "../../../../src/sources/announced/http";
import { fakeFetch, signal } from "./fakeFetch";

const URL = "https://tracker.example/api";

function options(fetchImpl: typeof fetch, abortSignal: AbortSignal = signal()) {
  return { fetchImpl, userAgent: "test-agent", signal: abortSignal, now: () => 0 };
}

describe("announcedUserAgent", () => {
  it("names the extension, its version and the project URL", () => {
    expect(announcedUserAgent("0.1.0")).toBe(`just-enough-quota-bar/0.1.0 (+${PROJECT_URL})`);
    expect(PROJECT_URL).toBe("https://github.com/tyutyutyu/just-enough-quota-bar");
  });

  it("leaves the version out when it is unknown", () => {
    expect(announcedUserAgent()).toBe(`just-enough-quota-bar (+${PROJECT_URL})`);
    expect(announcedUserAgent("")).toBe(`just-enough-quota-bar (+${PROJECT_URL})`);
  });
});

describe("getJson", () => {
  it("returns the parsed body", async () => {
    const { fetchImpl, calls } = fakeFetch({ [URL]: { body: { a: 1 } } });

    expect(await getJson(URL, options(fetchImpl))).toEqual({ ok: true, body: { a: 1 } });
    expect(new Headers(calls[0]?.init?.headers).get("user-agent")).toBe("test-agent");
  });

  it("reports the status and the Retry-After of a failed response", async () => {
    const { fetchImpl } = fakeFetch({ [URL]: { status: 429, headers: { "retry-after": "30" } } });

    expect(await getJson(URL, options(fetchImpl))).toEqual({
      ok: false,
      error: "upstream_429",
      retryAfterMs: 30_000,
    });
  });

  it("reports a body that is not JSON", async () => {
    const { fetchImpl } = fakeFetch({ [URL]: { text: "<html>" } });

    expect(await getJson(URL, options(fetchImpl))).toEqual({ ok: false, error: "invalid_announced_response" });
  });

  it("tells a network error from a timeout", async () => {
    const { fetchImpl } = fakeFetch({ [URL]: new Error("ECONNRESET secret") });
    const aborted = new AbortController();
    aborted.abort();

    expect(await getJson(URL, options(fetchImpl))).toEqual({ ok: false, error: "network_error" });
    expect(await getJson(URL, options(fetchImpl, aborted.signal))).toEqual({ ok: false, error: "timeout" });
  });
});

describe("parseUtcDate", () => {
  it("reads a YYYY-MM-DD date as the start of the UTC day", () => {
    expect(parseUtcDate("2026-10-21")).toBe(Date.parse("2026-10-21T00:00:00Z"));
  });

  it("rejects anything else, including an impossible day", () => {
    for (const value of ["2026-02-31", "2026-10-21T00:00:00Z", "21.10.2026", 20261021, null]) {
      expect(parseUtcDate(value)).toBeNull();
    }
  });
});

describe("parseIsoTime", () => {
  it("reads a date-time with an explicit zone", () => {
    expect(parseIsoTime("2026-10-25T06:10:01.000Z")).toBe(Date.parse("2026-10-25T06:10:01Z"));
    expect(parseIsoTime("2026-10-25T08:10:01+02:00")).toBe(Date.parse("2026-10-25T06:10:01Z"));
  });

  it("rejects a time without a zone and other values", () => {
    for (const value of ["2026-10-25T06:10:01", "2026-10-25", "2026-13-45T99:00:00Z", 1, null]) {
      expect(parseIsoTime(value)).toBeNull();
    }
  });
});

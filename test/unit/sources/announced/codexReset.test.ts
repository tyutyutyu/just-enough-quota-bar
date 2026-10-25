import { describe, expect, it } from "vitest";
import {
  CODEX_RESET_ATTRIBUTION,
  CODEX_RESET_FORECAST_URL,
  CODEX_RESET_INTERVAL_MS,
  CODEX_RESET_MIN_INTERVAL_MS,
  createCodexResetSource,
  parseCodexResetForecast,
} from "../../../../src/sources/announced/codexReset";
import { fakeFetch, fixture, signal, type Reply } from "./fakeFetch";

// codexResetForecast.json is an unchanged live response of 2026-10-25.
const FORECAST = fixture("codexResetForecast.json");
const MINUTE = 60_000;
const UA = "just-enough-quota-bar (+https://github.com/tyutyutyu/just-enough-quota-bar)";

describe("parseCodexResetForecast", () => {
  it("reads the rounded probabilities and the last reset of the live response", () => {
    expect(parseCodexResetForecast(FORECAST)).toEqual({
      next: null,
      kind: null,
      last: Date.parse("2026-10-25T06:10:01Z"),
      p24: 44,
      p48: 69,
    });
  });

  it("leaves a field it cannot read missing", () => {
    expect(
      parseCodexResetForecast({ probabilities: { rounded_24h: 140, rounded_48h: "69" }, last_reset_at: "today" }),
    ).toEqual({ next: null, kind: null, last: null, p24: null, p48: null });
    expect(parseCodexResetForecast({})).toMatchObject({ p24: null, p48: null, last: null });
  });

  it("rejects a response that is not an object", () => {
    expect(parseCodexResetForecast("forecast")).toBeNull();
  });
});

function source(reply: Reply | Error) {
  const fake = fakeFetch({ [CODEX_RESET_FORECAST_URL]: reply });
  const created = createCodexResetSource({
    fetchImpl: fake.fetchImpl,
    userAgent: UA,
    now: () => 0,
    log: () => undefined,
  });
  return { source: created, calls: fake.calls };
}

describe("createCodexResetSource", () => {
  it("covers Codex only, polls every 30 minutes and at most once a minute", () => {
    const { source: codex } = source({ body: FORECAST });

    expect(codex.provider).toBe("codex");
    expect(codex.sourceId).toBe("codexReset");
    expect(codex.definition).toMatchObject({
      id: "codex-codexreset",
      intervalMs: 30 * MINUTE,
      minRetryMs: CODEX_RESET_MIN_INTERVAL_MS,
    });
    expect(CODEX_RESET_INTERVAL_MS).toBe(30 * MINUTE);
    expect(codex.minIntervalMs).toBe(CODEX_RESET_MIN_INTERVAL_MS);
    expect(CODEX_RESET_MIN_INTERVAL_MS).toBe(MINUTE);
  });

  it("credits codex-reset.com with a link, as its terms require", () => {
    expect(CODEX_RESET_ATTRIBUTION).toEqual({
      text: "Data: codex-reset.com",
      url: "https://codex-reset.com/",
    });
  });

  it("fills p24, p48 and last with the identifying User-Agent", async () => {
    const { source: codex, calls } = source({ body: FORECAST });

    const result = await codex.fetch(signal());

    expect(result).toEqual({
      ok: true,
      snapshot: {
        name: "Codex",
        announced: { next: null, kind: null, last: Date.parse("2026-10-25T06:10:01Z"), p24: 44, p48: 69 },
      },
    });
    expect(new Headers(calls[0]?.init?.headers).get("user-agent")).toBe(UA);
  });

  it("fails with a non-sensitive code", async () => {
    expect(await source({ status: 500 }).source.fetch(signal())).toMatchObject({ ok: false, error: "upstream_500" });
    expect(await source({ body: [] }).source.fetch(signal())).toEqual({
      ok: false,
      error: "invalid_announced_response",
    });
  });
});

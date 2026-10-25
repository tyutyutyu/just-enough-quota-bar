import { describe, expect, it } from "vitest";
import { createAnnouncedSources } from "../../../../src/sources/announced";
import { PROJECT_URL } from "../../../../src/sources/announced/http";
import { WHENRESET_FORECAST_URL, WHENRESET_LATEST_URL } from "../../../../src/sources/announced/whenreset";
import { fakeFetch, signal } from "./fakeFetch";

describe("createAnnouncedSources", () => {
  it("offers whenreset for both providers and codex-reset for Codex", () => {
    const sources = createAnnouncedSources({ log: () => undefined });

    expect(sources.map((source) => [source.provider, source.sourceId, source.definition.id])).toEqual([
      ["claude", "whenreset", "claude-whenreset"],
      ["codex", "whenreset", "codex-whenreset"],
      ["codex", "codexReset", "codex-codexreset"],
    ]);
  });

  it("sends the extension version in the User-Agent", async () => {
    const { fetchImpl, calls } = fakeFetch({ "https://codex-reset.com/api/forecast": { body: {} } });
    const sources = createAnnouncedSources({ version: "9.9.9", log: () => undefined, fetchImpl });

    await sources[2]?.fetch(signal());

    expect(new Headers(calls[0]?.init?.headers).get("user-agent")).toBe(
      `just-enough-quota-bar/9.9.9 (+${PROJECT_URL})`,
    );
  });

  it("requests latest.json once when both whenreset sources fetch together", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [WHENRESET_LATEST_URL]: { body: { products: { claude: {}, codex: {} } } },
      [`${WHENRESET_FORECAST_URL}?product=claude`]: { body: {} },
      [`${WHENRESET_FORECAST_URL}?product=codex`]: { body: {} },
    });
    const [claude, codex] = createAnnouncedSources({ log: () => undefined, fetchImpl });

    const results = await Promise.all([claude?.fetch(signal()), codex?.fetch(signal())]);

    expect(results.map((result) => result?.ok)).toEqual([true, true]);
    expect(calls.filter((call) => call.url === WHENRESET_LATEST_URL)).toHaveLength(1);
  });
});

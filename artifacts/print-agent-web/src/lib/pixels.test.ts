import { beforeEach, describe, expect, it, vi } from "vitest";

const MARKET_CONFIG = JSON.stringify({
  AE: { accountId: "AW-111111", label: "uae-label" },
  LB: { accountId: "AW-222222", label: "lebanon-label" },
  CY: { accountId: "AW-222222", label: "cyprus-label" },
});

async function loadPixels(config = MARKET_CONFIG) {
  vi.resetModules();
  vi.stubEnv("VITE_GOOGLE_ADS_MARKETS", config);
  return import("./pixels");
}

function gtagCalls(): unknown[][] {
  return (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
}

describe("payment-link Google Ads pixels", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete window.gtag;
    window.dataLayer = [];
    document.head.querySelectorAll("script").forEach((script) => script.remove());
  });

  it("initializes every unique configured Google Ads account", async () => {
    const { initPixels } = await loadPixels();

    initPixels();

    expect(gtagCalls()).toEqual(expect.arrayContaining([
      ["config", "AW-111111"],
      ["config", "AW-222222"],
    ]));
    expect(gtagCalls().filter(
      ([command, id]) => command === "config" && String(id).startsWith("AW-"),
    )).toHaveLength(2);
  });

  it("configures every Ads account when gtag already exists", async () => {
    window.gtag = (...args: unknown[]) => {
      window.dataLayer!.push(args);
    };
    const { initPixels } = await loadPixels();

    initPixels();

    expect(gtagCalls()).toEqual(expect.arrayContaining([
      ["config", "AW-111111"],
      ["config", "AW-222222"],
    ]));
  });

  it.each([
    "United Arab Emirates",
    "Lebanon",
    "Cyprus",
    "AE",
  ])("does not send %s purchases from the browser", async (country) => {
    const { initPixels, trackPurchase } = await loadPixels();
    initPixels();

    trackPurchase(2500, "USD", "token-1", country);

    expect(gtagCalls().some(
      ([command, event]) => command === "event" && event === "conversion",
    )).toBe(false);
  });

  it.each([null, "", "Unknown market"])(
    "does not fire an Ads conversion for an unconfigured destination",
    async (country) => {
      const { initPixels, trackPurchase } = await loadPixels();
      initPixels();

      trackPurchase(2500, "USD", "token-1", country);

      expect(gtagCalls().some(
        ([command, event]) => command === "event" && event === "conversion",
      )).toBe(false);
    },
  );

  it("fails closed for malformed market configuration", async () => {
    const { initPixels, trackPurchase } = await loadPixels("{not-json");
    initPixels();

    trackPurchase(2500, "USD", "token-1", "Lebanon");

    expect(gtagCalls().some(
      ([command, event]) => command === "event" && event === "conversion",
    )).toBe(false);
    expect(gtagCalls().some(
      ([command, id]) => command === "config" && String(id).startsWith("AW-"),
    )).toBe(false);
  });
});
import { afterEach, describe, expect, it, vi } from "vitest";
import { preflightMerchantImages, robotsAllows } from "./merchantImagePreflight";
import type { MerchantProductInput } from "./googleMerchant";

function payload(imageLink: string): MerchantProductInput {
  return {
    offerId: "SKU-LB",
    contentLanguage: "en",
    feedLabel: "LB",
    productAttributes: {
      title: "Rose",
      description: "Rose",
      link: "https://presentail.com/en-lb/beirut/product/rose",
      imageLink,
      availability: "IN_STOCK",
      price: { amount: 10, amountMicros: "10000000", currencyCode: "USD" },
      identifierExists: false,
      condition: "NEW",
    },
  };
}

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(() => vi.unstubAllGlobals());

describe("Merchant image crawl preflight", () => {
  it("uses the most specific crawler group and exact-path rules", () => {
    const robots = `User-agent: *\nDisallow: /api/\n\nUser-agent: Googlebot-Image\nAllow: /api/storage/public-objects/`;
    expect(robotsAllows(robots, "Googlebot", "/api/storage/public-objects/a.jpg")).toBe(false);
    expect(robotsAllows(robots, "Googlebot-Image", "/api/storage/public-objects/a.jpg")).toBe(true);
  });

  it("accepts public 200 image content allowed to both Google crawlers", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      return new Response(ONE_PIXEL_PNG, { status: 200, headers: { "Content-Type": "image/png" } });
    }));
    await expect(preflightMerchantImages([
      payload("https://os.presentail.com/api/storage/public-objects/products/1/main.webp"),
    ])).resolves.toEqual({ ok: true, checked: 1, failures: [] });
  });

  it("rejects an image path blocked for Googlebot even when Googlebot-Image is allowed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) {
        return new Response(
          "User-agent: Googlebot\nDisallow: /api/\n\nUser-agent: Googlebot-Image\nAllow: /",
          { status: 200 },
        );
      }
      return new Response("image", { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }));
    const result = await preflightMerchantImages([
      payload("https://presentail.com/api/storage/public-objects/products/1/main.jpg"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toContain("Googlebot is blocked");
  });

  it("rejects routed HTML and missing image responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      return new Response("<html>not an image</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    }));
    const result = await preflightMerchantImages([payload("https://cdn.presentail.com/image.jpg")]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toContain("non-image content type");
  });

  it("rejects non-Presentail hosts without fetching them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await preflightMerchantImages([payload("https://169.254.169.254/image.jpg")]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toContain("Presentail-owned host");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects redirects instead of validating a different destination", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      throw new TypeError("fetch failed: redirect mode is set to error");
    }));
    const result = await preflightMerchantImages([
      payload("https://os.presentail.com/api/storage/public-objects/redirect.jpg"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toContain("could not be fetched");
  });

  it("rejects corrupt bytes even when labeled as an image", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      return new Response("not really an image", { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }));
    const result = await preflightMerchantImages([
      payload("https://os.presentail.com/api/storage/public-objects/corrupt.jpg"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toContain("could not be fetched");
  });

  it("rejects a truncated PNG that still contains valid dimensions", async () => {
    const truncatedPng = ONE_PIXEL_PNG.subarray(0, 24);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      return new Response(truncatedPng, { status: 200, headers: { "Content-Type": "image/png" } });
    }));
    const result = await preflightMerchantImages([
      payload("https://os.presentail.com/api/storage/public-objects/truncated.png"),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toContain("could not be fetched");
  });
});
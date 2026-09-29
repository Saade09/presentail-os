import { describe, expect, it, vi } from "vitest";
import { resolvePublicUrlAddress } from "./urlValidator";

describe("resolvePublicUrlAddress", () => {
  it("rejects non-HTTPS, loopback, metadata, and credential-bearing URLs", async () => {
    await expect(resolvePublicUrlAddress("http://example.com/hook")).rejects.toThrow(/HTTPS/);
    await expect(resolvePublicUrlAddress("https://127.0.0.1/hook")).rejects.toThrow(/public/);
    await expect(resolvePublicUrlAddress("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/public/);
    await expect(resolvePublicUrlAddress("https://user:pass@example.com/hook")).rejects.toThrow(/credentials/);
  });

  it("rejects a hostname if any resolved address is private", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(resolvePublicUrlAddress("https://hooks.example.test/event", resolver))
      .rejects.toThrow(/public/);
  });

  it("returns a public address that can be pinned by the caller", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    await expect(resolvePublicUrlAddress("https://hooks.example.test/event", resolver))
      .resolves.toEqual({ address: "93.184.216.34", family: 4 });
  });
});
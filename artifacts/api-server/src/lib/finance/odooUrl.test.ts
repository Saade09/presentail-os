import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { describe, expect, it, vi } from "vitest";
import {
  createPinnedOdooLookup,
  normaliseOdooBaseUrl,
  resolvePublicOdooAddress,
  safeOdooFetch,
} from "./odooUrl";

describe("Odoo URL safety", () => {
  it("rejects embedded credentials, non-HTTPS and literal private hosts", () => {
    expect(normaliseOdooBaseUrl("http://odoo.example.com").ok).toBe(false);
    expect(normaliseOdooBaseUrl("https://user:pass@odoo.example.com").ok).toBe(false);
    expect(normaliseOdooBaseUrl("https://127.0.0.1").ok).toBe(false);
    expect(normaliseOdooBaseUrl("https://[::ffff:127.0.0.1]").ok).toBe(false);
  });

  it("rejects public-looking hostnames that resolve to private infrastructure", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "10.0.0.7", family: 4 },
    ]);

    await expect(
      resolvePublicOdooAddress("https://odoo.example.com", resolver),
    ).rejects.toThrow(/public IP addresses/i);
  });

  it("pins a host only when every resolved address is public", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);

    await expect(
      resolvePublicOdooAddress("https://odoo.example.com", resolver),
    ).resolves.toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("returns the address array requested by all-address lookup mode", () => {
    const callback = vi.fn();
    createPinnedOdooLookup({ address: "8.8.8.8", family: 4 })(
      "odoo.example.com",
      { all: true },
      callback,
    );

    expect(callback).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
  });

  it("retains the scalar callback shape for legacy lookup mode", () => {
    const callback = vi.fn();
    createPinnedOdooLookup({ address: "8.8.8.8", family: 4 })(
      "odoo.example.com",
      {},
      callback,
    );

    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });

  it("completes an HTTPS request when the runtime requests all addresses", async () => {
    const resolver = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const request = vi.fn((_url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
      const lookupCallback = vi.fn((error, addresses) => {
        expect(error).toBeNull();
        expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
      });
      options.lookup?.("odoo.example.com", { all: true }, lookupCallback);

      const response = new EventEmitter() as IncomingMessage;
      response.statusCode = 404;
      response.statusMessage = "Not Found";
      response.headers = { "content-type": "text/plain" };

      const clientRequest = new EventEmitter() as ClientRequest;
      clientRequest.write = vi.fn() as ClientRequest["write"];
      clientRequest.end = vi.fn(() => {
        onResponse(response);
        response.emit("data", Buffer.from("missing addon"));
        response.emit("end");
        return clientRequest;
      }) as ClientRequest["end"];
      clientRequest.destroy = vi.fn() as ClientRequest["destroy"];
      return clientRequest;
    });

    const response = await safeOdooFetch(
      "https://odoo.example.com/bank_recon/api/v1/health",
      {},
      { resolver, request: request as unknown as typeof import("node:https").request },
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("missing addon");
  });
});
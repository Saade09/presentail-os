import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that load the module
// ---------------------------------------------------------------------------

const { mockFetch, mockLogger, mockOrderPaymentTemplateHeaderImage } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const mockOrderPaymentTemplateHeaderImage = vi.fn();
  return { mockFetch, mockLogger, mockOrderPaymentTemplateHeaderImage };
});

vi.stubGlobal("fetch", mockFetch);

vi.mock("./logger", () => ({ logger: mockLogger }));

vi.mock("./respondioOrderTemplates", () => ({
  orderPaymentTemplateHeaderImage: mockOrderPaymentTemplateHeaderImage,
}));

import { checkWhatsAppTemplateImages } from "./checkWhatsAppTemplateImages";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(status = 200): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkWhatsAppTemplateImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all three template images have valid URLs
    mockOrderPaymentTemplateHeaderImage.mockImplementation(
      (name: string) => `https://os.presentail.com/whatsapp/${name}.png`,
    );
  });

  it("logs info for each image when all URLs return 200", async () => {
    mockFetch.mockResolvedValue(makeOkResponse(200));

    await checkWhatsAppTemplateImages();

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(3);
    for (const name of ["new_order_received", "order_ready", "order_delivered"]) {
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: name, status: 200 }),
        expect.stringContaining(name),
      );
    }
  });

  it("uses HEAD requests so no body is downloaded", async () => {
    mockFetch.mockResolvedValue(makeOkResponse(200));

    await checkWhatsAppTemplateImages();

    for (const call of mockFetch.mock.calls) {
      expect(call[1]).toMatchObject({ method: "HEAD" });
    }
  });

  it("logs an error naming the template when one image returns 404", async () => {
    mockOrderPaymentTemplateHeaderImage.mockImplementation((name: string) =>
      name === "order_ready"
        ? "https://os.presentail.com/whatsapp/order-ready.png"
        : `https://os.presentail.com/whatsapp/${name}.png`,
    );
    mockFetch.mockImplementation(async (_url: string) => {
      if (String(_url).includes("order-ready")) {
        return makeOkResponse(404);
      }
      return makeOkResponse(200);
    });

    await checkWhatsAppTemplateImages();

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [ctx, msg] = mockLogger.error.mock.calls[0] as [{ templateName: string; status: number }, string];
    expect(ctx.templateName).toBe("order_ready");
    expect(ctx.status).toBe(404);
    expect(msg).toMatch(/order_ready/);
  });

  it("logs an error for a network timeout but does not throw (server still starts)", async () => {
    mockFetch.mockImplementation(
      (_url: string, opts: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          // Simulate the signal aborting the request
          if (opts?.signal) {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        }),
    );

    // The probe should complete without throwing even though all fetches hang
    // until the AbortController fires. We fast-forward by replacing setTimeout.
    vi.useFakeTimers();
    const probePromise = checkWhatsAppTemplateImages();
    await vi.runAllTimersAsync();
    await probePromise;
    vi.useRealTimers();

    expect(mockLogger.error).toHaveBeenCalled();
    const [ctx] = mockLogger.error.mock.calls[0] as [{ timedOut?: boolean }];
    expect(ctx.timedOut).toBe(true);
  });

  it("logs an error (not throws) when a URL is not configured for a template", async () => {
    // Simulate a template with no configured image URL
    mockOrderPaymentTemplateHeaderImage.mockImplementation((name: string) =>
      name === "order_delivered" ? null : `https://os.presentail.com/whatsapp/${name}.png`,
    );
    mockFetch.mockResolvedValue(makeOkResponse(200));

    await checkWhatsAppTemplateImages();

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [ctx] = mockLogger.error.mock.calls[0] as [{ templateName: string }];
    expect(ctx.templateName).toBe("order_delivered");
    // fetch should not be called for the missing URL
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("still checks the remaining images when one fails — all three are probed", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("new_order_received")) {
        return makeOkResponse(500);
      }
      return makeOkResponse(200);
    });

    await checkWhatsAppTemplateImages();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledTimes(2);
  });

  it("resolves without throwing even when all fetches fail", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));

    await expect(checkWhatsAppTemplateImages()).resolves.toBeUndefined();

    expect(mockLogger.error).toHaveBeenCalledTimes(3);
  });
});

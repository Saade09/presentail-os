import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { warnMamoEnvVars, ensureMamoWebhook } from "./mamoWebhook";
import { logger } from "./logger";

const warnSpy = vi.mocked(logger.warn);

describe("warnMamoEnvVars()", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    warnSpy.mockClear();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("logs no warning when both vars are set", () => {
    process.env.MAMO_API_KEY = "test-api-key";
    process.env.MAMO_WEBHOOK_SECRET = "test-secret";
    warnMamoEnvVars();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs a warning when MAMO_API_KEY is missing", () => {
    delete process.env.MAMO_API_KEY;
    process.env.MAMO_WEBHOOK_SECRET = "test-secret";
    warnMamoEnvVars();
    expect(warnSpy).toHaveBeenCalledOnce();
    const [meta, msg] = warnSpy.mock.calls[0] as [{ missingVars: string[] }, string];
    expect(meta.missingVars).toContain("MAMO_API_KEY");
    expect(meta.missingVars).not.toContain("MAMO_WEBHOOK_SECRET");
    expect(msg).toMatch(/misconfigured/i);
  });

  it("logs a warning when MAMO_WEBHOOK_SECRET is missing", () => {
    process.env.MAMO_API_KEY = "test-api-key";
    delete process.env.MAMO_WEBHOOK_SECRET;
    warnMamoEnvVars();
    expect(warnSpy).toHaveBeenCalledOnce();
    const [meta, msg] = warnSpy.mock.calls[0] as [{ missingVars: string[] }, string];
    expect(meta.missingVars).toContain("MAMO_WEBHOOK_SECRET");
    expect(meta.missingVars).not.toContain("MAMO_API_KEY");
    expect(msg).toMatch(/misconfigured/i);
  });

  it("logs a warning listing both vars when both are missing", () => {
    delete process.env.MAMO_API_KEY;
    delete process.env.MAMO_WEBHOOK_SECRET;
    warnMamoEnvVars();
    expect(warnSpy).toHaveBeenCalledOnce();
    const [meta, msg] = warnSpy.mock.calls[0] as [{ missingVars: string[] }, string];
    expect(meta.missingVars).toContain("MAMO_API_KEY");
    expect(meta.missingVars).toContain("MAMO_WEBHOOK_SECRET");
    expect(msg).toMatch(/misconfigured/i);
  });
});

// ---------------------------------------------------------------------------
// ensureMamoWebhook()
// ---------------------------------------------------------------------------

const MAMO_API_BASE = "https://api.mamopay.com";
const WEBHOOKS_URL = `${MAMO_API_BASE}/manage_api/v1/webhooks`;

function makeWebhookEntry(
  id: string,
  url: string,
  auth_header: string,
): Record<string, unknown> {
  return { id, url, auth_header, is_active: true };
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(status: number, body = "error"): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

function stubFetchSequence(
  handlers: Array<(url: string, init?: RequestInit) => Response>,
) {
  let callIndex = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const handler = handlers[callIndex++];
      if (!handler)
        throw new Error(`Unexpected fetch call #${callIndex} to ${url}`);
      return handler(url, init);
    }),
  );
}

describe("ensureMamoWebhook()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MAMO_API_KEY", "test_api_key");
    vi.stubEnv("MAMO_WEBHOOK_SECRET", "test_webhook_secret");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "example.replit.dev");
    vi.stubEnv("PUBLIC_URL", "");
    // Always install a catch-all fetch spy so vi.mocked(fetch) is valid even in
    // tests that expect no HTTP calls to be made.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch should not be called")));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Missing env vars — should skip without any HTTP requests
  // -------------------------------------------------------------------------

  it("does nothing when MAMO_API_KEY is not set", async () => {
    vi.stubEnv("MAMO_API_KEY", "");

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("MAMO_API_KEY or MAMO_WEBHOOK_SECRET not set"),
    );
  });

  it("does nothing when MAMO_WEBHOOK_SECRET is not set", async () => {
    vi.stubEnv("MAMO_WEBHOOK_SECRET", "");

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("MAMO_API_KEY or MAMO_WEBHOOK_SECRET not set"),
    );
  });

  it("does nothing when both MAMO_API_KEY and MAMO_WEBHOOK_SECRET are absent", async () => {
    vi.stubEnv("MAMO_API_KEY", "");
    vi.stubEnv("MAMO_WEBHOOK_SECRET", "");

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("MAMO_API_KEY or MAMO_WEBHOOK_SECRET not set"),
    );
  });

  // -------------------------------------------------------------------------
  // Missing deployment URL
  // -------------------------------------------------------------------------

  it("logs a warning and skips when no deployment URL can be determined", async () => {
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("PUBLIC_URL", "");

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining("could not determine deployment URL"),
    );
  });

  // -------------------------------------------------------------------------
  // List webhooks failure
  // -------------------------------------------------------------------------

  it("logs a warning and returns when the list-webhooks call fails", async () => {
    stubFetchSequence([() => errorResponse(401, "Unauthorized")]);

    await ensureMamoWebhook();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401 }),
      expect.stringContaining("failed to list webhooks"),
    );
  });

  it("sends the Bearer token in the Authorization header when listing webhooks", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okJson({ data: [] }));
    vi.stubGlobal("fetch", mockFetch);

    await ensureMamoWebhook();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOKS_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test_api_key");
  });

  // -------------------------------------------------------------------------
  // Webhook already exists with the correct auth_header — no-op
  // -------------------------------------------------------------------------

  it("skips registration when the webhook already exists with the correct auth_header", async () => {
    const targetUrl = "https://example.replit.dev/api/webhooks/mamo";
    stubFetchSequence([
      () =>
        okJson({
          data: [makeWebhookEntry("wh-1", targetUrl, "test_webhook_secret")],
        }),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: "wh-1", url: targetUrl }),
      expect.stringContaining("already registered with correct auth_header"),
    );
  });

  it("ignores webhooks registered for a different URL and creates one for the correct URL", async () => {
    const targetUrl = "https://example.replit.dev/api/webhooks/mamo";
    stubFetchSequence([
      () =>
        okJson({
          data: [
            makeWebhookEntry(
              "wh-other",
              "https://other.domain.com/api/webhooks/mamo",
              "test_webhook_secret",
            ),
          ],
        }),
      () => okJson({ data: { id: "wh-new" } }),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(createUrl).toBe(WEBHOOKS_URL);
    expect(createInit.method).toBe("POST");
    const body = JSON.parse(createInit.body as string) as Record<
      string,
      unknown
    >;
    expect(body.url).toBe(targetUrl);
  });

  // -------------------------------------------------------------------------
  // Webhook exists but auth_header is out of sync — PATCH it
  // -------------------------------------------------------------------------

  it("updates auth_header when the webhook exists but the secret has changed", async () => {
    const targetUrl = "https://example.replit.dev/api/webhooks/mamo";
    stubFetchSequence([
      () =>
        okJson({
          data: [makeWebhookEntry("wh-stale", targetUrl, "old_secret")],
        }),
      () => okJson({ id: "wh-stale" }),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const [patchUrl, patchInit] = vi.mocked(fetch).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(patchUrl).toBe(
      `${MAMO_API_BASE}/manage_api/v1/webhooks/wh-stale`,
    );
    expect(patchInit.method).toBe("PATCH");
    const body = JSON.parse(patchInit.body as string) as Record<
      string,
      unknown
    >;
    expect(body.auth_header).toBe("test_webhook_secret");
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: "wh-stale" }),
      expect.stringContaining("auth_header updated"),
    );
  });

  it("logs a warning when the PATCH update fails", async () => {
    const targetUrl = "https://example.replit.dev/api/webhooks/mamo";
    stubFetchSequence([
      () =>
        okJson({
          data: [makeWebhookEntry("wh-stale", targetUrl, "old_secret")],
        }),
      () => errorResponse(500, "Internal Server Error"),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, webhookId: "wh-stale" }),
      expect.stringContaining("failed to update auth_header"),
    );
  });

  // -------------------------------------------------------------------------
  // No webhook for this URL — create one
  // -------------------------------------------------------------------------

  it("creates the webhook with the correct URL, secret, and is_active=true when none exists", async () => {
    const targetUrl = "https://example.replit.dev/api/webhooks/mamo";
    stubFetchSequence([
      () => okJson({ data: [] }),
      () => okJson({ data: { id: "wh-created" } }),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = vi.mocked(fetch).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(createUrl).toBe(WEBHOOKS_URL);
    expect(createInit.method).toBe("POST");
    const body = JSON.parse(createInit.body as string) as Record<
      string,
      unknown
    >;
    expect(body.url).toBe(targetUrl);
    expect(body.auth_header).toBe("test_webhook_secret");
    expect(body.is_active).toBe(true);
  });

  it("uses the Bearer token when creating the webhook", async () => {
    stubFetchSequence([
      () => okJson({ data: [] }),
      () => okJson({ data: { id: "wh-created" } }),
    ]);

    await ensureMamoWebhook();

    const [, createInit] = vi.mocked(fetch).mock.calls[1] as [
      string,
      RequestInit,
    ];
    const headers = createInit.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test_api_key");
  });

  it("logs success with the new webhook id after creating", async () => {
    const targetUrl = "https://example.replit.dev/api/webhooks/mamo";
    stubFetchSequence([
      () => okJson({ data: [] }),
      () => okJson({ data: { id: "wh-new-42" } }),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: "wh-new-42", url: targetUrl }),
      expect.stringContaining("webhook created successfully"),
    );
  });

  it("falls back to the top-level id field in the create response", async () => {
    stubFetchSequence([
      () => okJson({ data: [] }),
      () => okJson({ id: "wh-top-level" }),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: "wh-top-level" }),
      expect.stringContaining("webhook created successfully"),
    );
  });

  it("logs a warning and returns when the create call fails", async () => {
    stubFetchSequence([
      () => okJson({ data: [] }),
      () => errorResponse(422, "Unprocessable Entity"),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 422 }),
      expect.stringContaining("failed to create webhook"),
    );
  });

  // -------------------------------------------------------------------------
  // Deployment URL resolution
  // -------------------------------------------------------------------------

  it("derives the target URL from REPLIT_DEV_DOMAIN when set", async () => {
    vi.stubEnv("REPLIT_DEV_DOMAIN", "myapp.replit.dev");
    stubFetchSequence([
      () => okJson({ data: [] }),
      () => okJson({ data: { id: "wh-x" } }),
    ]);

    await ensureMamoWebhook();

    const [, createInit] = vi.mocked(fetch).mock.calls[1] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(createInit.body as string) as Record<
      string,
      unknown
    >;
    expect(body.url).toBe("https://myapp.replit.dev/api/webhooks/mamo");
  });

  it("falls back to PUBLIC_URL when REPLIT_DEV_DOMAIN is absent", async () => {
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("PUBLIC_URL", "https://myapp.example.com");
    stubFetchSequence([
      () => okJson({ results: [] }),
      () => okJson({ data: { id: "wh-pub" } }),
    ]);

    await ensureMamoWebhook();

    const [, createInit] = vi.mocked(fetch).mock.calls[1] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(createInit.body as string) as Record<
      string,
      unknown
    >;
    expect(body.url).toBe("https://myapp.example.com/api/webhooks/mamo");
  });

  it("accepts the results array shape (alternative Mamo list response format)", async () => {
    const targetUrl = "https://example.replit.dev/api/webhooks/mamo";
    stubFetchSequence([
      () =>
        okJson({
          results: [
            makeWebhookEntry("wh-res", targetUrl, "test_webhook_secret"),
          ],
        }),
    ]);

    await ensureMamoWebhook();

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: "wh-res" }),
      expect.stringContaining("already registered with correct auth_header"),
    );
  });

  // -------------------------------------------------------------------------
  // Unexpected error — must not throw
  // -------------------------------------------------------------------------

  it("catches unexpected errors and logs a warning without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network failure")),
    );

    await expect(ensureMamoWebhook()).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: "network failure" }),
      }),
      expect.stringContaining("unexpected error"),
    );
  });
});

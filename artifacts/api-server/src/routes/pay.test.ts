import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before vi.mock calls
// ---------------------------------------------------------------------------

const { mockDbQuery, mockConstructEvent, mockReconcileStripeLink, mockUpsertContact } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockConstructEvent: vi.fn(),
  mockReconcileStripeLink: vi.fn(),
  mockUpsertContact: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("stripe", () => {
  class MockStripe {
    webhooks = {
      constructEvent: (...args: unknown[]) => mockConstructEvent(...args),
    };
  }
  return { default: MockStripe };
});

vi.mock("../lib/contactUpsert", () => ({
  upsertContact: (...args: unknown[]) => mockUpsertContact(...args),
}));

vi.mock("../lib/email", () => ({
  sendPaymentReceiptEmail: vi.fn().mockResolvedValue(undefined),
}));

// Keep the real isReconcilable gate but mock the actual Stripe reconciliation
// call so the pay-page tests can control its outcome deterministically.
vi.mock("../lib/stripeReconciliation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stripeReconciliation")>();
  return {
    ...actual,
    reconcileStripeLink: (...args: unknown[]) => mockReconcileStripeLink(...args),
  };
});

import payRouter from "./pay";

// ---------------------------------------------------------------------------
// Test app factory
// Reads the raw request body bytes, attaches them as req.rawBody, and
// also JSON-parses them into req.body — replicating what the production
// rawBody middleware does without depending on express.raw / express.json.
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();

  app.use((req: express.Request & { rawBody?: Buffer }, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      req.rawBody = buf;
      if (buf.length > 0) {
        try {
          req.body = JSON.parse(buf.toString("utf-8"));
        } catch {
          // leave body unparsed for non-JSON
        }
      }
      next();
    });
    req.on("error", next);
  });

  app.use(payRouter);
  return app;
}

const app = makeApp();

describe("POST /pay/:token/attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it.each(["gclid", "gbraid", "wbraid"] as const)(
    "persists a valid %s before checkout",
    async (kind) => {
      const res = await request(app)
        .post("/pay/abc123token/attribution")
        .send({ [kind]: "click-123" });

      expect(res.status).toBe(200);
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("google_click_id_type"),
        ["abc123token", kind, "click-123"],
      );
    },
  );

  it("rejects ambiguous click identifiers", async () => {
    const res = await request(app)
      .post("/pay/abc123token/attribution")
      .send({ gclid: "one", wbraid: "two" });

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Helper: build a fake Stripe checkout.session.completed event
// ---------------------------------------------------------------------------

function makeStripeEvent(
  paymentStatus: string = "paid",
  publicToken: string = "abc123token",
): object {
  return {
    type: "checkout.session.completed",
    data: {
      object: {
        payment_status: paymentStatus,
        metadata: { public_token: publicToken },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// POST /webhooks/stripe
// ---------------------------------------------------------------------------

describe("POST /webhooks/stripe — Stripe webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fake456");
    // UAE account off by default so existing single-account tests are unaffected.
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET_UAE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 when no Stripe key is set for either account", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "");

    const body = Buffer.from(JSON.stringify(makeStripeEvent()));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=fakesig")
      .send(body);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Stripe") });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("verifies against the UAE webhook secret when the default secret fails", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_default");
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "sk_test_uae");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET_UAE", "whsec_uae");

    const publicToken = "uaeevent1234token";
    // First secret (default) fails, second secret (UAE) succeeds.
    mockConstructEvent
      .mockImplementationOnce(() => {
        throw new Error("No signatures found matching the expected signature");
      })
      .mockReturnValueOnce(makeStripeEvent("paid", publicToken));
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const body = Buffer.from(JSON.stringify(makeStripeEvent("paid", publicToken)));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=uaesig")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockConstructEvent).toHaveBeenCalledTimes(2);

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) && /status\s*=\s*'paid'/i.test(sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.[0]).toMatch(/INSERT\s+INTO\s+payment_link_conversions/i);
    const [, params] = updateCall as [string, unknown[]];
    expect(params[0]).toBe(publicToken);
  });

  it("verifies against the UAE account when only the UAE key/secret are configured", async () => {
    // Default account not configured at all; only UAE is set up.
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "sk_test_uae");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET_UAE", "whsec_uae");

    const publicToken = "uaeonlyevent12tok";
    mockConstructEvent.mockReturnValueOnce(makeStripeEvent("paid", publicToken));
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const body = Buffer.from(JSON.stringify(makeStripeEvent("paid", publicToken)));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=uaesig")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    // Only the single (UAE) secret is configured, so exactly one verification attempt.
    expect(mockConstructEvent).toHaveBeenCalledTimes(1);

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) && /status\s*=\s*'paid'/i.test(sql),
    );
    expect(updateCall).toBeDefined();
    const [, params] = updateCall as [string, unknown[]];
    expect(params[0]).toBe(publicToken);
  });

  it("returns 400 when the signature fails against both account secrets", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_default");
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "sk_test_uae");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET_UAE", "whsec_uae");

    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });

    const body = Buffer.from(JSON.stringify(makeStripeEvent()));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=badsig")
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/signature/i) });
    // Attempted verification against BOTH configured secrets before rejecting.
    expect(mockConstructEvent).toHaveBeenCalledTimes(2);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when the stripe-signature header is missing", async () => {
    const body = Buffer.from(JSON.stringify(makeStripeEvent()));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/stripe-signature/i) });
    expect(mockConstructEvent).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when Stripe signature verification fails", async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });

    const body = Buffer.from(JSON.stringify(makeStripeEvent()));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=badsig")
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/signature/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is malformed JSON (even with a valid-looking signature header)", async () => {
    mockConstructEvent.mockImplementation((payload: unknown) => {
      const str = Buffer.isBuffer(payload) ? payload.toString("utf-8") : String(payload);
      JSON.parse(str);
      return makeStripeEvent();
    });

    // Send as a plain string so superagent transmits the raw bytes verbatim
    // (sending as Buffer would cause superagent to JSON-serialize it first).
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=validsig")
      .send("not valid json {{{");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/signature/i) });
    expect(mockConstructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      "t=123,v1=validsig",
      "whsec_fake456",
    );
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("marks the payment link as paid when checkout.session.completed has payment_status=paid", async () => {
    const publicToken = "deadbeefcafe1234";
    mockConstructEvent.mockReturnValue(makeStripeEvent("paid", publicToken));
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const body = Buffer.from(JSON.stringify(makeStripeEvent("paid", publicToken)));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=validsig")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'paid'/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    const [, params] = updateCall as [string, unknown[]];
    expect(params[0]).toBe(publicToken);
  });

  it("does NOT update the database when payment_status is not 'paid'", async () => {
    mockConstructEvent.mockReturnValue(makeStripeEvent("unpaid", "sometoken"));

    const body = Buffer.from(JSON.stringify(makeStripeEvent("unpaid", "sometoken")));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=validsig")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("does NOT update the database when the event type is not checkout.session.completed", async () => {
    mockConstructEvent.mockReturnValue({
      type: "payment_intent.created",
      data: { object: {} },
    });

    const body = Buffer.from("{}");
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=validsig")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns { received: true } and responds 200 on a successful paid event", async () => {
    mockConstructEvent.mockReturnValue(makeStripeEvent("paid", "testtoken123"));
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const body = Buffer.from(JSON.stringify(makeStripeEvent("paid", "testtoken123")));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=sig")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("handles a duplicate webhook for an already-paid link gracefully (rowCount 0)", async () => {
    const publicToken = "alreadypaidtoken";
    mockConstructEvent.mockReturnValue(makeStripeEvent("paid", publicToken));
    // Simulate the WHERE status = 'active' clause filtering out the already-paid row
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const body = Buffer.from(JSON.stringify(makeStripeEvent("paid", publicToken)));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=validsig")
      .send(body);

    // Must not crash — idempotent 200 response
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // The UPDATE must still have been attempted with the correct token...
    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    // ...and the SQL must include the status = 'active' guard
    const [sql, params] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params[0]).toBe(publicToken);
  });

  it("is a no-op when the payment link is in cancelled state (rowCount 0)", async () => {
    const publicToken = "cancelledlinktoken";
    mockConstructEvent.mockReturnValue(makeStripeEvent("paid", publicToken));
    // Simulate the WHERE status = 'active' clause filtering out the cancelled row
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const body = Buffer.from(JSON.stringify(makeStripeEvent("paid", publicToken)));
    const res = await request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=validsig")
      .send(body);

    // Must not crash — returns 200 as a no-op
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // The UPDATE must still have been attempted (the guard lives in SQL, not in app code)
    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    // The WHERE clause must include status = 'active' so cancelled rows are excluded
    const [sql, params] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params[0]).toBe(publicToken);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/paypal
// ---------------------------------------------------------------------------

function makePaypalBody(
  eventType: string,
  customId: string,
): Record<string, unknown> {
  return {
    event_type: eventType,
    resource: { custom_id: customId, status: "COMPLETED" },
  };
}

function stubFetchForPaypal(verificationStatus: "SUCCESS" | "FAILURE" = "SUCCESS") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/v1/oauth2/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "fake_access_token" }),
        };
      }
      if (String(url).includes("/v1/notifications/verify-webhook-signature")) {
        return {
          ok: true,
          json: async () => ({ verification_status: verificationStatus }),
        };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

const PAYPAL_HEADERS = {
  "Content-Type": "application/json",
  "paypal-transmission-id": "tid-12345",
  "paypal-transmission-sig": "sig-abc",
  "paypal-transmission-time": "2024-01-01T00:00:00Z",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-ID",
  "paypal-auth-algo": "SHA256withRSA",
};

describe("POST /webhooks/paypal — PayPal webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.stubEnv("PAYPAL_CLIENT_ID", "paypal_client_test");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "paypal_secret_test");
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "paypal_webhook_id_test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns 503 when PAYPAL_CLIENT_ID is not set", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");

    const body = makePaypalBody("PAYMENT.CAPTURE.COMPLETED", "token123");
    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringContaining("PayPal") });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 503 when PAYPAL_WEBHOOK_ID is not set", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");

    const body = makePaypalBody("PAYMENT.CAPTURE.COMPLETED", "token123");
    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/webhook.*id/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when the request body is empty", async () => {
    stubFetchForPaypal("SUCCESS");

    // supertest sends no body at all when no .send() is called,
    // so rawBody will be an empty Buffer (length 0) → handler returns 400.
    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS);

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when PayPal signature verification fails", async () => {
    stubFetchForPaypal("FAILURE");

    const body = makePaypalBody("PAYMENT.CAPTURE.COMPLETED", "token123");
    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/signature/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("marks the payment link as paid when PAYMENT.CAPTURE.COMPLETED is received and verified", async () => {
    stubFetchForPaypal("SUCCESS");
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const customId = "mypublictoken42";
    const body = makePaypalBody("PAYMENT.CAPTURE.COMPLETED", customId);

    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'paid'/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    const [, params] = updateCall as [string, unknown[]];
    expect(params[0]).toBe(customId);
  });

  it("does not mark an approved-but-uncaptured PayPal order as paid", async () => {
    stubFetchForPaypal("SUCCESS");
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const customId = "orderapprovedtoken99";
    const body = makePaypalBody("CHECKOUT.ORDER.APPROVED", customId);

    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'paid'/i.test(sql),
    );
    expect(updateCall).toBeUndefined();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("falls back to purchase_units[0].custom_id when resource.custom_id is absent", async () => {
    stubFetchForPaypal("SUCCESS");
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const customId = "fallbacktoken77";
    const body = {
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        status: "COMPLETED",
        purchase_units: [{ custom_id: customId }],
      },
    };

    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    expect(res.status).toBe(200);

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'paid'/i.test(sql),
    );
    expect(updateCall).toBeDefined();
    const [, params] = updateCall as [string, unknown[]];
    expect(params[0]).toBe(customId);
  });

  it("returns 400 when the body is malformed JSON before verification is attempted", async () => {
    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send("not valid json {{{");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/json/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("does NOT update the database for an unrecognised event type", async () => {
    stubFetchForPaypal("SUCCESS");

    const body = {
      event_type: "PAYMENT.SALE.REFUNDED",
      resource: { custom_id: "sometoken" },
    };

    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns { received: true } and responds 200 on a successful verified event", async () => {
    stubFetchForPaypal("SUCCESS");
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const body = makePaypalBody("PAYMENT.CAPTURE.COMPLETED", "token_ok");

    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });

  it("handles a duplicate webhook for an already-paid link gracefully (rowCount 0)", async () => {
    stubFetchForPaypal("SUCCESS");
    // Simulate the WHERE status = 'active' clause filtering out the already-paid row
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const customId = "alreadypaidpaypaltoken";
    const body = makePaypalBody("PAYMENT.CAPTURE.COMPLETED", customId);

    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    // Must not crash — idempotent 200 response
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // The UPDATE must still have been attempted with the correct token...
    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    // ...and the SQL must include the status = 'active' guard
    const [sql, params] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params[0]).toBe(customId);
  });

  it("is a no-op when the payment link is in cancelled state (rowCount 0)", async () => {
    stubFetchForPaypal("SUCCESS");
    // Simulate the WHERE status = 'active' clause filtering out the cancelled row
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const customId = "cancelledpaypaltoken";
    const body = makePaypalBody("PAYMENT.CAPTURE.COMPLETED", customId);

    const res = await request(app)
      .post("/webhooks/paypal")
      .set(PAYPAL_HEADERS)
      .send(body);

    // Must not crash — returns 200 as a no-op
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // The UPDATE must still have been attempted (the guard lives in SQL, not in app code)
    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    // The WHERE clause must include status = 'active' so cancelled rows are excluded
    const [sql, params] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params[0]).toBe(customId);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/mamo
// ---------------------------------------------------------------------------

const MAMO_WEBHOOK_SECRET = "mamo_test_secret";

function makeMamoPayload(event: string, referenceId: string): string {
  return JSON.stringify({ event, data: { reference_id: referenceId, status: "captured" } });
}

describe("POST /webhooks/mamo — Mamo webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.stubEnv("MAMO_API_KEY", "mamo_api_key_test");
    vi.stubEnv("MAMO_WEBHOOK_SECRET", MAMO_WEBHOOK_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 503 when MAMO_API_KEY is not set", async () => {
    delete process.env.MAMO_API_KEY;

    const body = makeMamoPayload("charge.succeeded", "tok1");
    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send(body);

    expect(res.status).toBe(503);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 503 when MAMO_WEBHOOK_SECRET is not set", async () => {
    delete process.env.MAMO_WEBHOOK_SECRET;

    const body = makeMamoPayload("charge.succeeded", "tok2");
    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send(body);

    expect(res.status).toBe(503);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when the request body is empty", async () => {
    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET);

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const body = makeMamoPayload("charge.succeeded", "tok3");
    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/authorization/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 401 when the Authorization header has the wrong value", async () => {
    const body = makeMamoPayload("charge.succeeded", "tok4");
    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", "wrong_secret_value")
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/authorization/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("marks the payment link as paid when charge.succeeded is received with the correct Authorization header", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const publicToken = "aabbccddeeff00112233445566778899";
    const body = makeMamoPayload("charge.succeeded", publicToken);

    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'paid'/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    const [, params] = updateCall as [string, unknown[]];
    expect(params[0]).toBe(publicToken);
  });

  it("marks the payment link as paid when subscription.succeeded is received with the correct Authorization header", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const publicToken = "subscriptiontoken123456789abcdef";
    const body = makeMamoPayload("subscription.succeeded", publicToken);

    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) &&
      /status\s*=\s*'paid'/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    const [, params] = updateCall as [string, unknown[]];
    expect(params[0]).toBe(publicToken);
  });

  it("returns 401 when the Authorization header is the correct secret with an extra character appended", async () => {
    const body = makeMamoPayload("charge.succeeded", "extrachartoken1234567890abcdef0");
    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", `${MAMO_WEBHOOK_SECRET}x`)
      .send(body);

    expect(res.status).toBe(401);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("does NOT update the database for an unrecognised event type (charge.failed)", async () => {
    const body = makeMamoPayload("charge.failed", "sometoken");

    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("does NOT update the database for the old placeholder event name 'payment.completed'", async () => {
    const body = makeMamoPayload("payment.completed", "sometoken");

    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("handles a duplicate webhook for an already-paid link gracefully (rowCount 0)", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const publicToken = "alreadypaidmamotoken123456789012";
    const body = makeMamoPayload("charge.succeeded", publicToken);

    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    const [sql, params] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params[0]).toBe(publicToken);
  });

  it("is a no-op when the payment link is in cancelled state (rowCount 0)", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const publicToken = "cancelledmamotoken12345678901234";
    const body = makeMamoPayload("charge.succeeded", publicToken);

    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql),
    );
    expect(updateCall).toBeDefined();

    const [sql, params] = updateCall as [string, unknown[]];
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params[0]).toBe(publicToken);
  });

  it("returns 400 and does not touch the database when the body is invalid JSON", async () => {
    const res = await request(app)
      .post("/webhooks/mamo")
      .set("Content-Type", "application/json")
      .set("Authorization", MAMO_WEBHOOK_SECRET)
      .send("not-json");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/json/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /pay/:token — token format acceptance
// ---------------------------------------------------------------------------

describe("GET /pay/:token — token format acceptance", () => {
  const LINK_ROW = {
    id: 1,
    amount: 1000,
    currency: "USD",
    provider: "stripe",
    description: null,
    country: "United Arab Emirates",
    status: "active",
    provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_123",
    public_token: "ignored",
    created_at: new Date().toISOString(),
    paid_at: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("accepts a legacy 32-char hex token and queries by exact match", async () => {
    const legacyToken = "0123456789abcdef0123456789abcdef";
    mockDbQuery.mockResolvedValue({ rows: [{ ...LINK_ROW, public_token: legacyToken }], rowCount: 1 });

    const res = await request(app).get(`/pay/${legacyToken}`);

    expect(res.status).toBe(200);
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(legacyToken);
  });

  it("accepts a new short 9-char base62 token", async () => {
    const shortToken = "Ab3xY9zQ1";
    mockDbQuery.mockResolvedValue({ rows: [{ ...LINK_ROW, public_token: shortToken }], rowCount: 1 });

    const res = await request(app).get(`/pay/${shortToken}`);

    expect(res.status).toBe(200);
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe(shortToken);
  });

  it("returns the stored destination country used for conversion routing", async () => {
    const token = "Cyprus001";
    mockDbQuery.mockResolvedValue({
      rows: [{ ...LINK_ROW, public_token: token, country: "Cyprus" }],
      rowCount: 1,
    });

    const res = await request(app).get(`/pay/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.country).toBe("Cyprus");
  });

  it("returns 404 when no link matches the token", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app).get("/pay/Ab3xY9zQ1");

    expect(res.status).toBe(404);
  });

  it("rejects a token that is too short without touching the database", async () => {
    const res = await request(app).get("/pay/abc1234");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/invalid token/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects a token with invalid characters without touching the database", async () => {
    const res = await request(app).get(`/pay/${encodeURIComponent("abc$%^123!")}`);

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects a token longer than 64 characters without touching the database", async () => {
    const res = await request(app).get(`/pay/${"a".repeat(65)}`);

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/stripe — hardened event handling
// ---------------------------------------------------------------------------

function makeStripeSessionEvent(overrides: {
  type?: string;
  paymentStatus?: string;
  publicToken?: string | null;
  sessionId?: string;
  metadata?: Record<string, string> | null;
} = {}): object {
  const {
    type = "checkout.session.completed",
    paymentStatus = "paid",
    publicToken = "tok_default",
    sessionId = "cs_test_session1",
    metadata,
  } = overrides;
  return {
    type,
    data: {
      object: {
        id: sessionId,
        payment_status: paymentStatus,
        metadata: metadata !== undefined
          ? metadata
          : publicToken !== null
            ? { public_token: publicToken }
            : null,
      },
    },
  };
}

describe("POST /webhooks/stripe — hardened event handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fake456");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function postWebhook() {
    return request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=validsig")
      .send(Buffer.from("{}"));
  }

  it("marks the link as paid on checkout.session.async_payment_succeeded", async () => {
    mockConstructEvent.mockReturnValue(
      makeStripeSessionEvent({
        type: "checkout.session.async_payment_succeeded",
        publicToken: "asynctoken1",
      }),
    );
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) && /public_token\s*=\s*\$1/i.test(sql),
    );
    expect(updateCall).toBeDefined();
    const [, params] = updateCall as [string, unknown[]];
    expect(params[0]).toBe("asynctoken1");
  });

  it("falls back to matching by provider_link_id when metadata.public_token is missing", async () => {
    mockConstructEvent.mockReturnValue(
      makeStripeSessionEvent({ metadata: null, sessionId: "cs_fallback_1" }),
    );
    mockDbQuery.mockResolvedValue({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    const fallbackCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links/i.test(sql) && /provider_link_id\s*=\s*\$1/i.test(sql),
    );
    expect(fallbackCall).toBeDefined();
    const [sql, params] = fallbackCall as [string, unknown[]];
    expect(sql).toMatch(/provider\s*=\s*'stripe'/i);
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params[0]).toBe("cs_fallback_1");
  });

  it("falls back to provider_link_id when the public_token UPDATE matches no rows", async () => {
    mockConstructEvent.mockReturnValue(
      makeStripeSessionEvent({ publicToken: "staletoken", sessionId: "cs_fallback_2" }),
    );
    // First UPDATE (by token) matches nothing; second (by session id) matches 1
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ sender_email: null, amount: 0, currency: "AED", description: null }], rowCount: 1 });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mockDbQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/provider_link_id\s*=\s*\$1/i);
    expect(params[0]).toBe("cs_fallback_2");
  });

  it("logs a warning when a paid event matches no payment link", async () => {
    const { logger } = await import("../lib/logger");
    mockConstructEvent.mockReturnValue(
      makeStripeSessionEvent({ publicToken: "unknowntoken", sessionId: "cs_unmatched" }),
    );
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "checkout.session.completed",
        sessionId: "cs_unmatched",
        publicTokenPresent: true,
        paymentStatus: "paid",
      }),
      expect.stringMatching(/no payment link was updated/i),
    );
  });

  it("logs a warning with details when payment_status is not paid", async () => {
    const { logger } = await import("../lib/logger");
    mockConstructEvent.mockReturnValue(
      makeStripeSessionEvent({ paymentStatus: "unpaid", sessionId: "cs_unpaid_1" }),
    );

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "checkout.session.completed",
        sessionId: "cs_unpaid_1",
        paymentStatus: "unpaid",
      }),
      expect.stringMatching(/not 'paid'/i),
    );
  });

  it("logs a warning for unhandled event types", async () => {
    const { logger } = await import("../lib/logger");
    mockConstructEvent.mockReturnValue({
      type: "payment_intent.created",
      data: { object: {} },
    });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "payment_intent.created" }),
      expect.stringMatching(/unhandled event type/i),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /pay/:token — Stripe reconciliation on the public pay page
// ---------------------------------------------------------------------------

describe("GET /pay/:token — Stripe reconciliation", () => {
  const TOKEN = "Ab3xY9zQ1";
  const ACTIVE_STRIPE_ROW = {
    id: 7,
    amount: 5000,
    currency: "USD",
    provider: "stripe",
    description: null,
    status: "active",
    provider_link_id: "cs_test_recon1",
    provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_recon1",
    public_token: TOKEN,
    created_at: new Date().toISOString(),
    paid_at: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcileStripeLink.mockResolvedValue({ paid: false, paidAt: null });
  });

  it("returns paid status when reconciliation flips the link", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ ...ACTIVE_STRIPE_ROW }], rowCount: 1 });
    const paidAt = "2026-07-02T09:30:00.000Z";
    mockReconcileStripeLink.mockResolvedValue({ paid: true, paidAt });

    const res = await request(app).get(`/pay/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockReconcileStripeLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, provider_link_id: "cs_test_recon1" }),
    );
    expect(res.body.status).toBe("paid");
    expect(res.body.paid_at).toBe(paidAt);
    // A paid link must not expose a checkout URL
    expect(res.body.checkout_url).toBeNull();
  });

  it("serves the stored active state when reconciliation reports not paid", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ ...ACTIVE_STRIPE_ROW }], rowCount: 1 });

    const res = await request(app).get(`/pay/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.checkout_url).toBe(ACTIVE_STRIPE_ROW.provider_checkout_url);
  });

  it("fails open and serves the stored state when reconciliation throws", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ ...ACTIVE_STRIPE_ROW }], rowCount: 1 });
    mockReconcileStripeLink.mockRejectedValue(new Error("stripe timeout"));

    const res = await request(app).get(`/pay/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("does not reconcile non-Stripe links", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ ...ACTIVE_STRIPE_ROW, provider: "paypal", provider_link_id: "ORDER1" }],
      rowCount: 1,
    });

    const res = await request(app).get(`/pay/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockReconcileStripeLink).not.toHaveBeenCalled();
  });

  it("does not reconcile already-paid links", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ ...ACTIVE_STRIPE_ROW, status: "paid", paid_at: "2026-07-01T00:00:00.000Z" }],
      rowCount: 1,
    });

    const res = await request(app).get(`/pay/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(mockReconcileStripeLink).not.toHaveBeenCalled();
  });

  it("does not reconcile links without a stored provider_link_id", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ ...ACTIVE_STRIPE_ROW, provider_link_id: null }],
      rowCount: 1,
    });

    const res = await request(app).get(`/pay/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockReconcileStripeLink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/stripe — contact upsert from session.customer_details
// ---------------------------------------------------------------------------

describe("POST /webhooks/stripe — contact upsert from customer_details", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertContact.mockResolvedValue("contact-uuid-1");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fake456");
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET_UAE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function postStripeWebhook(event: object) {
    return request(app)
      .post("/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=123,v1=sig")
      .send(Buffer.from(JSON.stringify(event)));
  }

  it("upserts a contact from session.customer_details.email when the link has no sender_email", async () => {
    const publicToken = "nosendemail1234567";
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_nomail1",
          payment_status: "paid",
          metadata: { public_token: publicToken },
          customer_details: { email: "stripe@example.com", name: "Jane Doe" },
        },
      },
    });
    // First db.query: UPDATE marking link paid (no sender_email in DB)
    // Second db.query: UPDATE back-filling sender_email from Stripe
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 42,
          sender_first_name: null,
          sender_last_name: null,
          sender_email: null,
          sender_phone: null,
          sender_phone_country_code: null,
          workspace_owner_id: "ws1",
          amount: 1000,
          currency: "USD",
          description: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // back-fill UPDATE

    const res = await postStripeWebhook({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    // Back-fill UPDATE must set sender_email to the Stripe-provided address
    const backFillCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links\s+SET\s+sender_email/i.test(sql),
    );
    expect(backFillCall).toBeDefined();
    const [, bfParams] = backFillCall as [string, unknown[]];
    expect(bfParams[0]).toBe("stripe@example.com");

    // upsertContact must be called with the Stripe-provided email
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ email: "stripe@example.com" }),
    );
  });

  it("also saves the parsed first/last name from customer_details.name", async () => {
    const publicToken = "nameenrich1234567x";
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_name_enrich",
          payment_status: "paid",
          metadata: { public_token: publicToken },
          customer_details: { email: "name@example.com", name: "Alice Smith" },
        },
      },
    });
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 55,
          sender_first_name: null,
          sender_last_name: null,
          sender_email: null,
          sender_phone: null,
          sender_phone_country_code: null,
          workspace_owner_id: "ws2",
          amount: 500,
          currency: "AED",
          description: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await postStripeWebhook({});

    // The back-fill UPDATE SQL must include sender_first_name and sender_last_name
    const backFillCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links\s+SET\s+sender_email/i.test(sql),
    );
    expect(backFillCall).toBeDefined();
    const [sql, params] = backFillCall as [string, unknown[]];
    expect(sql).toMatch(/sender_first_name/i);
    expect(sql).toMatch(/sender_last_name/i);
    expect(params).toContain("Alice");
    expect(params).toContain("Smith");
  });

  it("does NOT back-fill or upsert when the link already has a sender_email", async () => {
    const publicToken = "hassenderemail1234";
    mockConstructEvent.mockReturnValue({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_has_email",
          payment_status: "paid",
          metadata: { public_token: publicToken },
          customer_details: { email: "stripe@example.com", name: "Jane" },
        },
      },
    });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 77,
        sender_first_name: "Bob",
        sender_last_name: null,
        sender_email: "presaved@example.com",
        sender_phone: null,
        sender_phone_country_code: null,
        workspace_owner_id: "ws3",
        amount: 2000,
        currency: "USD",
        description: null,
      }],
      rowCount: 1,
    });

    const res = await postStripeWebhook({});
    expect(res.status).toBe(200);

    // Only one db.query call (the mark-paid UPDATE); no back-fill UPDATE
    const backFillCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+payment_links\s+SET\s+sender_email/i.test(sql),
    );
    expect(backFillCall).toBeUndefined();

    // upsertContact is still called (with the existing pre-saved email)
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({ email: "presaved@example.com" }),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /pay/:token/sender
// ---------------------------------------------------------------------------

describe("POST /pay/:token/sender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpsertContact.mockResolvedValue("contact-uuid-2");
  });

  it("accepts and saves sender details on an active link (status=active)", async () => {
    const token = "activelinktoken123";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 10, status: "active" }], rowCount: 1 }) // SELECT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

    const res = await request(app)
      .post(`/pay/${token}/sender`)
      .set("Content-Type", "application/json")
      .send({ email: "sender@example.com", first_name: "Sender" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // On an active (not-yet-paid) link, no contact upsert is triggered
    expect(mockUpsertContact).not.toHaveBeenCalled();
  });

  it("accepts sender details on a paid link, saves them, and upserts a contact", async () => {
    const token = "paidlinktoken12345";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 99, status: "paid" }], rowCount: 1 }) // SELECT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE sender fields
      .mockResolvedValueOnce({                          // SELECT full row
        rows: [{
          id: 99,
          sender_first_name: "Alice",
          sender_last_name: null,
          sender_email: "alice@example.com",
          sender_phone: null,
          sender_phone_country_code: null,
          workspace_owner_id: "ws-paid",
          amount: 500,
          currency: "USD",
          description: null,
        }],
        rowCount: 1,
      });

    const res = await request(app)
      .post(`/pay/${token}/sender`)
      .set("Content-Type", "application/json")
      .send({ email: "alice@example.com", first_name: "Alice" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // upsertContact must have been called with the submitted email
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "alice@example.com",
        workspaceOwnerId: "ws-paid",
      }),
    );
  });

  it("returns 409 when the link status is 'expired'", async () => {
    const token = "expiredlinktoken12";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 55, status: "expired" }], rowCount: 1 });

    const res = await request(app)
      .post(`/pay/${token}/sender`)
      .set("Content-Type", "application/json")
      .send({ email: "test@example.com" });

    expect(res.status).toBe(409);
    expect(mockUpsertContact).not.toHaveBeenCalled();
  });

  it("returns 409 when the link status is 'deleted'", async () => {
    const token = "deletedlinktoken12";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 66, status: "deleted" }], rowCount: 1 });

    const res = await request(app)
      .post(`/pay/${token}/sender`)
      .set("Content-Type", "application/json")
      .send({ email: "test@example.com" });

    expect(res.status).toBe(409);
    expect(mockUpsertContact).not.toHaveBeenCalled();
  });

  it("returns 404 when no link matches the token", async () => {
    const token = "nosuchlinktoken12x";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post(`/pay/${token}/sender`)
      .set("Content-Type", "application/json")
      .send({ email: "test@example.com" });

    expect(res.status).toBe(404);
  });

  it("returns 400 when no sender field is provided", async () => {
    const token = "validtokenformat12";
    // No db call expected for an empty payload
    const res = await request(app)
      .post(`/pay/${token}/sender`)
      .set("Content-Type", "application/json")
      .send({});

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

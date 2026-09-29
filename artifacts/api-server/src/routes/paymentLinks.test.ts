import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockDbQuery, mockStripeSessionCreate, mockStripeConstructor, stubWorkspaceRole, stubAllowedPages } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockStripeSessionCreate: vi.fn(),
  mockStripeConstructor: vi.fn(),
  stubWorkspaceRole: { value: "owner" as "owner" | "member" },
  stubAllowedPages: { value: [] as string[] },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_abc";
    wreq.workspaceRole = stubWorkspaceRole.value;
    wreq.allowedPages = stubWorkspaceRole.value === "owner" ? null : stubAllowedPages.value;
    wreq.memberDbId = 1;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  logPageAccessDenial: vi.fn(),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) },
  },
}));

vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        create: (...args: unknown[]) => mockStripeSessionCreate(...args),
      },
    };
    constructor(...args: unknown[]) {
      mockStripeConstructor(...args);
    }
  }
  return { default: MockStripe };
});

import paymentLinksRouter, {
  validateMaxPaymentAmountEnv,
  fetchMamoWithRetry,
  isMamoNetworkError,
  generatePublicToken,
  buildPublicPayUrl,
  PUBLIC_TOKEN_LENGTH,
} from "./paymentLinks";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

/**
 * All country values used across tests. Returned by the settings mock so that
 * validation passes in tests that are not specifically testing country rejection.
 */
const ALL_TEST_COUNTRIES = [
  "Lebanon",
  "United Arab Emirates",
  "UAE",
  "Qatar",
  "Saudi Arabia",
  "Denmark",
  "US",
  "UK",
];

/** A resolved settings row that allows all countries used in the test suite. */
const SETTINGS_MOCK_WIDE = { rows: [{ available_countries: ALL_TEST_COUNTRIES }], rowCount: 1 };

/** Mock result for the public-token uniqueness check (no collision). */
const TOKEN_FREE_MOCK = { rows: [], rowCount: 0 };

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLogError = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: typeof mockReqLogError; warn: typeof mockReqLogError; info: typeof mockReqLogError } }).log = {
      error: mockReqLogError,
      warn: mockReqLogError,
      info: mockReqLogError,
    };
    next();
  });
  app.use(paymentLinksRouter);
  return app;
}

const app = makeApp();

beforeEach(() => {
  stubWorkspaceRole.value = "owner";
  stubAllowedPages.value = [];
});

describe("GET /payment-links — page permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceRole.value = "owner";
    stubAllowedPages.value = [];
  });

  it("preserves owner access", async () => {
    const res = await request(app).get("/payment-links");
    expect(res.status).toBe(200);
  });

  it("allows a member granted payment-links", async () => {
    stubWorkspaceRole.value = "member";
    stubAllowedPages.value = ["payment-links"];
    const res = await request(app).get("/payment-links");
    expect(res.status).toBe(200);
  });

  it("denies a member without payment-links before querying", async () => {
    stubWorkspaceRole.value = "member";
    stubAllowedPages.value = ["cmc-pos-dashboard"];
    const res = await request(app).get("/payment-links");
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("GET /payment-links — response validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
  });

  it("returns 500 and logs when a row fails response validation", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          workspace_owner_id: "owner_abc",
          amount: "10.00",
          currency: "USD",
          provider: "stripe",
          description: null,
          country: null,
          // status should be string but null here triggers Zod failure
          status: null,
          provider_link_id: null,
          provider_checkout_url: null,
          public_token: "tok",
          public_url: "https://example.com/p/tok",
          created_at: new Date().toISOString(),
          paid_at: null,
          created_by_member_id: null,
          creator_clerk_id: null,
        },
      ],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/payment-links");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /payment-links", err: expect.any(Array) }),
      "Response validation failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubFetchForPaypal(overrides: {
  tokenOk?: boolean;
  orderOk?: boolean;
  orderBody?: object;
  orderErrorText?: string;
} = {}) {
  const {
    tokenOk = true,
    orderOk = true,
    orderBody = {
      id: "PAYPAL_ORDER_123",
      links: [{ rel: "approve", href: "https://paypal.com/checkout/approve?token=PAYPAL_ORDER_123" }],
    },
    orderErrorText,
  } = overrides;

  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/v1/oauth2/token")) {
        if (!tokenOk) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ access_token: "fake_token" }) };
      }
      if (String(url).includes("/v2/checkout/orders")) {
        if (!orderOk) {
          return {
            ok: false,
            text: async () => orderErrorText ?? JSON.stringify({ message: "Currency is not supported", details: [] }),
          };
        }
        return { ok: true, json: async () => orderBody };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
}

function stubStripeSuccess() {
  mockStripeSessionCreate.mockResolvedValue({
    id: "cs_test_STRIPE123",
    url: "https://checkout.stripe.com/pay/cs_test_STRIPE123",
  });
}

function stubStripeError(message: string) {
  mockStripeSessionCreate.mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// Currency support matrix documentation
// ---------------------------------------------------------------------------

/**
 * This table documents the full currency × provider support matrix for the 12
 * currencies offered in the UI. Tests below verify the enforced combinations.
 *
 * Currency | Stripe | PayPal | Notes
 * ---------|--------|--------|------
 * USD      |  YES   |  YES   | Universal
 * EUR      |  YES   |  YES   | Universal
 * GBP      |  YES   |  YES   | Universal
 * AUD      |  YES   |  YES   |
 * CAD      |  YES   |  YES   |
 * CHF      |  YES   |  YES   |
 * SEK      |  YES   |  YES   |
 * AED      |  YES   |  NO    | Gulf currency; not in PayPal settlement list
 * QAR      |  YES   |  NO    | Gulf currency; not in PayPal settlement list
 * SAR      |  YES   |  NO    | Gulf currency; not in PayPal settlement list
 * DKK      |  YES   |  NO    | Excluded from PayPal cross-border transfers
 * LBP      |  NO    |  NO    | Lebanese Pound; not accepted by either provider
 */

// ---------------------------------------------------------------------------
// POST /payment-links — currency × provider validation
// ---------------------------------------------------------------------------

describe("POST /payment-links — per-provider currency validation", () => {
  const INSERT_ROW = { id: 1, workspace_owner_id: "owner_abc", amount: 1000, currency: "USD", provider: "stripe", description: null, status: "active", provider_link_id: "cs_test_STRIPE123", provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_STRIPE123", public_token: "tok", created_at: new Date().toISOString(), paid_at: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbQuery.mockReset();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("PAYPAL_CLIENT_ID", "paypal_client_test");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "paypal_secret_test");
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValue({ rows: [INSERT_ROW] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ---- LBP — not supported by either provider ----

  it("returns 422 for LBP + stripe with a user-friendly message", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "LBP", provider: "stripe" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/LBP/);
    expect(res.body.error).toMatch(/not supported by Stripe/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns 422 for LBP + paypal with a user-friendly message", async () => {
    stubFetchForPaypal();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "LBP", provider: "paypal" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/LBP/);
    expect(res.body.error).toMatch(/not supported by PayPal/i);
  });

  // ---- Gulf currencies — PayPal rejects, Stripe accepts ----

  it("returns 422 for AED + paypal", async () => {
    stubFetchForPaypal();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "paypal" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/AED/);
    expect(res.body.error).toMatch(/not supported by PayPal/i);
  });

  it("accepts AED + stripe and calls the Stripe API", async () => {
    stubStripeSuccess();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "stripe", country: "UAE" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
    const [callArg] = mockStripeSessionCreate.mock.calls[0] as [{ line_items: { price_data: { currency: string } }[] }];
    expect(callArg.line_items[0].price_data.currency).toBe("aed");
  });

  it("returns 422 for QAR + paypal", async () => {
    stubFetchForPaypal();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "QAR", provider: "paypal" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/QAR/);
    expect(res.body.error).toMatch(/not supported by PayPal/i);
  });

  it("accepts QAR + stripe and calls the Stripe API", async () => {
    stubStripeSuccess();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "QAR", provider: "stripe", country: "Qatar" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
  });

  it("returns 422 for SAR + paypal", async () => {
    stubFetchForPaypal();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "SAR", provider: "paypal" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/SAR/);
    expect(res.body.error).toMatch(/not supported by PayPal/i);
  });

  it("accepts SAR + stripe and calls the Stripe API", async () => {
    stubStripeSuccess();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "SAR", provider: "stripe", country: "Saudi Arabia" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
  });

  it("returns 422 for DKK + paypal", async () => {
    stubFetchForPaypal();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "DKK", provider: "paypal" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/DKK/);
    expect(res.body.error).toMatch(/not supported by PayPal/i);
  });

  it("accepts DKK + stripe and calls the Stripe API", async () => {
    stubStripeSuccess();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "DKK", provider: "stripe", country: "Denmark" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
  });

  // ---- Universal currencies — both providers accept ----

  it.each(["USD", "EUR", "GBP", "AUD", "CAD", "CHF", "SEK"])(
    "accepts %s + stripe",
    async (currency) => {
      stubStripeSuccess();
      const res = await request(app)
        .post("/payment-links")
        .send({ amount: 10, currency, provider: "stripe", country: "US" });

      expect(res.status).toBe(201);
      expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
    },
  );

  it.each(["USD", "EUR", "GBP", "AUD", "CAD", "CHF", "SEK"])(
    "accepts %s + paypal",
    async (currency) => {
      stubFetchForPaypal();
      const res = await request(app)
        .post("/payment-links")
        .send({ amount: 10, currency, provider: "paypal", country: "US" });

      expect(res.status).toBe(201);
    },
  );
});

// ---------------------------------------------------------------------------
// POST /payment-links — country-aware Stripe account selection (UAE)
// ---------------------------------------------------------------------------

describe("POST /payment-links — UAE Stripe account routing", () => {
  const INSERT_ROW = { id: 1, workspace_owner_id: "owner_abc", amount: 1000, currency: "AED", provider: "stripe", description: null, status: "active", provider_link_id: "cs_test_STRIPE123", provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_STRIPE123", public_token: "tok", created_at: new Date().toISOString(), paid_at: null };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_default");
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "sk_test_uae");
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValue({ rows: [INSERT_ROW] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the UAE Stripe key when country is United Arab Emirates", async () => {
    stubStripeSuccess();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "stripe", country: "United Arab Emirates" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
    // The Stripe client must have been constructed with the UAE secret key.
    const uaeCtor = mockStripeConstructor.mock.calls.find(([key]: [string]) => key === "sk_test_uae");
    expect(uaeCtor).toBeDefined();
    expect(mockStripeConstructor.mock.calls.some(([key]: [string]) => key === "sk_test_default")).toBe(false);
  });

  it("uses the default Stripe key for non-UAE countries", async () => {
    stubStripeSuccess();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "Lebanon" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
    const defaultCtor = mockStripeConstructor.mock.calls.find(([key]: [string]) => key === "sk_test_default");
    expect(defaultCtor).toBeDefined();
    expect(mockStripeConstructor.mock.calls.some(([key]: [string]) => key === "sk_test_uae")).toBe(false);
  });

  it("returns 503 with a UAE-specific error when STRIPE_SECRET_KEY_UAE is missing", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "");
    stubStripeSuccess();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "stripe", country: "United Arab Emirates" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/STRIPE_SECRET_KEY_UAE/);
    expect(res.body.error).toMatch(/United Arab Emirates/i);
    // Must NOT silently fall back to the default account.
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns 503 mentioning the default key when STRIPE_SECRET_KEY is missing for a non-UAE country", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    stubStripeSuccess();
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "Lebanon" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/STRIPE_SECRET_KEY/);
    expect(res.body.error).not.toMatch(/UAE/);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /payment-links — provider error message extraction
// ---------------------------------------------------------------------------

describe("POST /payment-links — provider error message forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbQuery.mockReset();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("PAYPAL_CLIENT_ID", "paypal_client_test");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "paypal_secret_test");
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce(TOKEN_FREE_MOCK);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("includes the Stripe error message in the 502 response instead of a generic error", async () => {
    stubStripeError("No such currency: 'xyz'");
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Stripe rejected this request/i);
    expect(res.body.error).toMatch(/No such currency/i);
  });

  it("returns a generic Stripe 502 message when the thrown error has no message", async () => {
    mockStripeSessionCreate.mockRejectedValue("non-error string");
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Failed to create Stripe checkout session/i);
  });

  it("includes the PayPal details message in the 502 response when the API returns a JSON error body", async () => {
    stubFetchForPaypal({
      orderOk: false,
      orderErrorText: JSON.stringify({
        name: "INVALID_REQUEST",
        message: "Request is not well-formed",
        details: [{ description: "Currency code is invalid." }],
      }),
    });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "paypal", country: "US" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/PayPal rejected this request/i);
    expect(res.body.error).toMatch(/Currency code is invalid/i);
  });

  it("falls back to the PayPal message field when details is absent", async () => {
    stubFetchForPaypal({
      orderOk: false,
      orderErrorText: JSON.stringify({
        name: "UNPROCESSABLE_ENTITY",
        message: "The requested action could not be performed.",
      }),
    });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "paypal", country: "US" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/PayPal rejected this request/i);
    expect(res.body.error).toMatch(/could not be performed/i);
  });

  it("returns a generic PayPal 502 message when the error body is not JSON", async () => {
    stubFetchForPaypal({
      orderOk: false,
      orderErrorText: "Internal Server Error",
    });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "paypal", country: "US" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Failed to create PayPal order/i);
  });
});

// ---------------------------------------------------------------------------
// POST /payment-links — basic input validation (regression coverage)
// ---------------------------------------------------------------------------

describe("POST /payment-links — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbQuery.mockReset();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce(TOKEN_FREE_MOCK);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 400 when currency is not in the supported list", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "XYZ", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/currency must be one of/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when provider is not recognised", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "bitcoin" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider must be one of/i);
  });

  it("returns 400 when amount is missing", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/amount/i);
  });

  it("returns 400 when amount has more than 2 decimal places", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10.999, currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 decimal places/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when amount has 3 decimal places sent as a string", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: "9.123", currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 decimal places/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when amount is in scientific notation that represents sub-cent precision", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: "1e-3", currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when amount in scientific notation is sent as a JSON number", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 1e-3, currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("accepts amount with exactly 2 decimal places", async () => {
    stubStripeSuccess();
    mockDbQuery.mockResolvedValue({ rows: [{ id: 1, workspace_owner_id: "owner_abc", amount: 1099, currency: "USD", provider: "stripe", description: null, status: "active", provider_link_id: "cs_test_STRIPE123", provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_STRIPE123", public_token: "tok", created_at: new Date().toISOString(), paid_at: null }] });
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10.99, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
  });

  it("accepts a whole-number amount with no decimal point", async () => {
    stubStripeSuccess();
    mockDbQuery.mockResolvedValue({ rows: [{ id: 1, workspace_owner_id: "owner_abc", amount: 1000, currency: "USD", provider: "stripe", description: null, status: "active", provider_link_id: "cs_test_STRIPE123", provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_STRIPE123", public_token: "tok", created_at: new Date().toISOString(), paid_at: null }] });
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
  });

  it("returns 400 when amount exceeds the maximum allowed value", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 1000000, currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must not exceed/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns 400 for an extremely large amount", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 100000000, currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/suspiciously large/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("accepts an amount exactly at the maximum allowed value (999999.99)", async () => {
    stubStripeSuccess();
    mockDbQuery.mockResolvedValue({ rows: [{ id: 1, workspace_owner_id: "owner_abc", amount: 99999999, currency: "USD", provider: "stripe", description: null, status: "active", provider_link_id: "cs_test_STRIPE123", provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_STRIPE123", public_token: "tok", created_at: new Date().toISOString(), paid_at: null }] });
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 999999.99, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
  });

  it("returns 503 when Stripe is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/STRIPE_SECRET_KEY/i);
  });

  it("returns 503 when PayPal is not configured", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "paypal", country: "US" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/PAYPAL_CLIENT_ID/i);
  });

  it("uses the default cap (999999.99) when MAX_PAYMENT_AMOUNT_USD is not set", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 1000000, currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/999,999\.99/);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("rejects an amount above the cap when MAX_PAYMENT_AMOUNT_USD overrides the default", async () => {
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "500");
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 600, currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must not exceed/i);
    expect(res.body.error).toMatch(/500\.00/);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("accepts an amount that exceeds the default cap when MAX_PAYMENT_AMOUNT_USD is raised", async () => {
    stubStripeSuccess();
    mockDbQuery.mockResolvedValue({ rows: [{ id: 1, workspace_owner_id: "owner_abc", amount: 150000000, currency: "USD", provider: "stripe", description: null, status: "active", provider_link_id: "cs_test_STRIPE123", provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_STRIPE123", public_token: "tok", created_at: new Date().toISOString(), paid_at: null }] });
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "2000000");
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 1500000, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// validateMaxPaymentAmountEnv — startup validation
// ---------------------------------------------------------------------------

describe("validateMaxPaymentAmountEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not throw when MAX_PAYMENT_AMOUNT_USD is not set", () => {
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "");
    expect(() => validateMaxPaymentAmountEnv()).not.toThrow();
  });

  it("does not throw when MAX_PAYMENT_AMOUNT_USD is a valid positive number", () => {
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "5000");
    expect(() => validateMaxPaymentAmountEnv()).not.toThrow();
  });

  it("throws when MAX_PAYMENT_AMOUNT_USD is not a number", () => {
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "not-a-number");
    expect(() => validateMaxPaymentAmountEnv()).toThrow(/Invalid MAX_PAYMENT_AMOUNT_USD/);
  });

  it("throws when MAX_PAYMENT_AMOUNT_USD is zero", () => {
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "0");
    expect(() => validateMaxPaymentAmountEnv()).toThrow(/Invalid MAX_PAYMENT_AMOUNT_USD/);
  });

  it("throws when MAX_PAYMENT_AMOUNT_USD is negative", () => {
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "-100");
    expect(() => validateMaxPaymentAmountEnv()).toThrow(/Invalid MAX_PAYMENT_AMOUNT_USD/);
  });

  it("throws when MAX_PAYMENT_AMOUNT_USD is a partial numeric string like '500abc'", () => {
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "500abc");
    expect(() => validateMaxPaymentAmountEnv()).toThrow(/Invalid MAX_PAYMENT_AMOUNT_USD/);
  });

  it("throws when MAX_PAYMENT_AMOUNT_USD is 'Infinity'", () => {
    vi.stubEnv("MAX_PAYMENT_AMOUNT_USD", "Infinity");
    expect(() => validateMaxPaymentAmountEnv()).toThrow(/Invalid MAX_PAYMENT_AMOUNT_USD/);
  });
});

// ---------------------------------------------------------------------------
// POST /payment-links — country field
// ---------------------------------------------------------------------------

const STRIPE_ROW_BASE = {
  workspace_owner_id: "owner_abc",
  amount: 1000,
  currency: "USD",
  provider: "stripe",
  description: null,
  status: "active",
  provider_link_id: "cs_test_STRIPE123",
  provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_STRIPE123",
  public_token: "tok",
  created_at: new Date().toISOString(),
  paid_at: null,
};

describe("POST /payment-links — country field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbQuery.mockReset();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    stubStripeSuccess();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores country and returns it in the 201 response", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValueOnce({ rows: [{ id: 1, ...STRIPE_ROW_BASE, country: "UAE" }] });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "UAE" });

    expect(res.status).toBe(201);
    expect(res.body.payment_link.country).toBe("UAE");
  });

  it("returns 400 when country is omitted from the request", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country is required/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("returns 400 when an empty string country is sent", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country is required/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("passes country as a bound parameter to the database INSERT", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValueOnce({ rows: [{ id: 1, ...STRIPE_ROW_BASE, country: "UK" }] });

    await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "UK" });

    // settings lookup + token uniqueness check + INSERT
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
    const [sql, params] = mockDbQuery.mock.calls[2] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO payment_links/i);
    // country is bound at $6 in the INSERT statement
    expect(params[5]).toBe("UK");
  });

  it("returns 400 and does not reach the database when country is omitted", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country is required/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /payment-links — country allowlist validation
// ---------------------------------------------------------------------------

describe("POST /payment-links — country allowlist validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbQuery.mockReset();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    stubStripeSuccess();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 400 when country is not in the workspace's allowed list", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "France" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of the accepted values/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("error message for invalid country lists the accepted values", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "Germany" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Lebanon/);
    expect(res.body.error).toMatch(/United Arab Emirates/);
  });

  it("accepts a country that is in the workspace's allowed list", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValueOnce({ rows: [{ id: 1, ...STRIPE_ROW_BASE, country: "Lebanon" }] });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "Lebanon" });

    expect(res.status).toBe(201);
    expect(mockStripeSessionCreate).toHaveBeenCalledOnce();
  });

  it("falls back to the default list when no workspace_settings row exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "France" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Lebanon/);
    expect(res.body.error).toMatch(/United Arab Emirates/);
  });

  it("rejects 'Israel' with 400 'country is not supported' before consulting the allowlist", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "Israel" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("rejects ISO code 'IL' with 400 'country is not supported' before consulting the allowlist", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "IL" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });

  it("excludes 'Israel' from the accepted-values error message even when present in saved settings", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "Israel"] }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "Germany" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of the accepted values/i);
    expect(res.body.error).toContain("Lebanon");
    expect(res.body.error).not.toContain("Israel");
  });

  it("falls back to the default list when workspace_settings has null available_countries", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: null }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "Germany" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/country must be one of the accepted values/i);
    expect(res.body.error).toMatch(/Lebanon/);
  });

  it("accepts a country from the default list when settings row has null countries", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ available_countries: null }], rowCount: 1 })
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValueOnce({ rows: [{ id: 1, ...STRIPE_ROW_BASE, country: "Lebanon" }] });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "Lebanon" });

    expect(res.status).toBe(201);
  });

  it("does not call the provider API when country is rejected", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon"] }],
      rowCount: 1,
    });

    await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "United States" });

    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /payment-links — country field in response
// ---------------------------------------------------------------------------

const GET_ROW_BASE = {
  workspace_owner_id: "owner_abc",
  amount: 2500,
  currency: "USD",
  provider: "stripe",
  description: null,
  status: "active",
  provider_link_id: null,
  provider_checkout_url: null,
  public_token: "tok",
  created_at: new Date().toISOString(),
  paid_at: null,
  created_by_member_id: null,
  creator_clerk_id: null,
};

describe("GET /payment-links — country field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbQuery.mockReset();
  });

  it("returns country in the payment_links list", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ id: 1, ...GET_ROW_BASE, country: "UAE" }],
    });

    const res = await request(app).get("/payment-links");

    expect(res.status).toBe(200);
    expect(res.body.payment_links).toHaveLength(1);
    expect(res.body.payment_links[0].country).toBe("UAE");
  });

  it("returns null country when the column is null", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ id: 2, ...GET_ROW_BASE, country: null }],
    });

    const res = await request(app).get("/payment-links");

    expect(res.status).toBe(200);
    expect(res.body.payment_links[0].country).toBeNull();
  });

  it("returns country for multiple links", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [
        { id: 1, ...GET_ROW_BASE, country: "UAE" },
        { id: 2, ...GET_ROW_BASE, country: "UK", public_token: "tok2" },
      ],
    });

    const res = await request(app).get("/payment-links");

    expect(res.status).toBe(200);
    expect(res.body.payment_links[0].country).toBe("UAE");
    expect(res.body.payment_links[1].country).toBe("UK");
  });
});

// ---------------------------------------------------------------------------
// isMamoNetworkError — unit tests
// ---------------------------------------------------------------------------

describe("isMamoNetworkError", () => {
  it("returns true for ENOTFOUND errors", () => {
    const err = new Error("getaddrinfo ENOTFOUND api.mamopay.com");
    expect(isMamoNetworkError(err)).toBe(true);
  });

  it("returns true for fetch failed errors", () => {
    const err = new Error("fetch failed");
    expect(isMamoNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED errors", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    expect(isMamoNetworkError(err)).toBe(true);
  });

  it("returns true for AbortError by name", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(isMamoNetworkError(err)).toBe(true);
  });

  it("returns false for non-network errors", () => {
    expect(isMamoNetworkError(new Error("Unauthorized"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isMamoNetworkError("some string")).toBe(false);
    expect(isMamoNetworkError(null)).toBe(false);
    expect(isMamoNetworkError(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchMamoWithRetry — unit tests
// ---------------------------------------------------------------------------

describe("fetchMamoWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns the response on a successful first attempt", async () => {
    const fakeResp = { ok: true, status: 200 } as unknown as globalThis.Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(fakeResp));

    const result = await fetchMamoWithRetry("https://api.mamopay.com/v1/payment_links", { method: "POST" });

    expect(result).toBe(fakeResp);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once on a network error and returns the second response", async () => {
    const networkErr = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const fakeResp = { ok: true, status: 201 } as unknown as globalThis.Response;
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockRejectedValueOnce(networkErr)
        .mockResolvedValueOnce(fakeResp),
    );

    const result = await fetchMamoWithRetry("https://api.mamopay.com/v1/payment_links", { method: "POST" });

    expect(result).toBe(fakeResp);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on a non-network error and re-throws immediately", async () => {
    const authErr = new Error("401 Unauthorized");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(authErr));

    await expect(
      fetchMamoWithRetry("https://api.mamopay.com/v1/payment_links", { method: "POST" }),
    ).rejects.toThrow("401 Unauthorized");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a 4xx response — non-OK responses are returned, not thrown", async () => {
    const fakeResp = { ok: false, status: 422 } as unknown as globalThis.Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(fakeResp));

    const result = await fetchMamoWithRetry("https://api.mamopay.com/v1/payment_links", { method: "POST" });

    expect(result.status).toBe(422);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting two attempts when all attempts fail with a network error", async () => {
    const networkErr = new Error("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkErr));

    await expect(
      fetchMamoWithRetry("https://api.mamopay.com/v1/payment_links", { method: "POST" }),
    ).rejects.toThrow("fetch failed");

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("passes an AbortSignal to fetch so the timeout can fire", async () => {
    const fakeResp = { ok: true, status: 200 } as unknown as globalThis.Response;
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        capturedSignal = opts.signal as AbortSignal | undefined;
        return Promise.resolve(fakeResp);
      }),
    );

    await fetchMamoWithRetry("https://api.mamopay.com/v1/payment_links", { method: "POST" });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // Before 12 s the signal must still be live
    expect(capturedSignal!.aborted).toBe(false);
  });

  it("aborts the in-flight request after 12 seconds and retries successfully", async () => {
    vi.useFakeTimers();

    let firstSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockImplementationOnce((_url: string, opts: RequestInit) => {
          firstSignal = opts.signal as AbortSignal;
          return new Promise((_resolve, reject) => {
            firstSignal!.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
        })
        .mockResolvedValueOnce({ ok: true, status: 200 } as unknown as globalThis.Response),
    );

    const promise = fetchMamoWithRetry("https://api.mamopay.com/v1/payment_links", { method: "POST" });

    // Advance past the 12 s abort + 500 ms retry delay so the second fetch can start
    await vi.advanceTimersByTimeAsync(13_000);

    const result = await promise;
    expect(result.status).toBe(200);
    expect(firstSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// POST /payment-links — Mamo branch
// ---------------------------------------------------------------------------

describe("POST /payment-links — Mamo branch", () => {
  const INSERT_ROW = {
    id: 1,
    workspace_owner_id: "owner_abc",
    amount: 1000,
    currency: "AED",
    provider: "mamo",
    description: null,
    country: "UAE",
    status: "active",
    provider_link_id: "mamo_link_1",
    provider_checkout_url: "https://pay.mamopay.com/link/abc",
    public_token: "tok",
    created_at: new Date().toISOString(),
    paid_at: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubWorkspaceRole.value = "owner";
    vi.stubEnv("MAMO_API_KEY", "mamo_test_key");
    vi.stubEnv("MAMO_ENABLED", "true");
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValue({ rows: [INSERT_ROW] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns 503 when MAMO_ENABLED is 'false'", async () => {
    vi.stubEnv("MAMO_ENABLED", "false");

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "mamo", country: "UAE" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/mamo is currently disabled/i);
  });

  it("returns 503 when MAMO_API_KEY is missing", async () => {
    vi.stubEnv("MAMO_API_KEY", "");

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "mamo", country: "UAE" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/MAMO_API_KEY/i);
  });

  it("returns 503 with a clean message when a network error occurs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:443")),
    );

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "mamo", country: "UAE" });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not reachable/i);
    expect(res.body.error).not.toMatch(/ECONNREFUSED/);
  });

  it("returns 502 with errors[0].message when Mamo returns { errors: [{ message }] }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ errors: [{ message: "Amount is too low" }] }),
      }),
    );

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "mamo", country: "UAE" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/mamo rejected this request/i);
    expect(res.body.error).toMatch(/amount is too low/i);
  });

  it("returns 502 with message field when Mamo returns { message } and no errors array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ message: "Invalid currency" }),
      }),
    );

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "mamo", country: "UAE" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/mamo rejected this request/i);
    expect(res.body.error).toMatch(/invalid currency/i);
  });

  it("returns 502 with error field when Mamo returns { error }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ error: "Unauthorized API key" }),
      }),
    );

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "mamo", country: "UAE" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/mamo rejected this request/i);
    expect(res.body.error).toMatch(/unauthorized api key/i);
  });

  it("returns 502 with generic message when Mamo returns a non-JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => "Bad Gateway",
      }),
    );

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "mamo", country: "UAE" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Failed to create Mamo payment link");
  });

  it("returns 422 for LBP + mamo with an unsupported currency message", async () => {
    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "LBP", provider: "mamo", country: "Lebanon" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/LBP/);
    expect(res.body.error).toMatch(/not supported by Mamo/i);
  });

  it("creates a Mamo payment link and returns 201 on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "mamo_link_1", url: "https://pay.mamopay.com/link/abc" }),
      }),
    );

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "AED", provider: "mamo", country: "UAE" });

    expect(res.status).toBe(201);
    expect(res.body.payment_link).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /payment-methods/status
// ---------------------------------------------------------------------------

describe("GET /payment-methods/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceRole.value = "owner";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns all true when all providers are configured and Mamo is enabled", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("PAYPAL_CLIENT_ID", "paypal_client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "paypal_secret");
    vi.stubEnv("MAMO_API_KEY", "mamo_key");
    vi.stubEnv("MAMO_ENABLED", "true");

    const res = await request(app).get("/payment-methods/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stripe: true, paypal: true, mamo: true, mamo_enabled: true });
  });

  it("returns stripe: false when STRIPE_SECRET_KEY is missing", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("PAYPAL_CLIENT_ID", "paypal_client");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "paypal_secret");
    vi.stubEnv("MAMO_API_KEY", "mamo_key");

    const res = await request(app).get("/payment-methods/status");

    expect(res.status).toBe(200);
    expect(res.body.stripe).toBe(false);
  });

  it("returns paypal: false when PAYPAL_CLIENT_ID is missing", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "paypal_secret");
    vi.stubEnv("MAMO_API_KEY", "mamo_key");

    const res = await request(app).get("/payment-methods/status");

    expect(res.status).toBe(200);
    expect(res.body.paypal).toBe(false);
  });

  it("returns mamo: false when MAMO_API_KEY is missing", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("MAMO_API_KEY", "");

    const res = await request(app).get("/payment-methods/status");

    expect(res.status).toBe(200);
    expect(res.body.mamo).toBe(false);
  });

  it("returns mamo_enabled: false when MAMO_ENABLED is 'false'", async () => {
    vi.stubEnv("MAMO_API_KEY", "mamo_key");
    vi.stubEnv("MAMO_ENABLED", "false");

    const res = await request(app).get("/payment-methods/status");

    expect(res.status).toBe(200);
    expect(res.body.mamo_enabled).toBe(false);
  });

  it("returns mamo_enabled: true when MAMO_ENABLED is not set", async () => {
    vi.stubEnv("MAMO_API_KEY", "mamo_key");
    vi.stubEnv("MAMO_ENABLED", "");

    const res = await request(app).get("/payment-methods/status");

    expect(res.status).toBe(200);
    expect(res.body.mamo_enabled).toBe(true);
  });

  it("returns all false when no provider env vars are set", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    vi.stubEnv("MAMO_API_KEY", "");

    const res = await request(app).get("/payment-methods/status");

    expect(res.status).toBe(200);
    expect(res.body.stripe).toBe(false);
    expect(res.body.paypal).toBe(false);
    expect(res.body.mamo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generatePublicToken — unit tests
// ---------------------------------------------------------------------------

describe("generatePublicToken", () => {
  it("generates a token of the configured short length", () => {
    expect(generatePublicToken()).toHaveLength(PUBLIC_TOKEN_LENGTH);
  });

  it("only uses URL-safe base62 characters", () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicToken()).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it("generates distinct tokens across many invocations", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      tokens.add(generatePublicToken());
    }
    expect(tokens.size).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// buildPublicPayUrl — unit tests
// ---------------------------------------------------------------------------

describe("buildPublicPayUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the dev domain when not deployed", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "dev.example.repl.co");
    vi.stubEnv("REPLIT_DOMAINS", "prod.example.com");
    vi.stubEnv("PUBLIC_URL", "https://public.example.com");

    expect(buildPublicPayUrl("tok123456")).toBe("https://dev.example.repl.co/pay/tok123456");
  });

  it("prefers the first REPLIT_DOMAINS entry when deployed, even with a dev domain set", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    vi.stubEnv("REPLIT_DOMAINS", "prod.example.com,alias.example.com");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "dev.example.repl.co");
    vi.stubEnv("PUBLIC_URL", "https://public.example.com");

    expect(buildPublicPayUrl("tok123456")).toBe("https://prod.example.com/pay/tok123456");
  });

  it("prefers a custom domain over the replit.app domain when both are in REPLIT_DOMAINS", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    vi.stubEnv("REPLIT_DOMAINS", "presentail-os-2.replit.app,presentail.com");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "dev.example.repl.co");
    vi.stubEnv("PUBLIC_URL", "https://public.example.com");

    expect(buildPublicPayUrl("tok123456")).toBe("https://presentail.com/pay/tok123456");
  });

  it("prefers a custom domain even when it is listed after multiple replit domains", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    vi.stubEnv("REPLIT_DOMAINS", "foo.replit.app, bar.replit.dev , presentail.com");
    vi.stubEnv("PUBLIC_URL", "");

    expect(buildPublicPayUrl("tok123456")).toBe("https://presentail.com/pay/tok123456");
  });

  it("falls back to the replit.app domain when no custom domain exists", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    vi.stubEnv("REPLIT_DOMAINS", "presentail-os-2.replit.app");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("PUBLIC_URL", "https://public.example.com");

    expect(buildPublicPayUrl("tok123456")).toBe("https://presentail-os-2.replit.app/pay/tok123456");
  });

  it("PAY_LINK_DOMAIN override wins over everything in production", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    vi.stubEnv("PAY_LINK_DOMAIN", "pay.presentail.com");
    vi.stubEnv("REPLIT_DOMAINS", "presentail-os-2.replit.app,presentail.com");
    vi.stubEnv("PUBLIC_URL", "https://public.example.com");

    expect(buildPublicPayUrl("tok123456")).toBe("https://pay.presentail.com/pay/tok123456");
  });

  it("PAY_LINK_DOMAIN accepts a full URL and strips trailing slashes", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    vi.stubEnv("PAY_LINK_DOMAIN", "https://pay.presentail.com/");
    vi.stubEnv("REPLIT_DOMAINS", "presentail-os-2.replit.app");

    expect(buildPublicPayUrl("tok123456")).toBe("https://pay.presentail.com/pay/tok123456");
  });

  it("ignores PAY_LINK_DOMAIN in development and uses the dev domain", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "");
    vi.stubEnv("PAY_LINK_DOMAIN", "pay.presentail.com");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "dev.example.repl.co");

    expect(buildPublicPayUrl("tok123456")).toBe("https://dev.example.repl.co/pay/tok123456");
  });

  it("falls back to PUBLIC_URL when deployed without REPLIT_DOMAINS", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    vi.stubEnv("REPLIT_DOMAINS", "");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("PUBLIC_URL", "https://public.example.com");

    expect(buildPublicPayUrl("tok123456")).toBe("https://public.example.com/pay/tok123456");
  });

  it("falls back to PUBLIC_URL in dev when no dev domain is set", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "");
    vi.stubEnv("REPLIT_DOMAINS", "");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("PUBLIC_URL", "https://public.example.com");

    expect(buildPublicPayUrl("tok123456")).toBe("https://public.example.com/pay/tok123456");
  });

  it("returns a relative path when no domain env vars are set at all", () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "");
    vi.stubEnv("REPLIT_DOMAINS", "");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("PUBLIC_URL", "");

    expect(buildPublicPayUrl("tok123456")).toBe("/pay/tok123456");
  });
});

// ---------------------------------------------------------------------------
// POST /payment-links — short public token generation
// ---------------------------------------------------------------------------

describe("POST /payment-links — short public token", () => {
  const TOKEN_ROW = {
    id: 1,
    workspace_owner_id: "owner_abc",
    amount: 1000,
    currency: "USD",
    provider: "stripe",
    description: null,
    country: "US",
    status: "active",
    provider_link_id: "cs_test_STRIPE123",
    provider_checkout_url: "https://checkout.stripe.com/pay/cs_test_STRIPE123",
    public_token: "tok",
    created_at: new Date().toISOString(),
    paid_at: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubWorkspaceRole.value = "owner";
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    stubStripeSuccess();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes a short base62 token to the uniqueness check and the INSERT", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValue({ rows: [TOKEN_ROW] });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(201);

    const uniquenessCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /SELECT 1 FROM payment_links WHERE public_token/i.test(sql),
    );
    expect(uniquenessCall).toBeDefined();
    const [, checkParams] = uniquenessCall as [string, unknown[]];
    expect(checkParams[0]).toMatch(new RegExp(`^[A-Za-z0-9]{${PUBLIC_TOKEN_LENGTH}}$`));

    const insertCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO payment_links/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    const [, insertParams] = insertCall as [string, unknown[]];
    // public_token is bound at $9 in the INSERT statement
    expect(insertParams[8]).toBe(checkParams[0]);
  });

  it("regenerates the token when the first candidate collides", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 }) // collision
      .mockResolvedValueOnce(TOKEN_FREE_MOCK)
      .mockResolvedValue({ rows: [TOKEN_ROW] });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(201);

    const uniquenessCalls = mockDbQuery.mock.calls.filter(([sql]: [string]) =>
      /SELECT 1 FROM payment_links WHERE public_token/i.test(sql),
    );
    expect(uniquenessCalls).toHaveLength(2);
    const firstToken = (uniquenessCalls[0] as [string, unknown[]])[1][0];
    const secondToken = (uniquenessCalls[1] as [string, unknown[]])[1][0];
    expect(firstToken).not.toBe(secondToken);

    const insertCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO payment_links/i.test(sql),
    );
    const [, insertParams] = insertCall as [string, unknown[]];
    expect(insertParams[8]).toBe(secondToken);
  });

  it("returns 500 without calling the provider when all token attempts collide", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SETTINGS_MOCK_WIDE)
      .mockResolvedValue({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await request(app)
      .post("/payment-links")
      .send({ amount: 10, currency: "USD", provider: "stripe", country: "US" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again/i);
    expect(mockStripeSessionCreate).not.toHaveBeenCalled();
  });
});

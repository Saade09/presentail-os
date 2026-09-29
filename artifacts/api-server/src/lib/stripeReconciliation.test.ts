import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockDbQuery, mockSessionRetrieve, mockLoggerInfo, mockLoggerWarn } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockSessionRetrieve: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("./logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}));

vi.mock("stripe", () => {
  class MockStripe {
    checkout = {
      sessions: {
        retrieve: (...args: unknown[]) => mockSessionRetrieve(...args),
      },
    };
  }
  return { default: MockStripe };
});

import {
  reconcileStripeLink,
  reconcileActiveStripeLinks,
  isReconcilable,
  RECONCILE_MAX_LINKS,
} from "./stripeReconciliation";

const ACTIVE_STRIPE_LINK = {
  id: 42,
  provider: "stripe",
  status: "active",
  provider_link_id: "cs_test_abc123",
};

describe("isReconcilable", () => {
  it("is true for an active stripe link with a session id", () => {
    expect(isReconcilable(ACTIVE_STRIPE_LINK)).toBe(true);
  });

  it("is false for paypal links", () => {
    expect(isReconcilable({ ...ACTIVE_STRIPE_LINK, provider: "paypal" })).toBe(false);
  });

  it("is false for non-active links", () => {
    expect(isReconcilable({ ...ACTIVE_STRIPE_LINK, status: "paid" })).toBe(false);
    expect(isReconcilable({ ...ACTIVE_STRIPE_LINK, status: "expired" })).toBe(false);
  });

  it("is false when provider_link_id is missing", () => {
    expect(isReconcilable({ ...ACTIVE_STRIPE_LINK, provider_link_id: null })).toBe(false);
    expect(isReconcilable({ ...ACTIVE_STRIPE_LINK, provider_link_id: "" })).toBe(false);
  });
});

describe("reconcileStripeLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake123");
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("flips the link to paid when Stripe reports the session as paid", async () => {
    mockSessionRetrieve.mockResolvedValue({ payment_status: "paid" });
    const paidAt = "2026-07-02T10:00:00.000Z";
    mockDbQuery.mockResolvedValue({ rows: [{ paid_at: paidAt }], rowCount: 1 });

    const result = await reconcileStripeLink(ACTIVE_STRIPE_LINK);

    expect(result).toEqual({ paid: true, paidAt });
    expect(mockSessionRetrieve).toHaveBeenCalledWith("cs_test_abc123");

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE\s+payment_links/i);
    expect(sql).toMatch(/INSERT\s+INTO\s+payment_link_conversions/i);
    expect(sql).toMatch(/status\s*=\s*'paid'/i);
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(params).toEqual([42]);
    expect(mockLoggerInfo).toHaveBeenCalled();
  });

  it("does not update the DB when the session is not paid", async () => {
    mockSessionRetrieve.mockResolvedValue({ payment_status: "unpaid" });

    const result = await reconcileStripeLink(ACTIVE_STRIPE_LINK);

    expect(result).toEqual({ paid: false, paidAt: null });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("leaves the link unchanged and logs when the Stripe API call fails", async () => {
    mockSessionRetrieve.mockRejectedValue(new Error("No such checkout session"));

    const result = await reconcileStripeLink(ACTIVE_STRIPE_LINK);

    expect(result).toEqual({ paid: false, paidAt: null });
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ linkId: 42, sessionId: "cs_test_abc123" }),
      expect.stringMatching(/leaving link unchanged/i),
    );
  });

  it("is a no-op when STRIPE_SECRET_KEY is not configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");

    const result = await reconcileStripeLink(ACTIVE_STRIPE_LINK);

    expect(result).toEqual({ paid: false, paidAt: null });
    expect(mockSessionRetrieve).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("is a no-op for non-reconcilable links (paypal / non-active / no session id)", async () => {
    for (const link of [
      { ...ACTIVE_STRIPE_LINK, provider: "paypal" },
      { ...ACTIVE_STRIPE_LINK, status: "paid" },
      { ...ACTIVE_STRIPE_LINK, provider_link_id: null },
    ]) {
      const result = await reconcileStripeLink(link);
      expect(result).toEqual({ paid: false, paidAt: null });
    }
    expect(mockSessionRetrieve).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns paid=false when the UPDATE matched no rows (already paid concurrently)", async () => {
    mockSessionRetrieve.mockResolvedValue({ payment_status: "paid" });
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await reconcileStripeLink(ACTIVE_STRIPE_LINK);

    expect(result).toEqual({ paid: false, paidAt: null });
  });

  it("leaves the link unchanged and logs when the DB update fails", async () => {
    mockSessionRetrieve.mockResolvedValue({ payment_status: "paid" });
    mockDbQuery.mockRejectedValue(new Error("connection lost"));

    const result = await reconcileStripeLink(ACTIVE_STRIPE_LINK);

    expect(result).toEqual({ paid: false, paidAt: null });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ linkId: 42 }),
      expect.stringMatching(/DB update failed/i),
    );
  });
});

describe("reconcileActiveStripeLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a map of flipped link ids and skips non-reconcilable rows", async () => {
    const paidAt = "2026-07-02T11:00:00.000Z";
    mockSessionRetrieve.mockImplementation(async (sessionId: string) => ({
      payment_status: sessionId === "cs_paid" ? "paid" : "unpaid",
    }));
    mockDbQuery.mockResolvedValue({ rows: [{ paid_at: paidAt }], rowCount: 1 });

    const flipped = await reconcileActiveStripeLinks([
      { id: 1, provider: "stripe", status: "active", provider_link_id: "cs_paid" },
      { id: 2, provider: "stripe", status: "active", provider_link_id: "cs_unpaid" },
      { id: 3, provider: "paypal", status: "active", provider_link_id: "ORDER123" },
      { id: 4, provider: "stripe", status: "paid", provider_link_id: "cs_done" },
      { id: 5, provider: "stripe", status: "active", provider_link_id: null },
    ]);

    expect([...flipped.entries()]).toEqual([[1, paidAt]]);
    // Only the two reconcilable links hit Stripe
    expect(mockSessionRetrieve).toHaveBeenCalledTimes(2);
  });

  it("caps the number of reconciled links at RECONCILE_MAX_LINKS", async () => {
    mockSessionRetrieve.mockResolvedValue({ payment_status: "unpaid" });

    const links = Array.from({ length: RECONCILE_MAX_LINKS + 10 }, (_, i) => ({
      id: i + 1,
      provider: "stripe",
      status: "active",
      provider_link_id: `cs_${i + 1}`,
    }));

    await reconcileActiveStripeLinks(links);

    expect(mockSessionRetrieve).toHaveBeenCalledTimes(RECONCILE_MAX_LINKS);
  });

  it("continues past individual failures (best-effort)", async () => {
    const paidAt = "2026-07-02T12:00:00.000Z";
    mockSessionRetrieve.mockImplementation(async (sessionId: string) => {
      if (sessionId === "cs_err") throw new Error("stripe down");
      return { payment_status: "paid" };
    });
    mockDbQuery.mockResolvedValue({ rows: [{ paid_at: paidAt }], rowCount: 1 });

    const flipped = await reconcileActiveStripeLinks([
      { id: 1, provider: "stripe", status: "active", provider_link_id: "cs_err" },
      { id: 2, provider: "stripe", status: "active", provider_link_id: "cs_ok" },
    ]);

    expect([...flipped.entries()]).toEqual([[2, paidAt]]);
  });

  it("returns an empty map when there are no reconcilable links", async () => {
    const flipped = await reconcileActiveStripeLinks([
      { id: 1, provider: "paypal", status: "active", provider_link_id: "X" },
    ]);
    expect(flipped.size).toBe(0);
    expect(mockSessionRetrieve).not.toHaveBeenCalled();
  });
});

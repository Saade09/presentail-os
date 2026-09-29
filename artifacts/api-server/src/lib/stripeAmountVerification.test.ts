/**
 * Unit tests: Stripe payment-intent amount verification — the fail-open
 * lookup that treats Stripe as the source of truth for paid amounts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRetrieve = vi.fn();
const stripeCtorKeys: string[] = [];

vi.mock("stripe", () => ({
  default: class StripeMock {
    paymentIntents = { retrieve: (...args: unknown[]) => mockRetrieve(...args) };
    constructor(key: string) {
      stripeCtorKeys.push(key);
    }
  },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  isStripeMethod,
  isStripePaymentIntentRef,
  stripeMinorToMajor,
  verifyStripePaymentIntentAmount,
} from "./stripeAmountVerification";

beforeEach(() => {
  vi.clearAllMocks();
  stripeCtorKeys.length = 0;
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_default");
  vi.stubEnv("STRIPE_SECRET_KEY_UAE", "sk_test_uae");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isStripePaymentIntentRef", () => {
  it("accepts pi_ refs and rejects everything else", () => {
    expect(isStripePaymentIntentRef("pi_3Abc123")).toBe(true);
    expect(isStripePaymentIntentRef("cs_test_123")).toBe(false);
    expect(isStripePaymentIntentRef("pi_")).toBe(false);
    expect(isStripePaymentIntentRef(null)).toBe(false);
    expect(isStripePaymentIntentRef(undefined)).toBe(false);
    expect(isStripePaymentIntentRef("pi_abc def")).toBe(false);
  });
});

describe("isStripeMethod", () => {
  it("matches stripe case-insensitively", () => {
    expect(isStripeMethod("stripe")).toBe(true);
    expect(isStripeMethod("Stripe")).toBe(true);
    expect(isStripeMethod("stripe_card")).toBe(true);
    expect(isStripeMethod("cod")).toBe(false);
    expect(isStripeMethod(null)).toBe(false);
  });
});

describe("stripeMinorToMajor", () => {
  it("divides by 100 for two-decimal currencies", () => {
    expect(stripeMinorToMajor(78500, "sar")).toBe(785);
    expect(stripeMinorToMajor(7000, "CHF")).toBe(70);
  });

  it("keeps zero-decimal currencies as-is", () => {
    expect(stripeMinorToMajor(785, "JPY")).toBe(785);
  });
});

describe("verifyStripePaymentIntentAmount", () => {
  it("returns the charged amount in major units on success", async () => {
    mockRetrieve.mockResolvedValueOnce({
      amount: 78500,
      amount_received: 78500,
      currency: "sar",
    });

    const result = await verifyStripePaymentIntentAmount("pi_3Abc");
    expect(result).toEqual({ status: "ok", amount: 785, currency: "SAR" });
    expect(stripeCtorKeys).toEqual(["sk_test_default"]);
  });

  it("falls back to the UAE account when the default account doesn't know the intent", async () => {
    mockRetrieve
      .mockRejectedValueOnce({ code: "resource_missing" })
      .mockResolvedValueOnce({ amount: 5000, amount_received: 5000, currency: "aed" });

    const result = await verifyStripePaymentIntentAmount("pi_3Uae");
    expect(result).toEqual({ status: "ok", amount: 50, currency: "AED" });
    expect(stripeCtorKeys).toEqual(["sk_test_default", "sk_test_uae"]);
  });

  it("returns not_found when both accounts definitively miss the intent", async () => {
    mockRetrieve
      .mockRejectedValueOnce({ code: "resource_missing" })
      .mockRejectedValueOnce({ code: "resource_missing" });

    const result = await verifyStripePaymentIntentAmount("pi_3Gone");
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns error on network failure (fail-open)", async () => {
    mockRetrieve.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await verifyStripePaymentIntentAmount("pi_3Down");
    expect(result).toEqual({ status: "error" });
  });

  it("returns error when no Stripe keys are configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "");

    const result = await verifyStripePaymentIntentAmount("pi_3NoKeys");
    expect(result).toEqual({ status: "error" });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("prefers amount_received but falls back to amount when nothing was received yet", async () => {
    mockRetrieve.mockResolvedValueOnce({
      amount: 12300,
      amount_received: 0,
      currency: "eur",
    });

    const result = await verifyStripePaymentIntentAmount("pi_3Pending");
    expect(result).toEqual({ status: "ok", amount: 123, currency: "EUR" });
  });
});

import Stripe from "stripe";
import { logger } from "./logger";

/**
 * Stripe payment-intent amount verification.
 *
 * The external storefront sometimes sends a wrong `payment.totalAmount`
 * (e.g. the USD figure paired with a foreign `currencyCode`). When the order
 * carries a Stripe payment intent reference we can ask Stripe what was
 * actually charged and treat that as the source of truth.
 *
 * Fail-open by design: any Stripe error other than a definitive "not found"
 * (network problem, auth failure, missing keys) yields `{ status: "error" }`
 * so callers can fall back to the payload values.
 */

// Re-export shared money utilities so existing callers don't need to change
// their import paths. New code should import from "@workspace/money" directly.
export {
  ZERO_DECIMAL_CURRENCIES,
  THREE_DECIMAL_CURRENCIES,
  currencyDecimals,
  stripeMinorToMajor,
  stripeMajorToMinor,
  applyRounding,
  computeLineTotal,
} from "@workspace/money";

/** Returns true when the payment ref looks like a Stripe payment intent id. */
export function isStripePaymentIntentRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^pi_[A-Za-z0-9]+$/.test(ref);
}

/** Returns true when the payment method names Stripe. */
export function isStripeMethod(method: unknown): boolean {
  return typeof method === "string" && method.trim().toLowerCase().includes("stripe");
}

export type StripeAmountVerification =
  | { status: "ok"; amount: number; currency: string }
  | { status: "not_found" }
  | { status: "error" };

function isStripeNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "resource_missing"
  );
}

/**
 * Retrieves a payment intent from Stripe and returns the charged amount in
 * major units plus the uppercase currency code. Tries the default account
 * first, then the UAE account (both keys exist in this workspace), since the
 * storefront does not say which account processed the charge.
 *
 * - "ok"        → Stripe answered; amount/currency are authoritative.
 * - "not_found" → both accounts definitively don't know this payment intent.
 * - "error"     → Stripe unreachable / keys missing; caller must fail open.
 */
export async function verifyStripePaymentIntentAmount(
  paymentIntentId: string,
): Promise<StripeAmountVerification> {
  const keys = [process.env.STRIPE_SECRET_KEY, process.env.STRIPE_SECRET_KEY_UAE]
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  if (keys.length === 0) return { status: "error" };

  let sawNotFound = false;
  let sawError = false;
  for (const key of keys) {
    try {
      const stripe = new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const currency = (intent.currency ?? "").toUpperCase();
      // Prefer what was actually received; fall back to the intent amount.
      const minor =
        typeof intent.amount_received === "number" && intent.amount_received > 0
          ? intent.amount_received
          : intent.amount;
      if (!currency || typeof minor !== "number" || !Number.isFinite(minor)) {
        return { status: "error" };
      }
      // Import stripeMinorToMajor from the shared module via the re-export above.
      const { stripeMinorToMajor } = await import("@workspace/money");
      return { status: "ok", amount: stripeMinorToMajor(minor, currency), currency };
    } catch (err) {
      if (isStripeNotFound(err)) {
        sawNotFound = true;
        continue;
      }
      sawError = true;
      logger.warn(
        { err, paymentIntentId },
        "Stripe amount verification: retrieve failed; failing open",
      );
    }
  }
  return sawNotFound && !sawError ? { status: "not_found" } : { status: "error" };
}

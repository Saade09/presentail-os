/**
 * Human-friendly labels for stored payment method / provider identifiers.
 * Mirrors the server-side formatter used in customer emails so a method never
 * renders as a raw identifier like "Apple_pay" anywhere in the dashboard.
 * Unknown identifiers fall back to underscores/dashes → spaces, Title Case.
 */
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  card: "Card",
  credit_card: "Card",
  cash: "Cash",
  cash_on_delivery: "Cash on Delivery",
  cod: "Cash on Delivery",
  bank_transfer: "Bank Transfer",
  wire_transfer: "Bank Transfer",
  stripe: "Stripe",
  paypal: "PayPal",
  whish: "Whish",
  payment_link: "Payment Link",
  already_paid: "Already Paid",
  cybersource: "Cybersource",
};

export function formatPaymentMethodLabel(
  method: string | null | undefined,
): string | null {
  if (typeof method !== "string") return null;
  const trimmed = method.trim();
  if (trimmed === "") return null;
  const key = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  const known = PAYMENT_METHOD_LABELS[key];
  if (known) return known;
  return trimmed
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

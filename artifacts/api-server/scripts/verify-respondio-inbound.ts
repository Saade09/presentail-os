/**
 * Non-destructive production routing verification for Respond.io inbound
 * address replies. The synthetic channel ID is random and therefore cannot
 * map to a workspace or customer order. The handler may persist the synthetic
 * inbound envelope for operational evidence, but it cannot select an order.
 */
import { createHmac, randomUUID } from "node:crypto";

const baseUrl = process.argv[2]?.replace(/\/+$/, "");
const signingKey = process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET?.trim();

if (!baseUrl || !baseUrl.startsWith("https://")) {
  throw new Error("Pass the published HTTPS base URL as the first argument");
}
if (!signingKey) {
  throw new Error(
    "RESPONDIO_INCOMING_WEBHOOK_SECRET is required",
  );
}

const verificationId = randomUUID();
const endpoint = `${baseUrl}/api/respondio/incoming-message`;
const body = JSON.stringify({
  event_type: "message.received",
  event_id: `synthetic-event-${verificationId}`,
  contact: {
    id: `synthetic-contact-${verificationId}`,
    phone: "+999000000000",
  },
  message: {
    messageId: `synthetic-inbound-${verificationId}`,
    channelMessageId: `synthetic-channel-message-${verificationId}`,
    contactId: `synthetic-contact-${verificationId}`,
    channelId: `__address_collector_verification_${verificationId}`,
    traffic: "incoming",
    timestamp: Date.now(),
    message: {
      type: "text",
      text: "Synthetic routing verification only; do not match an order",
    },
  },
  sender: { source: "contact" },
  channel: {
    id: `__address_collector_verification_${verificationId}`,
    source: "whatsapp",
  },
});
const signature = createHmac("sha256", signingKey).update(body).digest("base64");
const startedAt = performance.now();
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "X-Webhook-Signature": signature,
  },
  body,
  signal: AbortSignal.timeout(15_000),
});
const responseTimeMs = Math.round((performance.now() - startedAt) * 10) / 10;
const result = await response.json().catch(() => null) as {
  accepted?: boolean;
  duplicate?: boolean;
  error?: string;
} | null;

console.log(JSON.stringify({
  endpoint,
  httpStatus: response.status,
  responseTimeMs,
  signatureFormat: "X-Webhook-Signature: base64(HMAC-SHA256(JSON.stringify(payload)))",
  signatureAccepted: response.status === 200,
  accepted: result?.accepted === true,
  duplicate: result?.duplicate === true,
  safeSyntheticChannel: true,
  customerOrderMutationPossible: false,
  error: result?.error ?? null,
}, null, 2));

if (response.status !== 200 || result?.accepted !== true || responseTimeMs >= 5_000) {
  process.exitCode = 1;
}
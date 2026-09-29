import { createHmac, timingSafeEqual } from "crypto";
import { Router, type Request, type Response } from "express";
import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import {
  findChannelAccountByExternalId,
  getAdapter,
} from "../adapters/adapterRegistry";
import { MockChannelAdapter } from "../adapters/MockChannelAdapter";
import { processWebhookEvent, persistNormalizedMessage } from "./eventProcessor";
import type { OmniProvider } from "../types";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskSensitivePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const obj = payload as Record<string, unknown>;
  const masked = { ...obj };
  const sensitiveKeys = ["access_token", "token", "secret", "password", "key", "authorization"];
  for (const key of sensitiveKeys) {
    if (key in masked) masked[key] = "[REDACTED]";
  }
  if (masked["entry"] && Array.isArray(masked["entry"])) {
    masked["entry"] = (masked["entry"] as unknown[]).map((e) => maskSensitivePayload(e));
  }
  return masked;
}

function verifyMetaHmac(rawBody: Buffer, signature: string, appSecret: string): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(`sha256=${expected}`, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function parseBody(req: Request): unknown {
  const body = req.body;
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return {};
    }
  }
  return body ?? {};
}

async function storeRawEvent(
  channelAccountId: number | null,
  provider: OmniProvider,
  headers: Record<string, unknown>,
  payload: unknown,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO omni_webhook_raw_events (channel_account_id, provider, headers, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      channelAccountId,
      provider,
      JSON.stringify(headers),
      JSON.stringify(maskSensitivePayload(payload)),
    ],
  );
  return result.rows[0].id;
}

function safeHeaders(req: Request): Record<string, unknown> {
  const h: Record<string, unknown> = {};
  for (const key of Object.keys(req.headers)) {
    if (key.toLowerCase() === "authorization") {
      h[key] = "[REDACTED]";
    } else {
      h[key] = req.headers[key];
    }
  }
  return h;
}

// ---------------------------------------------------------------------------
// Meta hub challenge verification (GET)
// ---------------------------------------------------------------------------

function metaChallengeHandler(provider: OmniProvider) {
  return (req: Request, res: Response): void => {
    const query = req.query as Record<string, string>;
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    const log = logger.child({ provider });

    if (mode !== "subscribe") {
      log.warn({ mode }, "omnichannel: hub challenge — unexpected mode");
      res.status(400).json({ error: "Invalid hub.mode" });
      return;
    }

    if (!token || !challenge) {
      log.warn("omnichannel: hub challenge — missing token or challenge");
      res.status(400).json({ error: "Missing hub.verify_token or hub.challenge" });
      return;
    }

    const envKey = `OMNI_${provider.toUpperCase()}_VERIFY_TOKEN`;
    const expectedToken = process.env[envKey];

    if (expectedToken && token === expectedToken) {
      log.info({ provider }, "omnichannel: hub challenge verified via env token");
      res.status(200).send(challenge);
      return;
    }

    if (process.env.MOCK_CHANNELS_ENABLED === "true" && token === "mock-verify-token") {
      log.info({ provider }, "omnichannel: hub challenge verified via mock token");
      res.status(200).send(challenge);
      return;
    }

    log.warn({ provider }, "omnichannel: hub challenge — token mismatch");
    res.status(403).json({ error: "Forbidden: verify_token mismatch" });
  };
}

// ---------------------------------------------------------------------------
// Meta POST webhook handler factory — fail-closed signature verification
// ---------------------------------------------------------------------------

function metaPostHandler(provider: OmniProvider) {
  return (req: Request, res: Response): void => {
    const log = logger.child({ provider });
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    const payload = parseBody(req);
    const mockMode = process.env.MOCK_CHANNELS_ENABLED === "true";

    log.info({ provider }, "omnichannel: webhook event received");

    if (!mockMode) {
      const appSecretKey = `OMNI_${provider.toUpperCase()}_APP_SECRET`;
      const appSecret = process.env[appSecretKey];

      if (!appSecret) {
        log.error(
          { provider },
          `omnichannel: ${appSecretKey} not configured — rejecting webhook (fail-closed)`,
        );
        res.status(401).json({ error: "Unauthorized: webhook secret not configured" });
        return;
      }

      if (!signature || !rawBody) {
        log.warn({ provider, hasSignature: !!signature, hasRawBody: !!rawBody }, "omnichannel: missing signature or raw body");
        res.status(401).json({ error: "Unauthorized: missing x-hub-signature-256 header" });
        return;
      }

      if (!verifyMetaHmac(rawBody, signature, appSecret)) {
        log.warn({ provider }, "omnichannel: HMAC verification failed");
        res.status(401).json({ error: "Unauthorized: invalid signature" });
        return;
      }
    }

    res.status(200).json({ success: true });

    setImmediate(async () => {
      try {
        let channelAccountId: number | null = null;

        const payloadObj = payload as Record<string, unknown>;
        if (
          payloadObj["entry"] &&
          Array.isArray(payloadObj["entry"]) &&
          (payloadObj["entry"] as Record<string, unknown>[])[0]?.["id"]
        ) {
          const externalId = String(
            (payloadObj["entry"] as Record<string, unknown>[])[0]["id"],
          );
          const found = await findChannelAccountByExternalId(provider, externalId);
          if (found != null) channelAccountId = found;
        }

        const rawEventId = await storeRawEvent(channelAccountId, provider, safeHeaders(req), payload);

        log.info({ rawEventId, channelAccountId }, "omnichannel: raw event stored");

        if (channelAccountId !== null) {
          await processWebhookEvent({
            rawEventId,
            channelAccountId,
            provider,
            payload,
          });
        } else {
          log.warn({ rawEventId }, "omnichannel: no channel account found for inbound webhook");
        }
      } catch (err) {
        log.error({ err }, "omnichannel: async webhook processing error");
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Routes — Meta platforms
// ---------------------------------------------------------------------------

router.get("/webhooks/whatsapp", metaChallengeHandler("whatsapp"));
router.post("/webhooks/whatsapp", metaPostHandler("whatsapp"));

router.get("/webhooks/messenger", metaChallengeHandler("messenger"));
router.post("/webhooks/messenger", metaPostHandler("messenger"));

router.get("/webhooks/instagram", metaChallengeHandler("instagram"));
router.post("/webhooks/instagram", metaPostHandler("instagram"));

// ---------------------------------------------------------------------------
// TikTok — store raw + run full inbound processing pipeline
// ---------------------------------------------------------------------------

router.get("/webhooks/tiktok", (req: Request, res: Response): void => {
  const challenge = req.query["challenge"] as string | undefined;
  logger.info({ challenge }, "omnichannel: tiktok webhook GET verification");
  if (challenge) {
    res.status(200).send(challenge);
    return;
  }
  res.status(200).json({ success: true });
});

router.post("/webhooks/tiktok", (req: Request, res: Response): void => {
  const provider: OmniProvider = "tiktok";
  const log = logger.child({ provider });
  const payload = parseBody(req);

  log.info({ provider }, "omnichannel: webhook event received");

  res.status(200).json({ success: true });

  setImmediate(async () => {
    try {
      let channelAccountId: number | null = null;

      const payloadObj = payload as Record<string, unknown>;
      const openId =
        (payloadObj["open_id"] as string | undefined) ??
        ((payloadObj["business"] as Record<string, unknown> | undefined)?.["id"] as string | undefined);

      if (openId) {
        const found = await findChannelAccountByExternalId(provider, openId);
        if (found != null) channelAccountId = found;
      }

      const rawEventId = await storeRawEvent(channelAccountId, provider, safeHeaders(req), payload);
      log.info({ rawEventId, channelAccountId }, "omnichannel: tiktok raw event stored");

      if (channelAccountId !== null) {
        await processWebhookEvent({ rawEventId, channelAccountId, provider, payload });
      } else {
        log.warn({ rawEventId }, "omnichannel: no tiktok channel account found for inbound webhook");
      }
    } catch (err) {
      log.error({ err }, "omnichannel: tiktok async processing error");
    }
  });
});

// ---------------------------------------------------------------------------
// Test-provider endpoint — creates real conversation + message in DB.
// Bypasses adapter parse step to ensure persistence even when the mock
// adapter returns an empty messages array from parseWebhookEvent.
// Disabled in production.
// ---------------------------------------------------------------------------

router.post("/webhooks/test-provider", (req: Request, res: Response): void => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const provider = (body["provider"] as OmniProvider | undefined) ?? "whatsapp";
  const text = (body["text"] as string | undefined) ?? "Test message";
  const contactExternalId = (body["contact_id"] as string | undefined) ?? "test-contact-001";
  const channelAccountId = body["channel_account_id"] != null
    ? Number(body["channel_account_id"])
    : null;

  logger.info({ provider, channelAccountId }, "omnichannel: test-provider webhook received");

  res.status(200).json({ success: true, provider, text });

  setImmediate(async () => {
    try {
      const mockAdapter = new MockChannelAdapter(provider);
      const simulated = mockAdapter.simulateInbound(text, contactExternalId);

      const rawEventId = await storeRawEvent(
        channelAccountId,
        provider,
        { "x-test-provider": "true" },
        { provider, text, contact_id: contactExternalId, channel_account_id: channelAccountId },
      );

      logger.info({ rawEventId, provider }, "omnichannel: test-provider raw event stored");

      if (channelAccountId !== null) {
        await persistNormalizedMessage(channelAccountId, simulated);
        await db.query(
          `UPDATE omni_webhook_raw_events SET processed_at = NOW() WHERE id = $1`,
          [rawEventId],
        );
        logger.info({ rawEventId, channelAccountId }, "omnichannel: test-provider message persisted");
      } else {
        logger.info({ rawEventId }, "omnichannel: test-provider — no channel_account_id provided, raw event stored only");
      }
    } catch (err) {
      logger.error({ err }, "omnichannel: test-provider async processing error");
    }
  });
});

export default router;

/**
 * Address Collector — PUBLIC routes (no auth).
 *
 * GET  /address/:token  — recipient page data (surprise-safe: window +
 *                         recipient first name only; never sender/gift/price)
 * POST /address/:token  — idempotent address submission
 * POST /webhooks/respondio/address-status — provider delivery-status callback,
 *                         verified by RESPONDIO_STATUS_WEBHOOK_SECRET.
 */
import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { hashAddressToken, TOKEN_RE } from "../lib/addressCollector/tokens";
import {
  isActiveStatus,
  recordCollectionEvent,
  transitionRequestStatus,
  cancelPendingActions,
} from "../lib/addressCollector/service";
import {
  isSupplierStatementPayload,
  processSupplierStatementRespondIoStatus,
} from "../lib/supplierStatementDelivery";

const router = Router();

// ── Simple in-memory rate limiter (per IP + per token) ──────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  if (hits.size > 10_000) hits.clear(); // memory guard
  return entry.count > RATE_MAX;
}

type PublicRequestRow = {
  id: string;
  order_id: string | null;
  recipient_name: string;
  preferred_language: string;
  status: string;
  token_expires_at: string;
  window_start: string | null;
  window_end: string | null;
  delivery_timezone: string;
  link_first_opened_at: string | null;
  submitted_address: unknown;
};

async function findByToken(token: string): Promise<PublicRequestRow | null> {
  const hash = hashAddressToken(token);
  const r = await db.query<PublicRequestRow>(
    `SELECT id, order_id, recipient_name, preferred_language, status, token_expires_at,
            window_start, window_end, delivery_timezone, link_first_opened_at, submitted_address
       FROM address_collection_requests
      WHERE token_hash = $1 OR previous_token_hash = $1
      LIMIT 1`,
    [hash],
  );
  return r.rows[0] ?? null;
}

/** GET /address/:token — public page payload. */
router.get("/address/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  const ip = req.ip ?? "unknown";
  if (rateLimited(`ip:${ip}`) || rateLimited(`tok:${token.slice(0, 16)}`)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const row = await findByToken(token);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const submitted = row.status === "address_received" || row.status === "verified" || !!row.submitted_address;
    if (!submitted && !isActiveStatus(row.status)) {
      res.status(410).json({ error: "gone", state: "closed" });
      return;
    }
    if (new Date(row.token_expires_at).getTime() <= Date.now()) {
      res.status(410).json({ error: "gone", state: "expired" });
      return;
    }
    // Already submitted (multi-device / re-open): show confirmation state.
    if (!submitted && !row.link_first_opened_at) {
      await db.query(
        `UPDATE address_collection_requests
            SET link_first_opened_at = now(), updated_at = now()
          WHERE id = $1 AND link_first_opened_at IS NULL`,
        [row.id],
      );
      await transitionRequestStatus({
        requestId: row.id,
        newStatus: "link_opened",
        actor: "recipient",
        onlyFrom: ["scheduled", "whatsapp_queued", "whatsapp_sent", "whatsapp_delivered", "whatsapp_failed", "sms_fallback_sent"],
      });
      await recordCollectionEvent({ requestId: row.id, eventType: "link_opened", actor: "recipient" });
    }
    res.json({
      state: submitted ? "submitted" : "open",
      language: row.preferred_language,
      recipient_first_name: row.recipient_name.split(/\s+/)[0] ?? "",
      window_start: row.window_start,
      window_end: row.window_end,
      timezone: row.delivery_timezone,
    });
  } catch (err) {
    logger.error({ err }, "address public GET failed");
    res.status(500).json({ error: "Internal error" });
  }
});

const submitSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  area: z.string().trim().min(1).max(200),
  street: z.string().trim().min(1).max(300),
  building: z.string().trim().max(200).optional(),
  floor: z.string().trim().max(50).optional(),
  apartment: z.string().trim().max(50).optional(),
  landmark: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(1000).optional(),
  save_for_future: z.boolean().optional(),
});

/** POST /address/:token — idempotent submission. */
router.post("/address/:token", async (req: Request, res: Response) => {
  const token = String(req.params.token ?? "");
  const ip = req.ip ?? "unknown";
  if (rateLimited(`ip:${ip}`) || rateLimited(`tok:${token.slice(0, 16)}`)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  if (!TOKEN_RE.test(token)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const row = await findByToken(token);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Idempotent: already submitted → confirmation, not an error.
    if (row.status === "address_received" || row.status === "verified" || row.submitted_address) {
      res.json({ state: "submitted" });
      return;
    }
    if (!isActiveStatus(row.status)) {
      res.status(410).json({ error: "gone", state: "closed" });
      return;
    }
    if (new Date(row.token_expires_at).getTime() <= Date.now()) {
      res.status(410).json({ error: "gone", state: "expired" });
      return;
    }
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation", details: parsed.error.flatten().fieldErrors });
      return;
    }
    const a = parsed.data;
    // Written directions must be adequate: area + street combined ≥ 10 chars.
    if ((a.area + a.street).replace(/\s+/g, "").length < 10) {
      res.status(400).json({
        error: "validation",
        details: { street: ["Please provide more detailed written directions"] },
      });
      return;
    }

    const submission = {
      area: a.area,
      street: a.street,
      building: a.building ?? null,
      floor: a.floor ?? null,
      apartment: a.apartment ?? null,
      landmark: a.landmark ?? null,
      notes: a.notes ?? null,
      save_for_future: a.save_for_future ?? false,
      collectedViaLink: true,
      submitted_at: new Date().toISOString(),
    };

    // Guarded update: only the first submission wins (idempotent under races).
    const upd = await db.query<{ id: string; order_id: string; status: string }>(
      `UPDATE address_collection_requests
          SET submitted_address = $2, submitted_lat = $3, submitted_lng = $4,
              status = 'address_received', address_received_at = now(),
              resolution_outcome = 'automatic_collection',
              closure_reason = 'Address submitted by recipient',
              closure_source = 'recipient_link',
              closed_at = now(),
              resolved_at = COALESCE(resolved_at, now()),
              token_expires_at = LEAST(token_expires_at, now()),
              risk_level = 'normal', updated_at = now()
        WHERE id = $1 AND submitted_address IS NULL
          AND closed_at IS NULL
          AND status = ANY($5::text[])
        RETURNING id, order_id, status`,
      [row.id, JSON.stringify(submission), a.latitude, a.longitude, [
        "awaiting_address", "processing", "scheduled", "whatsapp_queued",
        "whatsapp_sent", "whatsapp_delivered", "whatsapp_failed",
        "sms_fallback_sent", "link_opened", "in_progress", "escalated",
        "needs_review", "failed",
      ]],
    );
    if (upd.rowCount === 0) {
      res.json({ state: "submitted" });
      return;
    }

    // Merge into the order's delivery address JSON (preserve existing keys).
    if (row.order_id) {
      await db.query(
        `UPDATE orders
            SET delivery_address = COALESCE(delivery_address, '{}'::jsonb) || $2::jsonb,
                updated_at = now()
          WHERE id = $1
            AND status <> ALL($3::text[])`,
        [
          row.order_id,
          JSON.stringify({
            address: [a.area, a.street, a.building, a.floor ? `Floor ${a.floor}` : null, a.apartment ? `Apt ${a.apartment}` : null]
              .filter(Boolean)
              .join(", "),
            area: a.area,
            street: a.street,
            building: a.building ?? null,
            floor: a.floor ?? null,
            apartment: a.apartment ?? null,
            landmark: a.landmark ?? null,
            notes: a.notes ?? null,
            latitude: a.latitude,
            longitude: a.longitude,
            collectedViaLink: true,
          }),
          ["completed", "delivered", "cancelled", "refunded"],
        ],
      );
    }

    await cancelPendingActions(row.id, "address received");
    await recordCollectionEvent({
      requestId: row.id,
      eventType: "address_received",
      actor: "recipient",
      newState: "address_received",
      metadata: { has_landmark: !!a.landmark, save_for_future: a.save_for_future ?? false },
    });
    logger.info({ requestId: row.id, orderId: row.order_id }, "addressCollector: address received");
    res.json({ state: "submitted" });
  } catch (err) {
    logger.error({ err }, "address public POST failed");
    res.status(500).json({ error: "Internal error" });
  }
});

// ── respond.io delivery-status webhook ───────────────────────────────────────
// Posted by a respond.io Workflow (HTTP request step) carrying the request ref
// from the outreach send; statuses mirror respond.io message statuses with the
// legacy accepted/queued/undelivered values still honored.
const statusSchema = z.object({
  request_ref: z.string().uuid().optional(),
  status: z.enum(["accepted", "queued", "sent", "delivered", "failed", "undelivered"]),
  provider_ref: z.string().trim().min(1).max(200),
});

router.post("/webhooks/respondio/address-status", async (req: Request, res: Response) => {
  const secret = process.env.RESPONDIO_STATUS_WEBHOOK_SECRET;
  if (!secret) {
    // Not configured — documented limitation; timeout fallback covers this.
    res.status(404).json({ error: "Not found" });
    return;
  }
  const provided = String(req.headers["x-webhook-secret"] ?? "");
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (isSupplierStatementPayload(req.body)) {
    const processed = await processSupplierStatementRespondIoStatus(req.body);
    res.json({ ok: processed, namespace: "supplier_statement_collection" });
    return;
  }
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "validation" });
    return;
  }
  try {
    const r = await db.query<{ id: string; status: string }>(
      `SELECT r.id, r.status
         FROM address_collection_requests r
        WHERE (
          EXISTS (
            SELECT 1
              FROM address_collection_actions exact_action
             WHERE exact_action.request_id = r.id
               AND exact_action.provider_ref = $1
          )
          OR (
            r.id = $2
            AND r.whatsapp_template_attempted_at IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM address_collection_actions unknown_action
               WHERE unknown_action.request_id = r.id
                 AND unknown_action.channel = 'whatsapp'
                 AND (
                   unknown_action.status = 'processing'
                   OR unknown_action.provider_status = 'unknown'
                 )
            )
          )
        )
          AND ($2::uuid IS NULL OR r.id = $2)
        ORDER BY EXISTS (
          SELECT 1 FROM address_collection_actions exact_action
           WHERE exact_action.request_id = r.id AND exact_action.provider_ref = $1
        ) DESC
        LIMIT 1`,
      [parsed.data.provider_ref, parsed.data.request_ref ?? null],
    );
    const row = r.rows[0];
    if (!row) {
      res.status(200).json({ ok: true }); // idempotent — unknown ref is a no-op
      return;
    }
    if (isActiveStatus(row.status) || row.status === "needs_review") {
      const { applyProviderStatus } = await import("../lib/addressCollector/service");
      await applyProviderStatus({
        requestId: row.id,
        providerStatus: parsed.data.status,
        providerRef: parsed.data.provider_ref ?? null,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "respondio address-status webhook failed");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;

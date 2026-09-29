/**
 * Address Collector — authed ops dashboard routes.
 *
 * GET  /address-collector          — KPIs + filterable request list (masked phones)
 * GET  /address-collector/:id      — detail (full phone) + events + actions
 * POST /address-collector/:id/send-reminder — reject legacy repeat-send clients
 * POST /address-collector/:id/status        — mark verified / needs_review / escalated / resolved
 */
import { Router, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, type WorkspaceRequest } from "../lib/workspace";
import {
  ACTIVE_STATUSES,
  finalizeAddressCollectionForOrder,
  recordCollectionEvent,
  transitionRequestStatus,
} from "../lib/addressCollector/service";
import { getRespondIoContactUrl } from "../lib/respondio";

const router = Router();

router.use("/address-collector", requireAuth, resolveWorkspace);

export function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone.replace(/\d(?=\d{2})/g, "•");
  return `${phone.slice(0, 4)}${"•".repeat(Math.max(2, phone.length - 7))}${phone.slice(-3)}`;
}

const TAB_FILTERS: Record<string, string> = {
  active: `r.closed_at IS NULL AND r.status = ANY(ARRAY['awaiting_address','processing','scheduled','whatsapp_queued','whatsapp_sent','whatsapp_delivered','whatsapp_failed','sms_fallback_sent','link_opened','in_progress','escalated','needs_review','failed']::text[])`,
  scheduled: `r.closed_at IS NULL AND r.status IN ('scheduled', 'whatsapp_queued')`,
  waiting: `r.closed_at IS NULL AND r.status IN ('awaiting_address', 'processing', 'whatsapp_sent', 'whatsapp_delivered', 'sms_fallback_sent', 'link_opened', 'in_progress')`,
  attention: `r.closed_at IS NULL AND (r.status IN ('failed', 'whatsapp_failed', 'needs_review', 'escalated') OR r.risk_level = 'at_risk')`,
  closed: `(r.closed_at IS NOT NULL OR r.status IN ('resolved','address_received','verified','cancelled','expired'))`,
};

router.get("/address-collector", async (req: WorkspaceRequest, res: Response) => {
  try {
    const ownerId = req.workspaceOwnerId as string;
    const tab = String(req.query.tab ?? "active");
    const q = String(req.query.q ?? "").trim();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);

    const tabWhere = TAB_FILTERS[tab] ?? TAB_FILTERS.active;
    const params: unknown[] = [ownerId];
    let search = "";
    if (q) {
      params.push(`%${q}%`);
      search = ` AND (r.recipient_name ILIKE $${params.length} OR r.recipient_phone ILIKE $${params.length} OR r.order_id::text ILIKE $${params.length} OR o.display_order_number ILIKE $${params.length} OR o.external_order_number ILIKE $${params.length} OR o.order_number ILIKE $${params.length} OR o.external_order_id ILIKE $${params.length})`;
    }

    const kpiR = await db.query<{
      awaiting: string;
      scheduled: string;
      at_risk: string;
      collected_auto: string;
      eligible_closed: string;
      manual_resolution: string;
      delivered_without_collection: string;
      cancelled: string;
      failed: string;
      avg_collect_seconds: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE ${TAB_FILTERS.waiting}) AS awaiting,
         COUNT(*) FILTER (WHERE ${TAB_FILTERS.scheduled}) AS scheduled,
         COUNT(*) FILTER (WHERE ${TAB_FILTERS.attention}) AS at_risk,
         COUNT(*) FILTER (WHERE r.closed_at IS NOT NULL AND r.resolution_outcome = 'automatic_collection') AS collected_auto,
         COUNT(*) FILTER (WHERE r.closed_at IS NOT NULL) AS eligible_closed,
         COUNT(*) FILTER (WHERE r.resolution_outcome = 'manual_resolution') AS manual_resolution,
         COUNT(*) FILTER (WHERE r.resolution_outcome = 'order_delivered') AS delivered_without_collection,
         COUNT(*) FILTER (WHERE r.resolution_outcome = 'order_cancelled') AS cancelled,
         COUNT(*) FILTER (WHERE r.resolution_outcome = 'failed') AS failed,
         AVG(EXTRACT(EPOCH FROM (r.address_received_at - r.created_at)))
           FILTER (WHERE r.resolution_outcome = 'automatic_collection' AND r.address_received_at IS NOT NULL) AS avg_collect_seconds
       FROM address_collection_requests r
       WHERE r.workspace_owner_id = $1`,
      [ownerId],
    );

    params.push(limit, offset);
    const listR = await db.query<Record<string, unknown>>(
      `SELECT r.id, r.order_id, r.source, r.respondio_contact_id, r.recipient_name, r.recipient_phone, r.preferred_language,
              r.status, r.risk_level, r.window_start, r.window_end, r.delivery_timezone,
              r.last_contact_at, r.last_contact_channel, r.address_received_at,
                r.link_first_opened_at, r.created_at, r.resolution_outcome,
                r.closure_reason, r.closure_source, r.closed_at,
                CASE
                  WHEN r.resolution_outcome = 'order_delivered' THEN 'Closed — order delivered'
                  WHEN r.resolution_outcome = 'order_cancelled' THEN 'Closed — order cancelled'
                  WHEN r.resolution_outcome = 'manual_resolution' THEN 'Resolved manually'
                  WHEN r.resolution_outcome = 'automatic_collection' THEN 'Address collected automatically'
                  WHEN r.resolution_outcome = 'failed' THEN 'Closed — collection failed'
                  ELSE NULL
                END AS outcome_label,
                COALESCE(
                  NULLIF(BTRIM(o.display_order_number), ''),
                  NULLIF(BTRIM(o.external_order_number), ''),
                  NULLIF(BTRIM(o.order_number), ''),
                  NULLIF(BTRIM(o.external_order_id), '')
                ) AS order_number,
              (SELECT MIN(a.scheduled_at) FROM address_collection_actions a
                WHERE a.request_id = r.id AND a.status = 'pending') AS next_action_at,
              (SELECT a.action_type FROM address_collection_actions a
                WHERE a.request_id = r.id AND a.status = 'pending'
                ORDER BY a.scheduled_at LIMIT 1) AS next_action_type,
              (SELECT COUNT(*) FROM address_collection_actions a
                 WHERE a.request_id = r.id AND a.status = 'sent' AND a.channel IN ('whatsapp','sms')) AS messages_sent,
               (SELECT a.action_type FROM address_collection_actions a
                 WHERE a.request_id = r.id AND a.channel = 'whatsapp' AND a.status = 'sent'
                 ORDER BY a.sent_at DESC NULLS LAST LIMIT 1) AS outreach_step,
               (SELECT a.provider_status FROM address_collection_actions a
                 WHERE a.request_id = r.id AND a.channel = 'whatsapp' AND a.status = 'sent'
                 ORDER BY a.sent_at DESC NULLS LAST LIMIT 1) AS provider_status,
               (SELECT a.sent_at FROM address_collection_actions a
                 WHERE a.request_id = r.id AND a.channel = 'whatsapp' AND a.status = 'sent'
                 ORDER BY a.sent_at DESC NULLS LAST LIMIT 1) AS template_sent_at
         FROM address_collection_requests r
         LEFT JOIN orders o ON o.id = r.order_id AND o.workspace_owner_id = r.workspace_owner_id
        WHERE r.workspace_owner_id = $1 AND ${tabWhere}${search}
        ORDER BY CASE WHEN r.closed_at IS NULL THEN 0 ELSE 1 END,
                 COALESCE(r.window_start, r.closed_at, r.created_at) DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const countR = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM address_collection_requests r
        LEFT JOIN orders o ON o.id = r.order_id AND o.workspace_owner_id = r.workspace_owner_id
        WHERE r.workspace_owner_id = $1 AND ${tabWhere}${search}`,
      params.slice(0, params.length - 2),
    );

    const kpis = kpiR.rows[0];
    res.json({
      kpis: {
        awaiting: Number(kpis?.awaiting ?? 0),
        scheduled: Number(kpis?.scheduled ?? 0),
        atRisk: Number(kpis?.at_risk ?? 0),
        collectedAutomatically: Number(kpis?.eligible_closed ?? 0) > 0
          ? Math.round((Number(kpis?.collected_auto ?? 0) / Number(kpis?.eligible_closed ?? 0)) * 100)
          : 0,
      },
      reporting: {
        eligibleClosed: Number(kpis?.eligible_closed ?? 0),
        automaticCollection: Number(kpis?.collected_auto ?? 0),
        manualResolution: Number(kpis?.manual_resolution ?? 0),
        deliveredWithoutCollection: Number(kpis?.delivered_without_collection ?? 0),
        cancellation: Number(kpis?.cancelled ?? 0),
        failure: Number(kpis?.failed ?? 0),
        averageTimeToCollectSeconds: kpis?.avg_collect_seconds == null
          ? null
          : Math.round(Number(kpis.avg_collect_seconds)),
      },
      requests: listR.rows.map((r) => ({
        ...r,
        recipient_phone: maskPhone(String(r.recipient_phone ?? "")),
        respondio_profile_url: r.respondio_contact_id
          ? getRespondIoContactUrl(String(r.respondio_contact_id))
          : null,
      })),
      total: Number(countR.rows[0]?.n ?? 0),
    });
  } catch (err) {
    logger.error({ err }, "address-collector list failed");
    res.status(500).json({ error: "Internal error" });
  }
});

router.get("/address-collector/:id", async (req: WorkspaceRequest, res: Response) => {
  try {
    const ownerId = req.workspaceOwnerId as string;
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const r = await db.query<Record<string, unknown>>(
      `SELECT r.id, r.order_id, r.source, r.respondio_contact_id, r.respondio_channel_id,
               r.recipient_name, r.recipient_phone, r.preferred_language, r.status,
              r.risk_level, r.window_start, r.window_end, r.address_deadline, r.delivery_timezone,
              r.compliance_state, r.sms_opt_out, r.submitted_address, r.submitted_lat, r.submitted_lng,
              r.processing_started_at, r.inbound_reply_type, r.inbound_reply_text,
              r.inbound_lat, r.inbound_lng, r.inbound_classifier, r.inbound_confidence,
              r.inbound_outcome, r.inbound_error,
              r.link_first_opened_at, r.last_contact_at, r.last_contact_channel,
              r.address_received_at, r.escalated_at, r.resolved_at, r.cancelled_at,
                r.resolution_outcome, r.closure_reason, r.closure_source, r.closed_at,
                CASE
                  WHEN r.resolution_outcome = 'order_delivered' THEN 'Closed — order delivered'
                  WHEN r.resolution_outcome = 'order_cancelled' THEN 'Closed — order cancelled'
                  WHEN r.resolution_outcome = 'manual_resolution' THEN 'Resolved manually'
                  WHEN r.resolution_outcome = 'automatic_collection' THEN 'Address collected automatically'
                  WHEN r.resolution_outcome = 'failed' THEN 'Closed — collection failed'
                  ELSE NULL
                END AS outcome_label,
                r.token_expires_at, r.created_at, r.updated_at,
                COALESCE(
                  NULLIF(BTRIM(o.display_order_number), ''),
                  NULLIF(BTRIM(o.external_order_number), ''),
                  NULLIF(BTRIM(o.order_number), ''),
                  NULLIF(BTRIM(o.external_order_id), '')
                ) AS order_number
         FROM address_collection_requests r
         LEFT JOIN orders o ON o.id = r.order_id AND o.workspace_owner_id = r.workspace_owner_id
        WHERE r.id = $1 AND r.workspace_owner_id = $2`,
      [id, ownerId],
    );
    const request = r.rows[0];
    if (!request) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const [events, actions] = await Promise.all([
      db.query(
        `SELECT id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata, created_at
           FROM address_collection_events WHERE request_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [id],
      ),
      db.query(
        `SELECT id, action_type, channel, scheduled_at, status, attempt_count, triggering_rule,
                provider_ref, provider_status, sent_at, error_code, error_message
           FROM address_collection_actions WHERE request_id = $1 ORDER BY scheduled_at`,
        [id],
      ),
    ]);
    res.json({
      request: {
        ...request,
        respondio_profile_url: request.respondio_contact_id
          ? getRespondIoContactUrl(String(request.respondio_contact_id))
          : null,
      },
      events: events.rows,
      actions: actions.rows,
    });
  } catch (err) {
    logger.error({ err }, "address-collector detail failed");
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/address-collector/:id/send-reminder", async (req: WorkspaceRequest, res: Response) => {
  try {
    const ownerId = req.workspaceOwnerId as string;
    const id = String(req.params.id);
    const r = await db.query<{ id: string; status: string; order_id: string | null; closed_at: string | null }>(
      `SELECT id, status, order_id, closed_at FROM address_collection_requests WHERE id = $1 AND workspace_owner_id = $2`,
      [id, ownerId],
    );
    const row = r.rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await recordCollectionEvent({
      requestId: id,
      eventType: "whatsapp_outreach_suppressed",
      actor: req.userId ? `user:${req.userId}` : "ops",
      channel: "whatsapp",
      metadata: { action_type: "manual_reminder", reason: "single_send_policy" },
    });
    res.status(409).json({
      error: "The WhatsApp address request is limited to one send. Use call, SMS fallback, or escalation.",
      code: "whatsapp_single_send",
    });
  } catch (err) {
    logger.error({ err }, "address-collector send-reminder failed");
    res.status(500).json({ error: "Internal error" });
  }
});

const statusBody = z.object({
  status: z.enum(["verified", "needs_review", "escalated", "in_progress", "address_received"]),
  note: z.string().trim().max(500).optional(),
});

router.post("/address-collector/:id/status", async (req: WorkspaceRequest, res: Response) => {
  try {
    const ownerId = req.workspaceOwnerId as string;
    const id = String(req.params.id);
    const parsed = statusBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation" });
      return;
    }
    const r = await db.query<{ id: string; status: string; order_id: string | null; closed_at: string | null }>(
      `SELECT id, status, order_id, closed_at
         FROM address_collection_requests
        WHERE id = $1 AND workspace_owner_id = $2`,
      [id, ownerId],
    );
    const row = r.rows[0];
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (row.closed_at || ["resolved", "address_received", "verified", "cancelled", "expired"].includes(row.status)) {
      res.status(409).json({ error: `Request is ${row.status}` });
      return;
    }
    if ((parsed.data.status === "verified" || parsed.data.status === "address_received") && row.order_id) {
      await finalizeAddressCollectionForOrder(db, {
        orderId: row.order_id,
        workspaceOwnerId: ownerId,
        outcome: "manual_resolution",
        reason: parsed.data.note || "Resolved manually by staff",
        source: "address_collector_dashboard",
        actor: req.userId ? `user:${req.userId}` : "ops",
      });
      res.json({ ok: true });
      return;
    }
    const extraSet =
      parsed.data.status === "verified"
        ? "resolved_at = now(), risk_level = 'normal'"
        : parsed.data.status === "escalated"
          ? "escalated_at = now(), risk_level = 'at_risk'"
          : parsed.data.status === "needs_review"
            ? "risk_level = 'at_risk'"
            : undefined;
    await transitionRequestStatus({
      requestId: id,
      newStatus: parsed.data.status,
      actor: req.userId ? `user:${req.userId}` : "ops",
      onlyFrom: ACTIVE_STATUSES,
      extraSet,
      metadata: parsed.data.note ? { note: parsed.data.note } : null,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "address-collector status update failed");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;

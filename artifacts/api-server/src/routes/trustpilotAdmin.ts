import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { db } from "../lib/db";
import {
  computePreferredSendTime,
  isTrustpilotTestMode,
  resolveTrustpilotLocale,
} from "../lib/trustpilot";
import { processTrustpilotInvitation } from "../lib/trustpilotInvitations";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const testFireSchema = z.object({
  orderId: z.string().min(1).max(200),
});

type OrderRow = {
  id: string;
  workspace_owner_id: string;
  display_order_number: string | null;
  external_order_id: string | null;
  tookan_delivered_at: string | null;
  customer_email: string | null;
  customer_name: string | null;
  delivery_address: Record<string, unknown> | null;
};

type InvitationResultRow = {
  id: string;
  status: string;
  recipient_email: string | null;
  reference_id: string | null;
  locale: string | null;
  preferred_send_time: string | null;
  attempt_count: number;
  last_error: string | null;
  response_payload: unknown;
  created_at: string;
  updated_at: string;
};

function addressCountry(addr: Record<string, unknown> | null): string | null {
  if (!addr) return null;
  const c = addr.country;
  return typeof c === "string" && c.trim() !== "" ? c.trim() : null;
}

function addressLanguage(addr: Record<string, unknown> | null): string | null {
  if (!addr) return null;
  for (const key of ["language", "locale", "lang"]) {
    const v = addr[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * POST /admin/trustpilot/test-fire
 *
 * Owner-only endpoint that exercises the complete Trustpilot invitation
 * pipeline for a given order in test mode:
 *   order lookup → trustpilot_invitations row insert → processTrustpilotInvitation
 *   → createTrustpilotInvitation (test mode: logs payload, no real API call)
 *   → row updated to "created" with response_payload containing the would-be
 *     Trustpilot API body.
 *
 * REQUIRES TRUSTPILOT_TEST_MODE=true in Replit Secrets. Without it the
 * endpoint rejects with 400 to prevent accidentally sending real invitations.
 *
 * If the order already has an invitation row (regardless of status) the
 * endpoint resets it to "pending" before reprocessing so each test-fire
 * exercises the full pipeline from scratch.
 */
router.post("/admin/trustpilot/test-fire", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({
      success: false,
      error: "Only the workspace owner can use the Trustpilot test-fire tool",
    });
    return;
  }

  if (!isTrustpilotTestMode()) {
    res.status(400).json({
      success: false,
      error:
        "TRUSTPILOT_TEST_MODE is not enabled. Set TRUSTPILOT_TEST_MODE=true in Replit Secrets before using this endpoint — without it the processing path would attempt a real API call to Trustpilot.",
      hint: "Go to the lock icon in the Replit sidebar → Secrets, add TRUSTPILOT_TEST_MODE with value true, then restart the API server.",
    });
    return;
  }

  const parsed = testFireSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "Invalid input",
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }

  const { orderId } = parsed.data;

  try {
    // Resolve order within this workspace (supports UUID or display_order_number).
    const orderRes = await db.query<OrderRow>(
      `SELECT o.id, o.workspace_owner_id, o.display_order_number, o.external_order_id,
              o.tookan_delivered_at, o.delivery_address,
              COALESCE(c.email, o.raw_payload->>'customer_email') AS customer_email,
              c.display_name AS customer_name
         FROM orders o
    LEFT JOIN order_contacts oc ON oc.order_id = o.id AND oc.role = 'customer'
    LEFT JOIN contacts c ON c.id = oc.contact_id
        WHERE (
          o.display_order_number = $1
          OR (
            $1 ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND o.id::text = lower($1)
          )
        )
          AND o.workspace_owner_id = $2
        LIMIT 1`,
      [orderId, wreq.workspaceOwnerId],
    );

    const order = orderRes.rows[0];
    if (!order) {
      res.status(404).json({ success: false, error: "Order not found in this workspace" });
      return;
    }

    const email = (order.customer_email ?? "").trim();
    const country = addressCountry(order.delivery_address);
    const locale = resolveTrustpilotLocale(
      addressLanguage(order.delivery_address),
      country,
    );
    const referenceId = order.display_order_number ?? order.external_order_id ?? order.id;
    const preferredSendTime = computePreferredSendTime(order.tookan_delivered_at);

    req.log.info(
      { orderId: order.id, referenceId, locale, hasEmail: !!email },
      "trustpilot: admin test-fire — inserting/resetting invitation row",
    );

    // Upsert: insert a fresh pending row or reset an existing one.
    // Using a combined INSERT + ON CONFLICT UPDATE so re-firing the same
    // order always re-runs the full pipeline.
    const upsertRes = await db.query<{ id: string }>(
      `INSERT INTO trustpilot_invitations
         (order_id, workspace_owner_id, status, recipient_email, recipient_name,
          reference_id, locale, preferred_send_time, next_attempt_at)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, now())
       ON CONFLICT (order_id) DO UPDATE
         SET status            = 'pending',
             recipient_email   = EXCLUDED.recipient_email,
             recipient_name    = EXCLUDED.recipient_name,
             reference_id      = EXCLUDED.reference_id,
             locale            = EXCLUDED.locale,
             preferred_send_time = EXCLUDED.preferred_send_time,
             next_attempt_at   = now(),
             attempt_count     = 0,
             last_error        = NULL,
             response_payload  = NULL,
             trustpilot_invitation_id = NULL,
             updated_at        = now()
       RETURNING id`,
      [
        order.id,
        order.workspace_owner_id,
        email || null,
        order.customer_name ?? null,
        referenceId,
        locale,
        preferredSendTime,
      ],
    );

    const invitationId = upsertRes.rows[0]?.id;
    if (!invitationId) {
      res.status(500).json({ success: false, error: "Failed to create invitation row" });
      return;
    }

    req.log.info(
      { invitationId, orderId: order.id },
      "trustpilot: admin test-fire — processing invitation in test mode",
    );

    // Run the real processing pipeline. Because TRUSTPILOT_TEST_MODE=true
    // (verified above), createTrustpilotInvitation will log the payload and
    // return a synthetic success without calling the real Trustpilot API.
    await processTrustpilotInvitation(invitationId);

    // Read back the resulting row to return the full outcome + stored payload.
    const resultRes = await db.query<InvitationResultRow>(
      `SELECT id, status, recipient_email, reference_id, locale, preferred_send_time,
              attempt_count, last_error, response_payload, created_at, updated_at
         FROM trustpilot_invitations
        WHERE id = $1`,
      [invitationId],
    );
    const result = resultRes.rows[0];

    req.log.info(
      { invitationId, orderId: order.id, status: result?.status },
      "trustpilot: admin test-fire — complete",
    );

    res.json({
      success: true,
      testModeActive: true,
      order: {
        id: order.id,
        referenceId,
        locale,
        preferredSendTime,
        hasCustomerEmail: !!email,
        missingEmail: !email,
      },
      invitation: result
        ? {
            id: result.id,
            status: result.status,
            attemptCount: result.attempt_count,
            lastError: result.last_error,
            responsePayload: result.response_payload,
            createdAt: result.created_at,
            updatedAt: result.updated_at,
          }
        : null,
      note: !email
        ? "This order has no customer email. The invitation row was inserted but processing marked it as 'skipped'."
        : "The invitation was processed in test mode — no real email was sent. Check responsePayload for the exact payload that would be sent to Trustpilot.",
    });
  } catch (err) {
    req.log.error({ err }, "trustpilot: admin test-fire failed");
    res.status(500).json({ success: false, error: "Test fire failed unexpectedly" });
  }
});

export default router;

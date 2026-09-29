import { Router, type Request, type Response } from "express";
import type { Pool, PoolClient, QueryResult } from "pg";
import { db } from "../lib/db";
import { transitionOrderStatus } from "../lib/orderStatusTransition";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, hasPageAccess } from "../lib/workspace";
import { fireWebhookEvent } from "../lib/catalogWebhook";
import { buildGiftCardPdf } from "../lib/giftCardPdf";
import { notifyOrderStatusEmail, recordOrderEvent } from "./orders";
import { notifyOrderStatusWhatsApp } from "../lib/orderWhatsappNotify";
import { translateDescriptionToArabic } from "../lib/translation";
import { broadcastEvent } from "../lib/eventsSse";
import { notifyFloristAssignmentAlerts } from "../lib/orderAlerts";
import {
  buildPublicObjectUrl,
  objectStorageService,
  ObjectNotFoundError,
} from "../lib/objectStorage";
import { enqueueRealDeliveryPublication } from "../lib/realDeliveryPublication";
import { syncApprovedFloristPhotoToTookan } from "../lib/floristTookanPhotoSync";

type QueryClient = Pool | PoolClient;

import { cardPhotoSatisfiedSql, hasCardMessageSql } from "../lib/floristEvidence";
import {
  runFloristPhotoVerification,
  runFloristFocusedItemVerification,
  runCardOnBoxVerification,
  runCardTextVerification,
  type CardTextVerificationResult,
  type ExpectedItem,
  type ReferenceImage,
} from "../lib/floristPhotoVerification";

/**
 * Florist Orders workflow.
 *
 * Owners send an order to exactly one florist location
 * (POST /orders/:id/send-to-florist — re-sending replaces the assignment).
 * Members whose role grants the `florist_orders` page see the queue for their
 * own florist location only (workspace_members.florist_location_id, enforced
 * server-side), work each order through pending → in_progress ⇄ paused →
 * completed, and can print the order's gift-card message. Completing the
 * florist task moves the parent order to `ready_for_delivery`.
 *
 * Florist-facing responses intentionally exclude customer PII: only the order
 * number, line items, and card availability are exposed.
 */
const router = Router();

router.use(requireAuth);
router.use(resolveWorkspace);

type FloristTaskStatus = "pending" | "in_progress" | "paused" | "completed";

interface AssignmentRow {
  id: number;
  order_id: string;
  location_id: number;
  status: FloristTaskStatus;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AssignmentResponseRow extends AssignmentRow {
  location_name: string;
  photo_items_path: string | null;
  photo_card_path: string | null;
  photo_set_rev: number;
  parent_order_status: string;
  verification_status: string;
  publication_status: string | null;
  publication_enabled: boolean | null;
  publication_privacy_faces_clear: boolean | null;
  publication_privacy_card_message_clear: boolean | null;
  publication_privacy_address_clear: boolean | null;
  publication_privacy_other_personal_info_clear: boolean | null;
  publication_moderated_at: string | null;
}

type FloristPublicationStatus =
  | "not_selected"
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "stale"
  | "unavailable";

type FloristPublicationReason =
  | "missing_photo"
  | "not_approved"
  | "order_not_completed"
  | "stale_revision"
  | "privacy_checks_required"
  | "insufficient_inventory"
  | "minimum_three_photos";

interface FloristPublicationEligibility {
  eligible: boolean;
  eligible_photo_count: number;
  reasons: FloristPublicationReason[];
}

interface FloristPublicationResponse {
  enabled: boolean;
  status: FloristPublicationStatus;
  photo_set_rev: number | null;
  privacy_faces_clear: boolean;
  privacy_card_message_clear: boolean;
  privacy_address_clear: boolean;
  privacy_other_personal_info_clear: boolean;
  moderated_at: string | null;
  feed_eligibility: FloristPublicationEligibility;
}

function publicationResponse(
  row: Partial<AssignmentResponseRow> & {
    feed_eligibility?: FloristPublicationEligibility;
  },
): FloristPublicationResponse {
  const reasons: FloristPublicationReason[] = [];
  if (!row.photo_items_path) reasons.push("missing_photo");
  if (row.photo_items_path && row.verification_status !== "approved") {
    reasons.push("not_approved");
  }
  if (row.photo_items_path && row.parent_order_status !== "completed") {
    reasons.push("order_not_completed");
  }
  const unavailable = reasons.length > 0;
  return {
    enabled: unavailable ? false : row.publication_enabled === true,
    status: unavailable
      ? "unavailable"
      : ((row.publication_status as FloristPublicationStatus | null) ?? "not_selected"),
    photo_set_rev: unavailable ? null : (row.photo_set_rev ?? null),
    privacy_faces_clear: row.publication_privacy_faces_clear === true,
    privacy_card_message_clear: row.publication_privacy_card_message_clear === true,
    privacy_address_clear: row.publication_privacy_address_clear === true,
    privacy_other_personal_info_clear:
      row.publication_privacy_other_personal_info_clear === true,
    moderated_at: row.publication_moderated_at ?? null,
    feed_eligibility:
      row.feed_eligibility ?? {
        eligible: false,
        eligible_photo_count: 0,
        reasons: unavailable ? reasons : ["minimum_three_photos"],
      },
  };
}

function parseRequiredBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function getFloristPublicationEligibility(
  client: QueryClient,
  assignmentId: number,
  workspaceOwnerId: string,
): Promise<FloristPublicationEligibility> {
  const gates = await client.query<{
    city_id: number | null;
    has_location: boolean;
    has_product: boolean;
    product_active: boolean;
    has_recipe: boolean;
    in_stock: boolean;
  }>(
    `WITH target AS (
       SELECT ofa.location_id, o.workspace_owner_id, o.delivery_address,
              dc.id AS city_id, dc.country_code,
              ml.product_id, p.id AS linked_product_id,
              (p.id IS NOT NULL
               AND p.is_archived=false AND p.status='available'
               AND NOT EXISTS (
                 SELECT 1 FROM product_country_availability pcoa
                  WHERE pcoa.product_id=p.id
                    AND upper(pcoa.country_code)=upper(dc.country_code)
                    AND pcoa.is_available=false
               )
               AND NOT EXISTS (
                 SELECT 1 FROM product_city_availability pca
                  WHERE pca.product_id=p.id AND pca.city_id=dc.id
                    AND pca.is_available=false
               )
               AND NOT EXISTS (
                 SELECT 1 FROM product_location_statuses pls
                  WHERE pls.product_id=p.id AND pls.location_id=ofa.location_id
                    AND pls.is_active=false
               )
               AND (
                 COALESCE(NULLIF(btrim(o.delivery_address->>'countryCode'), ''),
                          NULLIF(btrim(o.delivery_address->>'country_code'), '')) IS NULL
                 OR upper(COALESCE(o.delivery_address->>'countryCode',
                                   o.delivery_address->>'country_code'))=upper(dc.country_code)
               )
               AND (
                 NULLIF(btrim(o.delivery_address->>'country'), '') IS NULL
                 OR upper(o.delivery_address->>'country')=upper(dc.country_code)
                 OR (lower(o.delivery_address->>'country')='lebanon'
                     AND upper(dc.country_code)='LB')
                 OR (lower(o.delivery_address->>'country') IN ('united arab emirates','uae')
                     AND upper(dc.country_code)='AE')
                 OR (lower(o.delivery_address->>'country')='cyprus'
                     AND upper(dc.country_code)='CY')
               )) AS product_active
         FROM order_florist_assignments ofa
         JOIN orders o ON o.id=ofa.order_id
                      AND o.workspace_owner_id=ofa.workspace_owner_id
         JOIN LATERAL (
           SELECT dc.id, dc.country_code
             FROM delivery_cities dc
            WHERE dc.workspace_owner_id=o.workspace_owner_id
              AND dc.is_active=true
              AND (
                dc.id::text = NULLIF(btrim(o.delivery_address->>'cityId'), '')
                OR lower(dc.slug) = lower(NULLIF(btrim(o.delivery_address->>'cityId'), ''))
                OR dc.id::text = NULLIF(btrim(o.delivery_address->>'city_id'), '')
                OR lower(dc.slug) = lower(NULLIF(btrim(o.delivery_address->>'city_id'), ''))
                OR lower(dc.name) = lower(NULLIF(btrim(o.delivery_address->>'cityName'), ''))
                OR lower(dc.name) = lower(NULLIF(btrim(o.delivery_address->>'city'), ''))
                OR lower(dc.name) = lower(NULLIF(btrim(o.delivery_address->>'district'), ''))
              )
            LIMIT 1
         ) dc ON true
         LEFT JOIN LATERAL (
           SELECT min(oli.product_id) AS product_id
             FROM order_line_items oli
             JOIN products fp ON fp.id=oli.product_id
                            AND fp.workspace_owner_id=o.workspace_owner_id
             JOIN product_catalog_categories fpcc ON fpcc.product_id=fp.id
             JOIN catalog_categories fcc ON fcc.id=fpcc.attribute_id
            WHERE oli.order_id=o.id AND oli.product_id IS NOT NULL
              AND lower(fcc.slug)='flowers' AND fcc.is_active=true
              AND NOT EXISTS (
                SELECT 1 FROM catalog_category_city_availability cca
                 WHERE cca.catalog_category_id=fcc.id AND cca.city_id=dc.id
                   AND cca.is_enabled=false
              )
            HAVING count(DISTINCT oli.product_id)=1
         ) ml ON true
         LEFT JOIN products p ON p.id=ml.product_id
                           AND p.workspace_owner_id=o.workspace_owner_id
        WHERE ofa.id=$1 AND ofa.workspace_owner_id=$2
     )
     SELECT min(t.city_id)::int AS city_id,
            count(*) > 0 AS has_location,
             bool_or(t.linked_product_id IS NOT NULL) AS has_product,
             COALESCE(bool_or(t.product_active), false) AS product_active,
             COALESCE(bool_or(t.linked_product_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM product_recipes pr
                WHERE pr.product_id=t.linked_product_id
                  AND pr.workspace_owner_id=t.workspace_owner_id
            )), false) AS has_recipe,
             COALESCE(bool_or(t.linked_product_id IS NOT NULL AND t.product_active AND EXISTS (
              SELECT 1 FROM product_recipes pr
                WHERE pr.product_id=t.linked_product_id
                  AND pr.workspace_owner_id=t.workspace_owner_id
            ) AND NOT EXISTS (
              SELECT 1
                FROM product_recipes pr
                LEFT JOIN base_item_location_costs bilc
                  ON bilc.base_item_id=pr.base_item_id
                  AND bilc.location_id=t.location_id
                  AND bilc.workspace_owner_id=t.workspace_owner_id
                WHERE pr.product_id=t.linked_product_id
                  AND pr.workspace_owner_id=t.workspace_owner_id
                 AND COALESCE(bilc.total_units_on_hand, 0) < pr.quantity
            )), false) AS in_stock
       FROM target t`,
    [assignmentId, workspaceOwnerId],
  );
  const gate = gates.rows[0];
  if (!gate) {
    return { eligible: false, eligible_photo_count: 0, reasons: ["missing_photo"] };
  }

  let eligiblePhotoCount = 0;
  if (gate.city_id !== null) {
    const count = await client.query<{ count: number }>(
      `SELECT count(DISTINCT fpp.id)::int AS count
         FROM florist_photo_publications fpp
         JOIN order_florist_assignments ofa ON ofa.id=fpp.assignment_id
         JOIN orders o ON o.id=ofa.order_id
                      AND o.workspace_owner_id=ofa.workspace_owner_id
         JOIN delivery_cities dc ON dc.workspace_owner_id=o.workspace_owner_id
                                AND dc.id=$2
         JOIN LATERAL (
           SELECT min(oli.product_id) AS product_id
             FROM order_line_items oli
             JOIN products fp ON fp.id=oli.product_id
                            AND fp.workspace_owner_id=o.workspace_owner_id
             JOIN product_catalog_categories fpcc ON fpcc.product_id=fp.id
             JOIN catalog_categories fcc ON fcc.id=fpcc.attribute_id
            WHERE oli.order_id=o.id AND oli.product_id IS NOT NULL
              AND lower(fcc.slug)='flowers' AND fcc.is_active=true
              AND NOT EXISTS (
                SELECT 1 FROM catalog_category_city_availability cca
                 WHERE cca.catalog_category_id=fcc.id AND cca.city_id=dc.id
                   AND cca.is_enabled=false
              )
            HAVING count(DISTINCT oli.product_id)=1
         ) ml ON true
         JOIN products p ON p.id=ml.product_id
                       AND p.workspace_owner_id=o.workspace_owner_id
        WHERE fpp.workspace_owner_id=$1
          AND fpp.publication_status='ready' AND fpp.enabled=true
          AND fpp.public_asset_key ~ '^real-deliveries/[0-9a-f-]+\\.(jpg|jpeg|png|webp)$'
          AND fpp.photo_set_rev=ofa.photo_set_rev
          AND fpp.source_photo_path=ofa.photo_items_path
          AND ofa.verification_status='approved' AND o.status='completed'
          AND p.is_archived=false AND p.status='available'
          AND NOT EXISTS (SELECT 1 FROM product_country_availability pcoa
                           WHERE pcoa.product_id=p.id
                             AND upper(pcoa.country_code)=upper(dc.country_code)
                             AND pcoa.is_available=false)
          AND NOT EXISTS (SELECT 1 FROM product_city_availability pca
                           WHERE pca.product_id=p.id AND pca.city_id=dc.id
                             AND pca.is_available=false)
          AND NOT EXISTS (SELECT 1 FROM product_location_statuses pls
                           WHERE pls.product_id=p.id AND pls.location_id=ofa.location_id
                             AND pls.is_active=false)
          AND EXISTS (SELECT 1 FROM product_recipes pr
                       WHERE pr.product_id=p.id AND pr.workspace_owner_id=o.workspace_owner_id)
          AND NOT EXISTS (
            SELECT 1 FROM product_recipes pr
            LEFT JOIN base_item_location_costs bilc
              ON bilc.base_item_id=pr.base_item_id AND bilc.location_id=ofa.location_id
             AND bilc.workspace_owner_id=o.workspace_owner_id
            WHERE pr.product_id=p.id AND pr.workspace_owner_id=o.workspace_owner_id
              AND COALESCE(bilc.total_units_on_hand, 0) < pr.quantity
          )`,
      [workspaceOwnerId, gate.city_id],
    );
    eligiblePhotoCount = Number(count.rows[0]?.count ?? 0);
  }

  // Operational publication selection is available for every approved,
  // completed florist photo. City, category, recipe, inventory, and collection
  // size are storefront merchandising concerns and must not hide this option.
  const reasons: FloristPublicationReason[] = [];
  return {
    eligible: true,
    eligible_photo_count: Math.max(eligiblePhotoCount, 1),
    reasons,
  };
}

/** Photo-verification workflow state carried on the assignment row. */
interface VerificationStateRow {
  card_printed_at: string | null;
  photo_items_path: string | null;
  photo_card_path: string | null;
  photo_card_on_box_path: string | null;
  verification_status: string;
  verification_reason_code: string | null;
  verification_reason: string | null;
  verified_at: string | null;
  slack_sent_at: string | null;
}

/** SELECT fragment (aliased `ofa`) for the verification state columns. */
const VERIFICATION_STATE_COLUMNS = `
            ofa.card_printed_at, ofa.photo_items_path, ofa.photo_card_path,
            ofa.photo_card_on_box_path,
            ofa.verification_status,
            ofa.verification_result->>'reason_code' AS verification_reason_code,
            ofa.verification_result->>'reason' AS verification_reason,
            ofa.verified_at, ofa.slack_sent_at`;

/** RETURNING fragment for the verification state columns (no alias). */
const VERIFICATION_STATE_RETURNING = `
            card_printed_at, photo_items_path, photo_card_path,
            photo_card_on_box_path,
            verification_status,
            verification_result->>'reason_code' AS verification_reason_code,
            verification_result->>'reason' AS verification_reason,
            verified_at, slack_sent_at`;

function verificationState(row: VerificationStateRow) {
  return {
    card_printed_at: row.card_printed_at,
    photo_items_path: row.photo_items_path,
    photo_card_path: row.photo_card_path,
    photo_card_on_box_path: row.photo_card_on_box_path,
    verification_status: row.verification_status,
    verification_reason_code: row.verification_reason_code,
    verification_reason: row.verification_reason,
    verified_at: row.verified_at,
    slack_sent_at: row.slack_sent_at,
  };
}

/**
 * Gate for florist queue endpoints: the caller needs the `florist_orders`
 * page (owners always pass). Returns false after sending a 403.
 */
function requireFloristAccess(
  wreq: ReturnType<typeof workspace>,
  res: Response,
): boolean {
  if (hasPageAccess(wreq, "florist_orders")) return true;
  res
    .status(403)
    .json({ success: false, error: "You do not have access to florist orders" });
  return false;
}

/**
 * Gate for the operations manual-review surface. This deliberately uses the
 * existing Orders page permission rather than florist access: reviewers work
 * across locations but do not gain any florist lifecycle or photo-edit action.
 */
function requireFloristReviewerAccess(
  wreq: ReturnType<typeof workspace>,
  res: Response,
): boolean {
  if (hasPageAccess(wreq, "orders")) return true;
  res
    .status(403)
    .json({ success: false, error: "You do not have access to florist photo reviews" });
  return false;
}

/**
 * Resolve which florist location the caller may act on. Owners are
 * unrestricted (returns null = all locations). Members must have a
 * florist_location_id configured on their workspace_members row; when missing,
 * responds 403 and returns undefined.
 */
async function resolveFloristLocationId(
  wreq: ReturnType<typeof workspace>,
  res: Response,
): Promise<number | null | undefined> {
  if (wreq.workspaceRole === "owner") return null;
  if (wreq.memberDbId == null) {
    res.status(403).json({
      success: false,
      error: "No florist location is assigned to your account. Ask an administrator to set one.",
    });
    return undefined;
  }
  const result = await db.query<{ florist_location_id: number | null }>(
    `SELECT florist_location_id FROM workspace_members
      WHERE id = $1 AND workspace_owner_id = $2
      LIMIT 1`,
    [wreq.memberDbId, wreq.workspaceOwnerId],
  );
  const locationId = result.rows[0]?.florist_location_id ?? null;
  if (locationId == null) {
    res.status(403).json({
      success: false,
      error: "No florist location is assigned to your account. Ask an administrator to set one.",
    });
    return undefined;
  }
  return locationId;
}

/**
 * Send an order to a florist location. Requires access to the Orders page
 * (owners always pass). One location per order — re-sending replaces the
 * previous assignment and resets the florist task to `pending`.
 */
router.post(
  "/orders/:id/send-to-florist",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!hasPageAccess(wreq, "orders")) {
      res.status(403).json({
        success: false,
        error: "You do not have access to orders",
      });
      return;
    }
    const { id } = req.params;
    const locationId = parseInt(String((req.body ?? {}).locationId), 10);
    if (Number.isNaN(locationId)) {
      res.status(400).json({ success: false, error: "locationId is required" });
      return;
    }

    let order: QueryResult<{
      id: string;
      status: string;
      external_order_id: string | null;
      display_order_number: string | null;
    }>;
    let result: QueryResult<AssignmentRow>;
    let previousLocationId: number | null;

    // Lock the parent before creating/replacing the assignment. Order
    // completion takes the same lock first, so either this pending assignment
    // is committed and then completed, or the completed order is observed here
    // and cannot be reopened.
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      order = await client.query<{
        id: string;
        status: string;
        external_order_id: string | null;
        display_order_number: string | null;
      }>(
        `SELECT id, status, external_order_id, display_order_number
           FROM orders
          WHERE id = $1 AND workspace_owner_id = $2
          LIMIT 1
          FOR UPDATE`,
        [id, wreq.workspaceOwnerId],
      );
      if (order.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ success: false, error: "Order not found" });
        return;
      }
      if (order.rows[0].status === "completed") {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "order_completed",
          error: "A completed order cannot be sent or re-sent to a florist",
        });
        return;
      }

      const location = await client.query<{ id: number }>(
        `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
        [locationId, wreq.workspaceOwnerId],
      );
      if (location.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ success: false, error: "Location not found" });
        return;
      }

      // Previous assignment (if any) so we only notify the florist location
      // when the assignment is new or moved to a different location.
      const previous = await client.query<{ location_id: number }>(
        `SELECT location_id FROM order_florist_assignments
          WHERE order_id = $1 AND workspace_owner_id = $2
          LIMIT 1`,
        [id, wreq.workspaceOwnerId],
      );
      previousLocationId = previous.rows[0]?.location_id ?? null;

      result = await client.query<AssignmentRow>(
        `INSERT INTO order_florist_assignments
           (workspace_owner_id, order_id, location_id, status, assigned_by,
            started_at, completed_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', $4, NULL, NULL, now(), now())
         ON CONFLICT (order_id) DO UPDATE
           SET location_id = EXCLUDED.location_id,
               status = 'pending',
               assigned_by = EXCLUDED.assigned_by,
               started_at = NULL,
               completed_at = NULL,
               -- Re-sending replaces the assignment: the new florist must go
               -- through the full quality gate again. Clear card/photo/AI/Slack
               -- evidence and bump photo_set_rev so any in-flight verification
               -- or Slack delivery for the old evidence can never apply.
               card_printed_at = NULL,
               photo_items_path = NULL,
               photo_card_path = NULL,
               photo_card_on_box_path = NULL,
               verification_status = 'none',
               verification_result = NULL,
               verification_started_at = NULL,
               verified_at = NULL,
               slack_sent_at = NULL,
               slack_pending_at = NULL,
               slack_attempted_rev = NULL,
               photo_set_rev = order_florist_assignments.photo_set_rev + 1,
               updated_at = now()
         RETURNING id, order_id, location_id, status, started_at, completed_at,
                   created_at, updated_at`,
        [wreq.workspaceOwnerId, id, locationId, wreq.userId ?? null],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Alert the assigned florist location (toast/chime on web via SSE, Expo
    // push on mobile) — only when the assignment is new or changed location.
    if (previousLocationId !== locationId) {
      broadcastEvent(wreq.workspaceOwnerId, {
        event: "order.assigned_to_florist",
        workspaceId: wreq.workspaceOwnerId,
        data: {
          id: String(id),
          displayOrderNumber: order.rows[0].display_order_number ?? null,
          locationId,
          // Per-assignment marker so clients can dedup reconnect replays
          // without suppressing a later legitimate re-assignment (A → B → A).
          assignedAt: new Date().toISOString(),
        },
      });
      void notifyFloristAssignmentAlerts(
        wreq.workspaceOwnerId,
        String(id),
        locationId,
      );
    }

    // Sending an order to a florist means active preparation is starting, so
    // auto-advance the order to `preparing` — but only from an earlier flow
    // stage (pending/processing). Orders already at or past preparing, or in
    // an off-flow status (cancelled / on_hold / refunded), are left untouched.
    const previousStatus = order.rows[0].status;
    if (previousStatus === "pending" || previousStatus === "processing") {
      // Conditional in SQL to guard against concurrent status changes between
      // the SELECT above and this UPDATE; side effects fire only on an actual
      // transition.
      const updated = await db.query(
        `UPDATE orders SET status = 'preparing', updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2
            AND status IN ('pending', 'processing')`,
        [id, wreq.workspaceOwnerId],
      );
      if ((updated.rowCount ?? 0) > 0) {
        void fireWebhookEvent("order.status_updated", wreq.workspaceOwnerId, {
          orderId: String(id),
          appOrderId: order.rows[0].external_order_id ?? null,
          status: "preparing",
          updatedAt: new Date().toISOString(),
        });
        recordOrderEvent({
          workspaceOwnerId: wreq.workspaceOwnerId,
          orderId: String(id),
          eventType: "status_changed",
          payload: { from: previousStatus, to: "preparing" },
          actorUserId: wreq.userId,
        });
        void notifyOrderStatusEmail(
          String(id),
          order.rows[0].external_order_id ?? String(id),
          "preparing",
          wreq.workspaceOwnerId,
        );
      }
    }

    res.json({ success: true, assignment: result.rows[0] });
  },
);

/**
 * Current florist assignment for an order (used by the Send to Florist dialog
 * to show/replace the existing assignment). Requires access to the Orders page.
 */
router.get(
  "/orders/:id/florist-assignment",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!hasPageAccess(wreq, "orders")) {
      res.status(403).json({ success: false, error: "You do not have access to orders" });
      return;
    }
    const { id } = req.params;
    const order = await db.query<{ id: string }>(
      `SELECT id FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    );
    if (order.rowCount === 0) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    const result = await db.query<AssignmentResponseRow>(
       `SELECT ofa.id, ofa.order_id, ofa.location_id, l.name AS location_name,
                ofa.status, ofa.started_at, ofa.completed_at, ofa.created_at, ofa.updated_at,
                ofa.photo_set_rev, ofa.verification_status,
                o.status AS parent_order_status,
               CASE
                 WHEN ofa.verification_status = 'approved'
                   AND ofa.photo_items_path IS NOT NULL
                   AND ${cardPhotoSatisfiedSql("ofa", "o")}
                 THEN ofa.photo_items_path
                 ELSE NULL
               END AS photo_items_path,
                CASE
                  WHEN ofa.verification_status = 'approved'
                    AND ofa.photo_items_path IS NOT NULL
                    AND ${cardPhotoSatisfiedSql("ofa", "o")}
                  THEN ofa.photo_card_path
                  ELSE NULL
                  END AS photo_card_path,
                fpp.publication_status,
                fpp.enabled AS publication_enabled,
                fpp.privacy_faces_clear AS publication_privacy_faces_clear,
                fpp.privacy_card_message_clear AS publication_privacy_card_message_clear,
                fpp.privacy_address_clear AS publication_privacy_address_clear,
                fpp.privacy_other_personal_info_clear,
                fpp.moderated_at AS publication_moderated_at
          FROM order_florist_assignments ofa
          JOIN locations l ON l.id = ofa.location_id
          JOIN orders o
            ON o.id = ofa.order_id
           AND o.workspace_owner_id = ofa.workspace_owner_id
       LEFT JOIN florist_photo_publications fpp
         ON fpp.assignment_id = ofa.id
        AND fpp.photo_set_rev = ofa.photo_set_rev
        AND fpp.source_photo_path = ofa.photo_items_path
        WHERE ofa.order_id = $1 AND ofa.workspace_owner_id = $2
        LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    );
     const assignmentRow = result.rows[0];
     const feedEligibility =
       assignmentRow &&
       assignmentRow.photo_items_path &&
       assignmentRow.verification_status === "approved" &&
       assignmentRow.parent_order_status === "completed"
         ? await getFloristPublicationEligibility(
             db,
             assignmentRow.id,
             wreq.workspaceOwnerId,
           )
         : undefined;
     const assignment = assignmentRow
       ? {
           ...assignmentRow,
           publication: publicationResponse({
             ...assignmentRow,
             feed_eligibility: feedEligibility,
           }),
         }
       : null;
     res.json({ success: true, assignment });
  },
);

/**
 * Remove the current active florist assignment for an order. This is an
 * operations action (not a florist lifecycle action), so it uses Orders page
 * access and locks the parent order before the assignment. That lock order is
 * shared with send-to-florist and order completion to prevent deleting a new
 * assignment after a concurrent replacement.
 */
router.delete(
  "/orders/:id/florist-assignment",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!hasPageAccess(wreq, "orders")) {
      res.status(403).json({
        success: false,
        error: "You do not have access to orders",
      });
      return;
    }

    const client = await db.connect();
    let removedAssignment: AssignmentRow | undefined;
    let parentOrderId = String(req.params.id);
    let externalOrderId: string | null = null;
    let previousStatus: string | null = null;
    let parentStatus = "processing";
    let statusReverted = false;

    try {
      await client.query("BEGIN");

      const orderResult = await client.query<{
        id: string;
        status: string;
        external_order_id: string | null;
      }>(
        `SELECT id, status, external_order_id
           FROM orders
          WHERE id = $1 AND workspace_owner_id = $2
          LIMIT 1
          FOR UPDATE`,
        [req.params.id, wreq.workspaceOwnerId],
      );
      if (orderResult.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ success: false, error: "Order not found" });
        return;
      }

      const order = orderResult.rows[0];
      parentOrderId = order.id;
      externalOrderId = order.external_order_id;
      previousStatus = order.status;
      parentStatus = order.status;

      const assignmentResult = await client.query<AssignmentRow>(
        `SELECT id, order_id, location_id, status, started_at, completed_at,
                created_at, updated_at
           FROM order_florist_assignments
          WHERE order_id = $1 AND workspace_owner_id = $2
          LIMIT 1
          FOR UPDATE`,
        [order.id, wreq.workspaceOwnerId],
      );
      const assignment = assignmentResult.rows[0];

      if (!assignment) {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "florist_assignment_conflict",
          error:
            "The florist assignment has already been removed or changed. Refresh and try again.",
        });
        return;
      }

      if (assignment.status === "completed") {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "assignment_completed",
          error: "A completed florist assignment cannot be unassigned.",
        });
        return;
      }

      if (!["pending", "in_progress", "paused"].includes(assignment.status)) {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "florist_assignment_conflict",
          error:
            "The florist assignment changed and cannot be unassigned. Refresh and try again.",
        });
        return;
      }

      // Fulfillment has moved beyond florist preparation. Do not allow an
      // operations action to make a later order look new again.
      if (
        ["ready_for_delivery", "out_for_delivery", "delivered", "completed"].includes(
          order.status,
        )
      ) {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "order_fulfillment_started",
          error:
            "This order has moved past florist preparation and cannot be unassigned.",
        });
        return;
      }

      const deleted = await client.query<AssignmentRow>(
        `DELETE FROM order_florist_assignments
          WHERE id = $1 AND order_id = $2 AND workspace_owner_id = $3
            AND status IN ('pending', 'in_progress', 'paused')
          RETURNING id, order_id, location_id, status, started_at, completed_at,
                    created_at, updated_at`,
        [assignment.id, order.id, wreq.workspaceOwnerId],
      );
      if (deleted.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "florist_assignment_conflict",
          error:
            "The florist assignment changed while it was being unassigned. Refresh and try again.",
        });
        return;
      }
      removedAssignment = deleted.rows[0];

      if (order.status === "preparing") {
        const reverted = await client.query(
          `UPDATE orders
              SET status = 'processing', updated_at = now()
            WHERE id = $1 AND workspace_owner_id = $2 AND status = 'preparing'`,
          [order.id, wreq.workspaceOwnerId],
        );
        if ((reverted.rowCount ?? 0) !== 1) {
          await client.query("ROLLBACK");
          res.status(409).json({
            success: false,
            code: "order_status_conflict",
            error:
              "The order status changed while the florist assignment was being removed. Refresh and try again.",
          });
          return;
        }
        parentStatus = "processing";
        statusReverted = true;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (statusReverted && previousStatus && removedAssignment) {
      void fireWebhookEvent("order.status_updated", wreq.workspaceOwnerId, {
        orderId: parentOrderId,
        appOrderId: externalOrderId,
        status: "processing",
        updatedAt: new Date().toISOString(),
      });
      recordOrderEvent({
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: parentOrderId,
        eventType: "status_changed",
        payload: { from: previousStatus, to: "processing" },
        actorUserId: wreq.userId,
      });
      void notifyOrderStatusEmail(
        parentOrderId,
        externalOrderId ?? parentOrderId,
        "processing",
        wreq.workspaceOwnerId,
      );
    }

    res.json({
      success: true,
      removed_assignment: removedAssignment,
      parent_order_status: parentStatus,
      status_reverted: statusReverted,
    });
  },
);

/**
 * Return the operations moderation state for the current order-items photo.
 * Orders-page access is intentional: this is not a florist lifecycle action.
 */
router.patch(
  "/orders/:id/florist-publication",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!hasPageAccess(wreq, "orders")) {
      res.status(403).json({
        success: false,
        error: "You do not have access to florist photo reviews",
      });
      return;
    }

    const enabled = parseRequiredBoolean(req.body?.enabled);
    const photoSetRev = Number(req.body?.photo_set_rev);
    const privacyFacesClear = parseRequiredBoolean(req.body?.privacy_faces_clear);
    const privacyCardMessageClear = parseRequiredBoolean(
      req.body?.privacy_card_message_clear,
    );
    const privacyAddressClear = parseRequiredBoolean(req.body?.privacy_address_clear);
    const privacyOtherPersonalInfoClear = parseRequiredBoolean(
      req.body?.privacy_other_personal_info_clear,
    );
    if (
      enabled === undefined ||
      !Number.isInteger(photoSetRev) ||
      privacyFacesClear === undefined ||
      privacyCardMessageClear === undefined ||
      privacyAddressClear === undefined ||
      privacyOtherPersonalInfoClear === undefined
    ) {
      res.status(400).json({
        success: false,
        code: "invalid_publication_request",
        error: "enabled, photo_set_rev, and every privacy check are required",
      });
      return;
    }
    if (
      enabled &&
      !(
        privacyFacesClear &&
        privacyCardMessageClear &&
        privacyAddressClear &&
        privacyOtherPersonalInfoClear
      )
    ) {
      res.status(400).json({
        success: false,
        code: "privacy_checks_required",
        error: "Confirm every privacy check before featuring this photo",
      });
      return;
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<AssignmentResponseRow>(
        `SELECT ofa.id, ofa.order_id, ofa.location_id, l.name AS location_name,
                ofa.status, ofa.started_at, ofa.completed_at, ofa.created_at, ofa.updated_at,
                ofa.photo_set_rev, ofa.verification_status,
                o.status AS parent_order_status,
                CASE
                  WHEN ofa.verification_status = 'approved'
                    AND ofa.photo_items_path IS NOT NULL
                    AND ${cardPhotoSatisfiedSql("ofa", "o")}
                  THEN ofa.photo_items_path
                  ELSE NULL
                END AS photo_items_path,
                CASE
                  WHEN ofa.verification_status = 'approved'
                    AND ofa.photo_items_path IS NOT NULL
                    AND ${cardPhotoSatisfiedSql("ofa", "o")}
                  THEN ofa.photo_card_path
                  ELSE NULL
                END AS photo_card_path,
                fpp.publication_status,
                fpp.enabled AS publication_enabled,
                fpp.privacy_faces_clear AS publication_privacy_faces_clear,
                fpp.privacy_card_message_clear AS publication_privacy_card_message_clear,
                fpp.privacy_address_clear AS publication_privacy_address_clear,
                fpp.privacy_other_personal_info_clear,
                fpp.moderated_at AS publication_moderated_at
           FROM order_florist_assignments ofa
           JOIN locations l ON l.id = ofa.location_id
           JOIN orders o
             ON o.id = ofa.order_id
            AND o.workspace_owner_id = ofa.workspace_owner_id
           LEFT JOIN florist_photo_publications fpp
             ON fpp.assignment_id = ofa.id
            AND fpp.photo_set_rev = ofa.photo_set_rev
            AND fpp.source_photo_path = ofa.photo_items_path
          WHERE ofa.order_id = $1 AND ofa.workspace_owner_id = $2
          FOR UPDATE OF ofa, o`,
        [req.params.id, wreq.workspaceOwnerId],
      );
      const assignment = current.rows[0];
      if (!assignment) {
        await client.query("ROLLBACK");
        res.status(404).json({ success: false, error: "Florist assignment not found" });
        return;
      }
      if (!assignment.photo_items_path) {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "photo_missing",
          error: "An approved order-items photo is required before featuring it",
        });
        return;
      }
      if (assignment.verification_status !== "approved") {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "photo_not_approved",
          error: "Only an approved current photo can be featured",
        });
        return;
      }
      if (assignment.parent_order_status !== "completed") {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "order_not_completed",
          error: "The order must be completed before its photo can be featured",
        });
        return;
      }
      if (assignment.photo_set_rev !== photoSetRev) {
        await client.query("ROLLBACK");
        res.status(409).json({
          success: false,
          code: "stale_revision",
          error: "The photo changed. Refresh the order and review the current photo again.",
        });
        return;
      }

      const saved = await client.query<{
        publication_status: string;
        enabled: boolean;
        photo_set_rev: number;
        privacy_faces_clear: boolean;
        privacy_card_message_clear: boolean;
        privacy_address_clear: boolean;
        privacy_other_personal_info_clear: boolean;
        moderated_at: string | null;
      }>(
        `INSERT INTO florist_photo_publications
           (workspace_owner_id, assignment_id, photo_set_rev, source_photo_path,
            publication_status, enabled, next_attempt_at, automatic,
            privacy_faces_clear, privacy_card_message_clear, privacy_address_clear,
            privacy_other_personal_info_clear, public_asset_key, moderated_by, moderated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11, NULL, $12, now())
         ON CONFLICT (assignment_id, photo_set_rev) DO UPDATE
           SET source_photo_path = EXCLUDED.source_photo_path,
               publication_status = EXCLUDED.publication_status,
               enabled = EXCLUDED.enabled,
               next_attempt_at = EXCLUDED.next_attempt_at,
               automatic = false,
               privacy_faces_clear = EXCLUDED.privacy_faces_clear,
               privacy_card_message_clear = EXCLUDED.privacy_card_message_clear,
               privacy_address_clear = EXCLUDED.privacy_address_clear,
               privacy_other_personal_info_clear = EXCLUDED.privacy_other_personal_info_clear,
               public_asset_key = NULL,
               moderated_by = EXCLUDED.moderated_by,
               moderated_at = EXCLUDED.moderated_at,
               last_error = NULL,
               updated_at = now()
         RETURNING publication_status, enabled, photo_set_rev,
                   privacy_faces_clear, privacy_card_message_clear,
                   privacy_address_clear, privacy_other_personal_info_clear,
                   moderated_at`,
        [
          wreq.workspaceOwnerId,
          assignment.id,
          assignment.photo_set_rev,
          assignment.photo_items_path,
          enabled ? "pending" : "stale",
          enabled,
          enabled ? new Date() : null,
          privacyFacesClear,
          privacyCardMessageClear,
          privacyAddressClear,
          privacyOtherPersonalInfoClear,
          wreq.userId ?? null,
        ],
      );
      const savedRow = saved.rows[0];
      let feedEligibility: FloristPublicationEligibility = {
        eligible: false,
        eligible_photo_count: 0,
        reasons: ["minimum_three_photos"],
      };
      try {
        feedEligibility = await getFloristPublicationEligibility(
          client,
          assignment.id,
          wreq.workspaceOwnerId,
        );
      } catch {
        // A guidance query must never turn a successful moderation decision
        // into a failed save. The worker and storefront remain fail-closed.
      }
      await client.query("COMMIT");

      res.json({
        success: true,
        publication: {
          enabled: savedRow.enabled,
          status: savedRow.publication_status as FloristPublicationStatus,
          photo_set_rev: savedRow.photo_set_rev,
          privacy_faces_clear: savedRow.privacy_faces_clear,
          privacy_card_message_clear: savedRow.privacy_card_message_clear,
          privacy_address_clear: savedRow.privacy_address_clear,
          privacy_other_personal_info_clear:
            savedRow.privacy_other_personal_info_clear,
          moderated_at: savedRow.moderated_at,
          feed_eligibility: feedEligibility,
        } satisfies FloristPublicationResponse,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
);

/**
 * Florist queue. Members see only their own florist location's assignments;
 * owners see every location (optionally filtered with ?location_id=). Response
 * excludes customer PII — order number + items + card availability only.
 */
router.get("/florist-orders", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireFloristAccess(wreq, res)) return;
  const memberLocationId = await resolveFloristLocationId(wreq, res);
  if (memberLocationId === undefined) return;

  let locationFilter = memberLocationId;
  if (locationFilter === null && req.query.location_id !== undefined) {
    const parsed = parseInt(String(req.query.location_id), 10);
    if (Number.isNaN(parsed)) {
      res.status(400).json({ success: false, error: "Invalid location_id" });
      return;
    }
    locationFilter = parsed;
  }

  const params: unknown[] = [wreq.workspaceOwnerId];
  let where = `ofa.workspace_owner_id = $1`;
  if (locationFilter !== null) {
    params.push(locationFilter);
    where += ` AND ofa.location_id = $${params.length}`;
  }

  const result = await db.query<{
    id: number;
    order_id: string;
    order_number: string;
    location_id: number;
    location_name: string;
    status: FloristTaskStatus;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
    updated_at: string;
    has_card: boolean;
    has_cake: boolean;
    window_start: string | null;
    window_end: string | null;
    card_message: string | null;
    card_from: string | null;
    card_to: string | null;
    qr_link: string | null;
  } & VerificationStateRow>(
    `SELECT ofa.id, ofa.order_id,
            COALESCE(o.display_order_number, o.external_order_id, o.id::text) AS order_number,
            ofa.location_id, l.name AS location_name,
            ofa.status, ofa.started_at, ofa.completed_at, ofa.created_at, ofa.updated_at,
            (${hasCardMessageSql("o")}) AS has_card,
            EXISTS(SELECT 1 FROM order_line_items WHERE order_id = o.id AND name ILIKE '%cake%') AS has_cake,
            o.window_start, o.window_end,
            o.card_message, o.card_from, o.card_to, o.qr_link,
            o.status AS parent_order_status,${VERIFICATION_STATE_COLUMNS}
       FROM order_florist_assignments ofa
       JOIN orders o ON o.id = ofa.order_id
       JOIN locations l ON l.id = ofa.location_id
      WHERE ${where}
      ORDER BY (ofa.status = 'completed') ASC, ofa.created_at DESC`,
    params,
  );

  // Batch-fetch line items for the returned orders (name/quantity/image only —
  // no prices, no customer details), plus each linked product's recipe (base
  // item name/image/quantity) so florists can see what goes into a product.
  const orderIds = result.rows.map((r) => r.order_id);
  const itemsMap = new Map<
    string,
    {
      name: string;
      quantity: number;
      image_url: string | null;
      custom_input: string | null;
      product_id: number | null;
      description: string | null;
      description_ar: string | null;
      recipe: { base_item_name: string; base_item_image_url: string | null; quantity: string }[];
    }[]
  >();
  if (orderIds.length > 0) {
    const items = await db.query<{
      order_id: string;
      name: string;
      quantity: number;
      image_url: string | null;
      custom_input: string | null;
      product_id: number | null;
      sku: string | null;
    }>(
      `SELECT order_id, name, quantity, image_url, custom_input, product_id, sku
         FROM order_line_items
        WHERE order_id = ANY($1::uuid[])
        ORDER BY name ASC`,
      [orderIds],
    );

    // Read-time fallback for legacy rows stored without a product link:
    // resolve by exact SKU first, then exact (case-insensitive) product name,
    // workspace-scoped and best-effort. This fills in the recipe and the
    // image for orders ingested before write-time linking existed.
    const effectiveProductId = new Map<number, number>(); // item index → product id
    items.rows.forEach((r, idx) => {
      if (r.product_id != null) effectiveProductId.set(idx, r.product_id);
    });
    const unresolved = items.rows
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.product_id == null);
    if (unresolved.length > 0) {
      const skus = [
        ...new Set(
          unresolved
            .map(({ r }) => r.sku?.trim() ?? "")
            .filter((s) => s.length > 0),
        ),
      ];
      const names = [
        ...new Set(
          unresolved
            .map(({ r }) => r.name.trim().toLowerCase())
            .filter((s) => s.length > 0),
        ),
      ];
      if (skus.length > 0 || names.length > 0) {
        try {
          const resolved = await db.query<{
            id: number;
            sku: string | null;
            name: string;
          }>(
            `SELECT id, sku, name FROM products
              WHERE workspace_owner_id = $1
                AND is_archived = false
                AND (sku = ANY($2::text[]) OR lower(name) = ANY($3::text[]))`,
            [wreq.workspaceOwnerId, skus, names],
          );
          const bySku = new Map<string, number>();
          const byName = new Map<string, number>();
          for (const row of resolved.rows) {
            if (row.sku && !bySku.has(row.sku)) bySku.set(row.sku, row.id);
            const key = row.name.trim().toLowerCase();
            if (!byName.has(key)) byName.set(key, row.id);
          }
          for (const { r, idx } of unresolved) {
            const sku = r.sku?.trim() ?? "";
            const matched =
              (sku ? bySku.get(sku) : undefined) ??
              byName.get(r.name.trim().toLowerCase());
            if (matched != null) effectiveProductId.set(idx, matched);
          }
        } catch (err) {
          req.log.warn(
            { err },
            "floristOrders: legacy product resolution failed; returning items without recipe fallback",
          );
        }
      }
    }

    // Resolve recipes for every distinct linked product in one query,
    // workspace-scoped. Items without a product or recipe get an empty list.
    const productIds = [...new Set(effectiveProductId.values())];
    const recipeMap = new Map<
      number,
      { base_item_name: string; base_item_image_url: string | null; quantity: string }[]
    >();
    if (productIds.length > 0) {
      const recipes = await db.query<{
        product_id: number;
        base_item_name: string;
        base_item_image_url: string | null;
        base_item_image_public_path: string | null;
        quantity: string;
      }>(
        `SELECT pr.product_id, bi.name AS base_item_name,
                bi.image_url AS base_item_image_url,
                bi.image_public_path AS base_item_image_public_path,
                pr.quantity
           FROM product_recipes pr
           JOIN base_items bi ON bi.id = pr.base_item_id
          WHERE pr.workspace_owner_id = $1 AND pr.product_id = ANY($2::int[])
          ORDER BY pr.sort_order ASC, pr.id ASC`,
        [wreq.workspaceOwnerId, productIds],
      );
      for (const row of recipes.rows) {
        const arr = recipeMap.get(row.product_id) ?? [];
        arr.push({
          base_item_name: row.base_item_name,
          base_item_image_url:
            buildPublicObjectUrl(row.base_item_image_public_path) ??
            row.base_item_image_url,
          quantity: row.quantity,
        });
        recipeMap.set(row.product_id, arr);
      }
    }

    // Product main images for the image fallback (stored image_url wins),
    // plus descriptions so florists can see what they're preparing.
    const productImageMap = new Map<
      number,
      { publicUrl: string | null; originalUrl: string | null }
    >();
    const productDescriptionMap = new Map<number, string | null>();
    const productDescriptionArMap = new Map<number, string | null>();
    if (productIds.length > 0) {
      const productImages = await db.query<{
        id: number;
        main_image_url: string | null;
        image_public_path: string | null;
        image_display_public_path: string | null;
        description: string | null;
        description_ar: string | null;
      }>(
        `SELECT id, main_image_url, image_public_path,
                image_display_public_path, description, description_ar
           FROM products
          WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
        [wreq.workspaceOwnerId, productIds],
      );
      for (const row of productImages.rows) {
        productImageMap.set(row.id, {
          publicUrl:
            buildPublicObjectUrl(row.image_display_public_path) ??
            buildPublicObjectUrl(row.image_public_path),
          originalUrl: row.main_image_url,
        });
        productDescriptionMap.set(row.id, row.description);
        productDescriptionArMap.set(row.id, row.description_ar);
      }

      // Lazily auto-translate missing Arabic descriptions (best-effort, capped
      // per request so one big list can't stall the response). Successful
      // translations are cached on the product row so each description is
      // translated at most once; failures simply leave description_ar null and
      // the UI falls back to English.
      const MAX_TRANSLATIONS_PER_REQUEST = 5;
      const missingTranslation = productImages.rows.filter(
        (row) =>
          row.description_ar == null &&
          row.description != null &&
          row.description.trim().length > 0,
      );
      const needTranslation = missingTranslation.slice(
        0,
        MAX_TRANSLATIONS_PER_REQUEST,
      );
      if (missingTranslation.length > needTranslation.length) {
        req.log.info(
          {
            deferredProductIds: missingTranslation
              .slice(MAX_TRANSLATIONS_PER_REQUEST)
              .map((r) => r.id),
            cap: MAX_TRANSLATIONS_PER_REQUEST,
          },
          "floristOrders: per-request translation cap reached; remaining descriptions will translate on a later request",
        );
      }
      if (needTranslation.length > 0) {
        await Promise.all(
          needTranslation.map(async (row) => {
            const translated = await translateDescriptionToArabic(
              row.description as string,
              { workspaceOwnerId: wreq.workspaceOwnerId },
            );
            if (!translated) {
              req.log.warn(
                { productId: row.id },
                "floristOrders: Arabic description translation failed or returned empty; UI will fall back to English",
              );
              return;
            }
            productDescriptionArMap.set(row.id, translated);
            try {
              // Never clobber a value written meanwhile.
              await db.query(
                `UPDATE products SET description_ar = $1
                  WHERE id = $2 AND workspace_owner_id = $3 AND description_ar IS NULL`,
                [translated, row.id, wreq.workspaceOwnerId],
              );
            } catch (err) {
              req.log.warn(
                { err, productId: row.id },
                "floristOrders: failed to cache Arabic description",
              );
            }
          }),
        );
      }
    }

    items.rows.forEach((row, idx) => {
      const productId = effectiveProductId.get(idx) ?? null;
      const productImage =
        productId != null ? productImageMap.get(productId) : undefined;
      const arr = itemsMap.get(row.order_id) ?? [];
      arr.push({
        name: row.name,
        quantity: row.quantity,
        image_url:
          productImage?.publicUrl ??
          row.image_url ??
          productImage?.originalUrl ??
          null,
        custom_input: row.custom_input,
        product_id: productId,
        description:
          productId != null ? productDescriptionMap.get(productId) ?? null : null,
        description_ar:
          productId != null ? productDescriptionArMap.get(productId) ?? null : null,
        recipe: (productId != null ? recipeMap.get(productId) : undefined) ?? [],
      });
      itemsMap.set(row.order_id, arr);
    });
  }

  res.json({
    success: true,
    florist_orders: result.rows.map((r) => ({
      ...r,
      items: itemsMap.get(r.order_id) ?? [],
    })),
  });
});

/**
 * Workspace-wide operations queue for complete AI-rejected photo evidence.
 * This is intentionally separate from the location-scoped florist queue.
 */
router.get(
  "/florist-orders/manual-review",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireFloristReviewerAccess(wreq, res)) return;

    const result = await db.query<{
      id: number;
      order_id: string;
      order_number: string;
      location_id: number;
      location_name: string;
      status: FloristTaskStatus;
      photo_items_path: string;
      photo_card_path: string | null;
      photo_card_on_box_path: string | null;
      photo_set_rev: number;
      verification_reason_code: string | null;
      verification_reason: string | null;
      verified_at: string | null;
      updated_at: string;
    }>(
      `SELECT ofa.id, ofa.order_id,
              COALESCE(o.display_order_number, o.external_order_id, o.id::text) AS order_number,
              ofa.location_id, l.name AS location_name, ofa.status,
              ofa.photo_items_path, ofa.photo_card_path, ofa.photo_card_on_box_path,
              ofa.photo_set_rev,
              ofa.verification_result->>'reason_code' AS verification_reason_code,
              ofa.verification_result->>'reason' AS verification_reason,
              ofa.verified_at, ofa.updated_at
         FROM order_florist_assignments ofa
         JOIN orders o
           ON o.id = ofa.order_id
          AND o.workspace_owner_id = ofa.workspace_owner_id
         JOIN locations l
           ON l.id = ofa.location_id
          AND l.workspace_owner_id = ofa.workspace_owner_id
        WHERE ofa.workspace_owner_id = $1
          AND ofa.status <> 'completed'
          AND ofa.verification_status = 'rejected'
          AND ofa.photo_items_path IS NOT NULL
          AND ${cardPhotoSatisfiedSql("ofa", "o")}
        ORDER BY ofa.verified_at ASC NULLS LAST, ofa.updated_at ASC`,
      [wreq.workspaceOwnerId],
    );

    res.json({ success: true, manual_reviews: result.rows });
  },
);

/** Lightweight sidebar badge count using the exact same eligibility filter. */
router.get(
  "/florist-orders/manual-review/count",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireFloristReviewerAccess(wreq, res)) return;

    const result = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM order_florist_assignments ofa
         JOIN orders o
           ON o.id = ofa.order_id
          AND o.workspace_owner_id = ofa.workspace_owner_id
        WHERE ofa.workspace_owner_id = $1
          AND ofa.status <> 'completed'
          AND ofa.verification_status = 'rejected'
          AND ofa.photo_items_path IS NOT NULL
          AND ${cardPhotoSatisfiedSql("ofa", "o")}`,
      [wreq.workspaceOwnerId],
    );
    res.json({ success: true, count: result.rows[0]?.count ?? 0 });
  },
);

/**
 * Atomically override one still-current rejected photo set, then hand it to
 * the existing revision-safe Slack sender. The completion gate is unchanged:
 * Slack must still be delivered before the florist can complete.
 */
router.post(
  "/florist-orders/manual-review/:id/approve",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireFloristReviewerAccess(wreq, res)) return;

    const id = parseInt(String(req.params.id), 10);
    const photoSetRev = Number((req.body ?? {}).photo_set_rev);
    if (Number.isNaN(id) || !Number.isInteger(photoSetRev) || photoSetRev < 0) {
      res.status(400).json({
        success: false,
        error: "A valid assignment id and photo_set_rev are required",
      });
      return;
    }

    const approved = await db.query<
      VerificationStateRow & { location_id: number; order_id: string }
    >(
      `UPDATE order_florist_assignments
          SET verification_status = 'approved',
              verification_result =
                COALESCE(verification_result, '{}'::jsonb)
                || jsonb_build_object(
                  'approved', true,
                  'manual_override', jsonb_build_object(
                    'actor_user_id', $4::text,
                    'overridden_at', to_jsonb(now()),
                    'prior_reason_code', verification_result->'reason_code',
                    'prior_reason', verification_result->'reason'
                  )
                ),
              verified_at = now(),
              verification_started_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND workspace_owner_id = $2
          AND photo_set_rev = $3
          AND status <> 'completed'
          AND verification_status = 'rejected'
          AND photo_items_path IS NOT NULL
          AND (photo_card_path IS NOT NULL
               OR NOT EXISTS (
                 SELECT 1
                   FROM orders o
                  WHERE o.id = order_florist_assignments.order_id
                    AND o.workspace_owner_id = $2
                    AND ${hasCardMessageSql("o")}
               ))
          AND (photo_card_on_box_path IS NOT NULL
               OR NOT EXISTS (
                 SELECT 1
                   FROM orders o
                   JOIN order_line_items oli ON oli.order_id = o.id
                  WHERE o.id = order_florist_assignments.order_id
                    AND o.workspace_owner_id = $2
                    AND ${hasCardMessageSql("o")}
                    AND oli.name ILIKE '%cake%'
               ))
        RETURNING location_id, order_id, ${VERIFICATION_STATE_RETURNING}`,
      [id, wreq.workspaceOwnerId, photoSetRev, wreq.userId],
    );

    if (approved.rowCount === 0) {
      const exists = await db.query(
        `SELECT 1
           FROM order_florist_assignments
          WHERE id = $1 AND workspace_owner_id = $2
          LIMIT 1`,
        [id, wreq.workspaceOwnerId],
      );
      if (exists.rowCount === 0) {
        res.status(404).json({ success: false, error: "Florist review not found" });
        return;
      }
      res.status(409).json({
        success: false,
        code: "state_changed",
        error:
          "This photo set is no longer awaiting review. Refresh before approving.",
      });
      return;
    }

    const row = approved.rows[0];
    const state = verificationState(row);
    void syncApprovedFloristPhotoToTookan(id, wreq.workspaceOwnerId);
    const advance = await autoAdvanceOrderAfterVerification({
      orderId: row.order_id,
      orderExternalId: null,
      workspaceOwnerId: wreq.workspaceOwnerId,
      actorUserId: wreq.userId ?? null,
      log: req.log,
    });
    res.json({
      success: true,
      verification: state,
      order_status_updated: advance.advanced,
    });
  },
);

/**
 * Load an assignment scoped to the workspace, enforcing that non-owner callers
 * may only touch assignments belonging to their own florist location. Sends
 * the error response itself; returns undefined on failure.
 */
type ScopedAssignment = AssignmentRow &
  VerificationStateRow & {
    order_external_id: string | null;
    order_number: string;
    has_card: boolean;
    has_cake: boolean;
    card_message: string | null;
  };

async function loadScopedAssignment(
  wreq: ReturnType<typeof workspace>,
  res: Response,
  assignmentId: string,
): Promise<ScopedAssignment | undefined> {
  if (!requireFloristAccess(wreq, res)) return undefined;
  const memberLocationId = await resolveFloristLocationId(wreq, res);
  if (memberLocationId === undefined) return undefined;

  const id = parseInt(assignmentId, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ success: false, error: "Invalid assignment id" });
    return undefined;
  }

  const result = await db.query<ScopedAssignment>(
    `SELECT ofa.id, ofa.order_id, ofa.location_id, ofa.status,
            ofa.started_at, ofa.completed_at, ofa.created_at, ofa.updated_at,
            o.external_order_id AS order_external_id,
            COALESCE(o.display_order_number, o.external_order_id, o.id::text) AS order_number,
            (${hasCardMessageSql("o")}) AS has_card,
            EXISTS(SELECT 1 FROM order_line_items WHERE order_id = ofa.order_id AND name ILIKE '%cake%') AS has_cake,
            o.card_message,${VERIFICATION_STATE_COLUMNS}
       FROM order_florist_assignments ofa
       JOIN orders o ON o.id = ofa.order_id
      WHERE ofa.id = $1 AND ofa.workspace_owner_id = $2
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  const assignment = result.rows[0];
  if (!assignment) {
    res.status(404).json({ success: false, error: "Florist order not found" });
    return undefined;
  }
  if (memberLocationId !== null && assignment.location_id !== memberLocationId) {
    // Do not reveal that the assignment exists in another location.
    res.status(404).json({ success: false, error: "Florist order not found" });
    return undefined;
  }
  return assignment;
}

/** Start (or resume) a florist task: pending/paused → in_progress. */
router.post(
  "/florist-orders/:id/start",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const assignment = await loadScopedAssignment(wreq, res, String(req.params.id));
    if (!assignment) return;
    if (assignment.status !== "pending" && assignment.status !== "paused") {
      res.status(409).json({
        success: false,
        error: `Cannot start a florist order in status '${assignment.status}'`,
      });
      return;
    }
    const result = await db.query<AssignmentRow>(
      `UPDATE order_florist_assignments
          SET status = 'in_progress',
              started_at = COALESCE(started_at, now()),
              updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2 AND location_id = $3
        RETURNING id, order_id, location_id, status, started_at, completed_at,
                  created_at, updated_at`,
      [assignment.id, wreq.workspaceOwnerId, assignment.location_id],
    );
    if (result.rowCount === 0) {
      res.status(409).json({ success: false, code: "state_changed", error: "The order was reassigned — refresh and try again." });
      return;
    }
    res.json({ success: true, assignment: result.rows[0] });
  },
);

/** Pause an in-progress florist task. */
router.post(
  "/florist-orders/:id/pause",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const assignment = await loadScopedAssignment(wreq, res, String(req.params.id));
    if (!assignment) return;
    if (assignment.status !== "in_progress") {
      res.status(409).json({
        success: false,
        error: `Cannot pause a florist order in status '${assignment.status}'`,
      });
      return;
    }
    const result = await db.query<AssignmentRow>(
      `UPDATE order_florist_assignments
          SET status = 'paused', updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2 AND location_id = $3
        RETURNING id, order_id, location_id, status, started_at, completed_at,
                  created_at, updated_at`,
      [assignment.id, wreq.workspaceOwnerId, assignment.location_id],
    );
    if (result.rowCount === 0) {
      res.status(409).json({ success: false, code: "state_changed", error: "The order was reassigned — refresh and try again." });
      return;
    }
    res.json({ success: true, assignment: result.rows[0] });
  },
);

/**
 * Complete a florist task. Marks the assignment completed and moves the parent
 * order to `ready_for_delivery` (fires the standard status webhook + customer
 * email side effects).
 */
router.post(
  "/florist-orders/:id/complete",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const assignment = await loadScopedAssignment(wreq, res, String(req.params.id));
    if (!assignment) return;
    if (assignment.status !== "in_progress" && assignment.status !== "paused") {
      res.status(409).json({
        success: false,
        error: `Cannot complete a florist order in status '${assignment.status}'`,
      });
      return;
    }

    // Server-side completion gate: card printing/evidence apply only when a
    // card exists; the items photo, AI approval, and Slack delivery always apply.
    // Direct API calls cannot bypass the quality gate.
    if (assignment.has_card && !assignment.card_printed_at) {
      res.status(409).json({
        success: false,
        code: "card_not_printed",
        error: "Print the card message before completing this order.",
      });
      return;
    }
    if (!assignment.photo_items_path || (assignment.has_card && !assignment.photo_card_path)) {
      res.status(409).json({
        success: false,
        code: "photos_required",
        error: assignment.has_card
          ? "Upload both verification photos before completing this order."
          : "Upload the order items photo before completing this order.",
      });
      return;
    }
    if (assignment.has_cake && assignment.has_card && !assignment.photo_card_on_box_path) {
      res.status(409).json({
        success: false,
        code: "photos_required",
        error: "Upload the card-on-box photo before completing this order.",
      });
      return;
    }
    if (assignment.verification_status !== "approved") {
      res.status(409).json({
        success: false,
        code: "verification_required",
        error: "The order photo must pass AI verification before completing this order.",
      });
      return;
    }

    // Atomic completion: the UPDATE itself re-checks every gate predicate so
    // a concurrent photo replacement (which resets verification/Slack state)
    // between the friendly pre-checks above and this statement cannot slip
    // through — the pre-checks only exist to produce specific error codes.
    const result = await db.query<AssignmentRow>(
      `UPDATE order_florist_assignments
          SET status = 'completed', completed_at = now(), updated_at = now()
        WHERE id = $1
          AND workspace_owner_id = $3
          AND location_id = $4
          AND status IN ('in_progress', 'paused')
          AND (card_printed_at IS NOT NULL OR NOT EXISTS (
                SELECT 1 FROM orders o
                 WHERE o.id = order_florist_assignments.order_id
                   AND o.workspace_owner_id = $2
                   AND ${hasCardMessageSql("o")}
              ))
          AND photo_items_path IS NOT NULL
          AND (photo_card_path IS NOT NULL
               OR NOT EXISTS (
                 SELECT 1
                   FROM orders o
                  WHERE o.id = order_florist_assignments.order_id
                    AND o.workspace_owner_id = $2
                    AND ${hasCardMessageSql("o")}
               ))
          AND (photo_card_on_box_path IS NOT NULL
               OR NOT EXISTS (
                 SELECT 1
                   FROM orders o
                   JOIN order_line_items oli ON oli.order_id = o.id
                  WHERE o.id = order_florist_assignments.order_id
                    AND o.workspace_owner_id = $2
                    AND ${hasCardMessageSql("o")}
                    AND oli.name ILIKE '%cake%'
               ))
          AND verification_status = 'approved'
        RETURNING id, order_id, location_id, status, started_at, completed_at,
                  created_at, updated_at`,
      [assignment.id, wreq.workspaceOwnerId, wreq.workspaceOwnerId, assignment.location_id],
    );
    if (result.rowCount === 0) {
      res.status(409).json({
        success: false,
        code: "state_changed",
        error:
          "The order's verification state changed while completing — refresh and complete the photo verification steps again.",
      });
      return;
    }

    // Re-read the current order status: if the auto-advance after verification
    // already moved it to ready_for_delivery, skip the transition and all
    // notification side effects — they already fired at that point.
    const currentStatusRes = await db.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
      [assignment.order_id, wreq.workspaceOwnerId],
    );
    const currentOrderStatus = currentStatusRes.rows[0]?.status ?? null;

    if (currentOrderStatus !== "ready_for_delivery") {
      const transition = await transitionOrderStatus(db, {
        orderId: assignment.order_id,
        newStatus: "ready_for_delivery",
        workspaceOwnerId: wreq.workspaceOwnerId,
        actorUserId: wreq.userId,
      });

      if (!transition.success) {
        req.log.error({ orderId: assignment.order_id, transition }, "orderStatusTransition failed in florist complete");
        res.status(409).json({
          success: false,
          code: transition.error?.code ?? "transition_failed",
          error: "Inventory posting failed",
          detail: transition.error?.detail,
        });
        return;
      }

      void fireWebhookEvent("order.status_updated", wreq.workspaceOwnerId, {
        orderId: assignment.order_id,
        appOrderId: assignment.order_external_id ?? null,
        status: "ready_for_delivery",
        updatedAt: new Date().toISOString(),
      });
      void notifyOrderStatusEmail(
        assignment.order_id,
        assignment.order_external_id ?? assignment.order_id,
        "ready_for_delivery",
        wreq.workspaceOwnerId,
      );
      void notifyOrderStatusWhatsApp(
        assignment.order_id,
        assignment.order_external_id ?? assignment.order_id,
        "ready_for_delivery",
        wreq.workspaceOwnerId,
      );
    }

    res.json({ success: true, assignment: result.rows[0] });
  },
);

/**
 * Gift-card PDF for a florist assignment. Same rendering as the Orders page
 * card PDF, but gated on florist access + location scoping so florists without
 * the Orders page can print the card message.
 */
router.get(
  "/florist-orders/:id/card-pdf",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const assignment = await loadScopedAssignment(wreq, res, String(req.params.id));
    if (!assignment) return;

    const orderResult = await db.query<{
      display_order_number: string | null;
      external_order_id: string | null;
      card_message: string | null;
      card_from: string | null;
      card_to: string | null;
      qr_link: string | null;
    }>(
      `SELECT display_order_number, external_order_id, card_message, card_from, card_to, qr_link
         FROM orders
        WHERE id = $1 AND workspace_owner_id = $2
        LIMIT 1`,
      [assignment.order_id, wreq.workspaceOwnerId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    try {
      const pdf = await buildGiftCardPdf({
        cardTo: order.card_to,
        cardMessage: order.card_message,
        cardFrom: order.card_from,
        qrLink: order.qr_link,
      });
      const ref = String(
        order.display_order_number || order.external_order_id || assignment.order_id,
      ).replace(/[^a-zA-Z0-9_-]/g, "_");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="Card-${ref}.pdf"`);
      res.send(pdf);
    } catch (err) {
      req.log.error({ err }, "Failed to generate florist gift card PDF");
      res.status(500).json({ success: false, error: "Failed to generate card" });
    }
  },
);

// ---------------------------------------------------------------------------
// Photo verification workflow
// ---------------------------------------------------------------------------

const PHOTO_SLOT_COLUMNS = {
  items: "photo_items_path",
  card: "photo_card_path",
  card_on_box: "photo_card_on_box_path",
} as const;
type PhotoSlot = keyof typeof PHOTO_SLOT_COLUMNS;

const PHOTO_ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 5;

function parsePhotoSlot(raw: string): PhotoSlot | null {
  return raw === "items" || raw === "card" || raw === "card_on_box" ? raw : null;
}

async function downloadObjectToBuffer(objectPath: string): Promise<{
  buffer: Buffer;
  mime: string;
  size: number;
}> {
  const file = await objectStorageService.getObjectEntityFile(objectPath);
  const [metadata] = await file.getMetadata();
  const [buffer] = await file.download();
  return {
    buffer,
    mime: (metadata.contentType as string | undefined) ?? "image/jpeg",
    size: Number(metadata.size ?? buffer.length),
  };
}

/**
 * PUT /florist-orders/:id/photos/:slot — attach (or replace) one of the two
 * verification photos. The client uploads to private object storage first
 * (via /storage/uploads/request-url) and registers the resulting objectPath
 * here. Any photo change resets verification + Slack state so an approved
 * set cannot be silently swapped.
 */
router.put(
  "/florist-orders/:id/photos/:slot",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const assignment = await loadScopedAssignment(wreq, res, String(req.params.id));
    if (!assignment) return;
    if (assignment.status === "completed") {
      res.status(409).json({ success: false, error: "Order is already completed" });
      return;
    }
    const slot = parsePhotoSlot(String(req.params.slot));
    if (!slot) {
      res.status(400).json({ success: false, error: "Invalid photo slot" });
      return;
    }
    const objectPath = typeof req.body?.objectPath === "string" ? req.body.objectPath.trim() : "";
    const expectedPrefix = `/objects/${wreq.workspaceOwnerId}/uploads/`;
    if (!objectPath.startsWith(expectedPrefix)) {
      res.status(400).json({ success: false, error: "objectPath must be a private upload of this workspace" });
      return;
    }

    // Server-side type/size validation against the stored object's metadata.
    try {
      const file = await objectStorageService.getObjectEntityFile(objectPath);
      const [metadata] = await file.getMetadata();
      const contentType = (metadata.contentType as string | undefined) ?? "";
      const size = Number(metadata.size ?? 0);
      if (!PHOTO_ALLOWED_TYPES.has(contentType)) {
        res.status(400).json({ success: false, error: "Photo must be a JPEG, PNG, or WebP image" });
        return;
      }
      if (size <= 0 || size > PHOTO_MAX_BYTES) {
        res.status(400).json({ success: false, error: "Photo must be between 1 byte and 15 MB" });
        return;
      }
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(400).json({ success: false, error: "Uploaded photo not found" });
        return;
      }
      throw err;
    }

    const column = PHOTO_SLOT_COLUMNS[slot];
    const result = await db.query<VerificationStateRow>(
      `UPDATE order_florist_assignments
          SET ${column} = $2,
              verification_status = 'none',
              verification_started_at = NULL,
              verification_result = NULL,
              verified_at = NULL,
              slack_pending_at = NULL,
              slack_sent_at = NULL,
              slack_attempted_rev = NULL,
              photo_set_rev = photo_set_rev + 1,
              updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $3 AND location_id = $4
        RETURNING ${VERIFICATION_STATE_RETURNING}`,
      [assignment.id, objectPath, wreq.workspaceOwnerId, assignment.location_id],
    );
    if (result.rowCount === 0) {
      res.status(409).json({ success: false, code: "state_changed", error: "The order was reassigned — refresh and try again." });
      return;
    }
    res.json({ success: true, verification: verificationState(result.rows[0]) });
  },
);

/**
 * DELETE /florist-orders/:id/photos/:slot — remove a verification photo.
 * Also resets verification + Slack state.
 */
router.delete(
  "/florist-orders/:id/photos/:slot",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const assignment = await loadScopedAssignment(wreq, res, String(req.params.id));
    if (!assignment) return;
    if (assignment.status === "completed") {
      res.status(409).json({ success: false, error: "Order is already completed" });
      return;
    }
    const slot = parsePhotoSlot(String(req.params.slot));
    if (!slot) {
      res.status(400).json({ success: false, error: "Invalid photo slot" });
      return;
    }
    const column = PHOTO_SLOT_COLUMNS[slot];
    const result = await db.query<VerificationStateRow>(
      `UPDATE order_florist_assignments
          SET ${column} = NULL,
              verification_status = 'none',
              verification_started_at = NULL,
              verification_result = NULL,
              verified_at = NULL,
              slack_pending_at = NULL,
              slack_sent_at = NULL,
              slack_attempted_rev = NULL,
              photo_set_rev = photo_set_rev + 1,
              updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2 AND location_id = $3
        RETURNING ${VERIFICATION_STATE_RETURNING}`,
      [assignment.id, wreq.workspaceOwnerId, assignment.location_id],
    );
    if (result.rowCount === 0) {
      res.status(409).json({ success: false, code: "state_changed", error: "The order was reassigned — refresh and try again." });
      return;
    }
    res.json({ success: true, verification: verificationState(result.rows[0]) });
  },
);

/**
 * Active preparation states from which a verified florist assignment may
 * advance the parent order to ready_for_delivery. Terminal, off-flow, and
 * already-advanced states are intentionally excluded so a verification that
 * races a cancellation or late delivery update can never regress or resurrect
 * an order.
 *
 * ready_for_delivery is NOT listed — the `allowedFromStatuses` gate in
 * transitionOrderStatus will skip the transition idempotently when the order
 * is already there.
 */
const FLORIST_ADVANCE_ELIGIBLE_STATUSES = ["pending", "processing", "preparing"];

/**
 * Auto-advance the parent order to `ready_for_delivery` immediately after
 * photo verification is approved.
 *
 * Idempotent: if the order is already at `ready_for_delivery` the transition
 * is skipped silently and `{ advanced: false }` is returned. Never throws —
 * any failure is logged and returned as `{ advanced: false }` so the caller's
 * response path is unaffected.
 */
async function autoAdvanceOrderAfterVerification(params: {
  orderId: string;
  orderExternalId: string | null;
  workspaceOwnerId: string;
  actorUserId: string | null;
  log: { error: (obj: unknown, msg?: string) => void };
}): Promise<{ advanced: boolean }> {
  const { orderId, orderExternalId, workspaceOwnerId, actorUserId, log } = params;
  try {
    const transition = await transitionOrderStatus(db, {
      orderId,
      newStatus: "ready_for_delivery",
      workspaceOwnerId,
      actorUserId,
      allowedFromStatuses: FLORIST_ADVANCE_ELIGIBLE_STATUSES,
    });

    if (!transition.success) {
      log.error({ orderId, transition }, "autoAdvanceOrderAfterVerification: transitionOrderStatus failed");
      return { advanced: false };
    }

    if (transition.skipped) {
      // Order is in a terminal, off-flow, or already-advanced state — skip silently.
      return { advanced: false };
    }

    void fireWebhookEvent("order.status_updated", workspaceOwnerId, {
      orderId,
      appOrderId: orderExternalId ?? null,
      status: "ready_for_delivery",
      updatedAt: new Date().toISOString(),
    });
    void notifyOrderStatusEmail(
      orderId,
      orderExternalId ?? orderId,
      "ready_for_delivery",
      workspaceOwnerId,
    );
    void notifyOrderStatusWhatsApp(
      orderId,
      orderExternalId ?? orderId,
      "ready_for_delivery",
      workspaceOwnerId,
    );
    return { advanced: true };
  } catch (err) {
    log.error({ err, orderId }, "autoAdvanceOrderAfterVerification: unexpected error");
    return { advanced: false };
  }
}

/**
 * POST /florist-orders/:id/verify — run AI vision verification of Photo 1
 * (order items) against the order's line items. Uncertainty is a rejection.
 * On approval, the parent order is advanced to ready_for_delivery directly.
 */
router.post(
  "/florist-orders/:id/verify",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const assignment = await loadScopedAssignment(wreq, res, String(req.params.id));
    if (!assignment) return;
    if (assignment.status === "completed") {
      res.status(409).json({ success: false, error: "Order is already completed" });
      return;
    }
    if (!assignment.photo_items_path) {
      res.status(400).json({ success: false, error: "Upload the order items photo first" });
      return;
    }
    if (assignment.has_cake && assignment.has_card && !assignment.photo_card_on_box_path) {
      res.status(400).json({ success: false, error: "Upload all required photos before verifying" });
      return;
    }
    if (assignment.has_card && !assignment.photo_card_path) {
      res.status(400).json({ success: false, code: "card_photo_required", error: "Upload the card message photo before verifying." });
      return;
    }
    if (assignment.verification_status === "approved") {
      res.status(409).json({ success: false, error: "Photo set is already approved" });
      return;
    }

    // Concurrency guard: claim the 'verifying' state; a stale claim (crashed
    // run) older than 3 minutes can be taken over. The claimed photo-set
    // revision and photo path are captured so the final persist can be
    // conditioned on them — a stale AI result from before a photo replacement
    // must never authorize the newer set.
    const claim = await db.query<{ photo_items_path: string; photo_card_on_box_path: string | null; photo_card_path: string | null; photo_set_rev: number }>(
      `UPDATE order_florist_assignments
          SET verification_status = 'verifying', verification_started_at = now(), updated_at = now()
        WHERE id = $1
          AND workspace_owner_id = $2
          AND location_id = $3
          AND verification_status <> 'approved'
          AND (verification_status <> 'verifying'
               OR verification_started_at IS NULL
               OR verification_started_at < now() - interval '3 minutes')
        RETURNING photo_items_path, photo_card_on_box_path, photo_card_path, photo_set_rev`,
      [assignment.id, wreq.workspaceOwnerId, assignment.location_id],
    );
    if (claim.rowCount === 0) {
      res.status(409).json({ success: false, error: "Verification is already in progress" });
      return;
    }
    const claimedRev = claim.rows[0].photo_set_rev;
    const claimedPhotoPath = claim.rows[0].photo_items_path;
    const claimedCardOnBoxPath = claim.rows[0].photo_card_on_box_path;
    const claimedCardPath = claim.rows[0].photo_card_path;

    // Post-claim safety: the card photo may have been removed between the
    // pre-claim scoped read and the claim. Use the path returned by the
    // atomic claim RETURNING (not the pre-load value) so a removal in that
    // window is caught here rather than silently running legibility on a
    // stale path and approving a missing card photo.
    if (assignment.has_card && !claimedCardPath) {
      await db
        .query(
          `UPDATE order_florist_assignments
              SET verification_status = 'none', verification_started_at = NULL, updated_at = now()
            WHERE id = $1 AND workspace_owner_id = $3 AND location_id = $4
              AND verification_status = 'verifying' AND photo_set_rev = $2`,
          [assignment.id, claimedRev, wreq.workspaceOwnerId, assignment.location_id],
        )
        .catch(() => {});
      res.status(400).json({ success: false, code: "card_photo_required", error: "Upload the card message photo before verifying." });
      return;
    }

    try {
      // Expected items from the order's line items.
      const itemsRes = await db.query<{
        name: string;
        quantity: number;
        product_id: number | null;
        sku: string | null;
        effective_product_id: number | null;
      }>(
        `SELECT oli.name, oli.quantity, oli.product_id, oli.sku,
                COALESCE(
                  oli.product_id,
                  (
                    SELECT p.id
                      FROM products p
                     WHERE p.workspace_owner_id = $2
                       AND p.is_archived = false
                       AND (
                         (NULLIF(btrim(oli.sku), '') IS NOT NULL
                          AND p.sku = btrim(oli.sku))
                         OR lower(p.name) = lower(btrim(oli.name))
                       )
                     ORDER BY
                       CASE
                         WHEN NULLIF(btrim(oli.sku), '') IS NOT NULL
                              AND p.sku = btrim(oli.sku) THEN 0
                         ELSE 1
                       END,
                       p.id
                     LIMIT 1
                  )
                ) AS effective_product_id
           FROM order_line_items oli
          WHERE oli.order_id = $1
          ORDER BY oli.id`,
        [assignment.order_id, wreq.workspaceOwnerId],
      );

      // Resolve legacy/external lines using the same workspace-scoped exact SKU
      // then exact case-insensitive name fallback used by the florist queue.
      const effectiveProductId = new Map<number, number>();
      itemsRes.rows.forEach((row, index) => {
        const productId = row.effective_product_id ?? row.product_id;
        if (productId != null) effectiveProductId.set(index, productId);
      });
      // Enrich the model's context: each linked product's description and
      // recipe/base-item composition, so bundles are verified against what
      // they actually contain — not just their marketing name. Best-effort:
      // enrichment failures degrade to bare names, never block verification.
      const productIds = [...new Set(effectiveProductId.values())];
      const productInfo = new Map<number, { main_image_url: string | null; description: string | null }>();
      const recipeByProduct = new Map<number, { name: string; quantity: string }[]>();
      if (productIds.length > 0) {
        const imgRes = await db.query<{
          id: number;
          main_image_url: string | null;
          description: string | null;
        }>(
          `SELECT id, main_image_url, description
             FROM products
            WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
          [wreq.workspaceOwnerId, productIds],
        );
        for (const p of imgRes.rows) {
          productInfo.set(p.id, { main_image_url: p.main_image_url, description: p.description });
        }
        try {
          const recipes = await db.query<{
            product_id: number;
            base_item_name: string;
            quantity: string;
          }>(
            `SELECT pr.product_id, bi.name AS base_item_name, pr.quantity
               FROM product_recipes pr
               JOIN base_items bi ON bi.id = pr.base_item_id
              WHERE pr.workspace_owner_id = $1 AND pr.product_id = ANY($2::int[])
              ORDER BY pr.sort_order ASC, pr.id ASC`,
            [wreq.workspaceOwnerId, productIds],
          );
          for (const row of recipes.rows) {
            const arr = recipeByProduct.get(row.product_id) ?? [];
            arr.push({ name: row.base_item_name, quantity: row.quantity });
            recipeByProduct.set(row.product_id, arr);
          }
        } catch (err) {
          req.log.debug({ err }, "florist verification: recipe enrichment skipped");
        }
      }

      const expectedItems: ExpectedItem[] = itemsRes.rows.map((r, index) => {
        const productId = effectiveProductId.get(index);
        const info = productId != null ? productInfo.get(productId) : undefined;
        const recipe = productId != null ? recipeByProduct.get(productId) : undefined;
        const item: ExpectedItem = {
          name: r.name,
          quantity: Number(r.quantity) || 1,
        };
        if (info?.description) item.description = info.description;
        if (recipe && recipe.length > 0) item.recipe = recipe;
        return item;
      });

      // Product reference images (best-effort, capped), each labeled with the
      // expected-item index it belongs to so the prompt can associate them.
      const referenceImages: ReferenceImage[] = [];
      const referencedProducts = new Set<number>();
      for (let itemIdx = 0; itemIdx < itemsRes.rows.length; itemIdx++) {
        if (referenceImages.length >= MAX_REFERENCE_IMAGES) break;
        const pid = effectiveProductId.get(itemIdx);
        if (pid == null || referencedProducts.has(pid)) continue;
        referencedProducts.add(pid);
        const imageUrl = productInfo.get(pid)?.main_image_url;
        if (!imageUrl) continue;
        try {
          // Only trusted object-storage paths are fetched. External http(s)
          // URLs are intentionally NOT fetched server-side: a controllable
          // product image URL would otherwise be an SSRF vector (internal
          // services, unbounded downloads). Products with external image
          // URLs simply contribute no reference image.
          if (imageUrl.startsWith(`/objects/${wreq.workspaceOwnerId}/uploads/`)) {
            const dl = await downloadObjectToBuffer(imageUrl);
            referenceImages.push({ buffer: dl.buffer, mime: dl.mime, itemIndex: itemIdx });
          }
        } catch (err) {
          req.log.debug({ err, productId: pid }, "florist verification: reference image skipped");
        }
      }

      // Analyze the exact photo captured by the claim (NOT the pre-claim
      // scoped read) — a replacement between load and claim must not let an
      // old image be analyzed while approval persists for the new path.
      const photo = await downloadObjectToBuffer(claimedPhotoPath);
      const itemsOutcome = await runFloristPhotoVerification({
        photo: { buffer: photo.buffer, mime: photo.mime },
        expectedItems,
        referenceImages,
        attribution: { workspaceOwnerId: wreq.workspaceOwnerId, orderId: assignment.order_id },
      });

      // A first-pass missing item is not final. Structured evidence must cover
      // every expected line exactly once; each absent line then gets one focused
      // second look against the original photo and its own catalog references.
      const firstItemAssessments = itemsOutcome.itemAssessments ?? [];
      const hasStructuredAssessments = Object.prototype.hasOwnProperty.call(
        itemsOutcome,
        "itemAssessments",
      );
      const assessmentIndexes = new Set(
        firstItemAssessments.map((assessment) => assessment.itemIndex),
      );
      const assessmentsAreComplete =
        firstItemAssessments.length === expectedItems.length &&
        assessmentIndexes.size === expectedItems.length &&
        firstItemAssessments.every(
          (assessment) =>
            Number.isInteger(assessment.itemIndex) &&
            assessment.itemIndex >= 0 &&
            assessment.itemIndex < expectedItems.length &&
            ["present", "absent", "uncertain"].includes(assessment.status) &&
            typeof assessment.cue === "string" &&
            assessment.cue.trim().length > 0,
        );
      let missingItemConfirmations: typeof firstItemAssessments = [];
      let outcome = itemsOutcome;

      if (hasStructuredAssessments && !assessmentsAreComplete) {
        outcome = {
          ...itemsOutcome,
          approved: false,
          reasonCode: "other",
          reason: "The verification did not provide one valid assessment for every order item. Please retry.",
        };
      } else if (hasStructuredAssessments) {
        const apparentMissing = firstItemAssessments.filter(
          (assessment) => assessment.status === "absent",
        );

        if (apparentMissing.length > 0) {
          missingItemConfirmations = await Promise.all(
            apparentMissing.map((assessment) =>
              runFloristFocusedItemVerification({
                photo: { buffer: photo.buffer, mime: photo.mime },
                expectedItem: expectedItems[assessment.itemIndex],
                itemIndex: assessment.itemIndex,
                referenceImages: referenceImages.filter(
                  (ref) => ref.itemIndex === assessment.itemIndex,
                ),
                attribution: { workspaceOwnerId: wreq.workspaceOwnerId, orderId: assignment.order_id },
              }),
            ),
          );
          const confirmedMissing = missingItemConfirmations.filter(
            (assessment) => assessment.status === "absent",
          );
          if (confirmedMissing.length === 0) {
            outcome = {
              ...itemsOutcome,
              approved: true,
              reasonCode: null,
              reason: null,
            };
          } else {
            const names = confirmedMissing.map(
              (assessment) =>
                expectedItems[assessment.itemIndex]?.name ?? assessment.name,
            );
            outcome = {
              ...itemsOutcome,
              approved: false,
              reasonCode: "missing_item",
              reason:
                names.length === 1
                  ? `${names[0]} is not visible in the prepared-order photo after a focused second check.`
                  : `${names.join(", ")} are not visible in the prepared-order photo after a focused second check.`,
            };
          }
        } else if (itemsOutcome.reasonCode === "missing_item") {
          outcome = {
            ...itemsOutcome,
            approved: true,
            reasonCode: null,
            reason: null,
          };
        } else if (
          itemsOutcome.reasonCode === "unidentifiable_item" &&
          firstItemAssessments.some((assessment) => assessment.status === "uncertain")
        ) {
          outcome = {
            ...itemsOutcome,
            approved: true,
            reasonCode: null,
            reason: null,
          };
        }
      }

      // For cake orders with a card message, also run the lenient card-on-box
      // check (Photo 3). Both checks must pass to approve the whole set.
      if (outcome.approved && assignment.has_cake && assignment.has_card && claimedCardOnBoxPath) {
        const cardOnBoxPhoto = await downloadObjectToBuffer(claimedCardOnBoxPath);
        const cardOnBoxOutcome = await runCardOnBoxVerification({
          photo: { buffer: cardOnBoxPhoto.buffer, mime: cardOnBoxPhoto.mime },
          attribution: { workspaceOwnerId: wreq.workspaceOwnerId, orderId: assignment.order_id },
        });
        if (!cardOnBoxOutcome.approved) {
          outcome = {
            approved: false,
            reasonCode: "other",
            reason: cardOnBoxOutcome.reason ?? "The card-on-box photo did not show a card attached to the arrangement.",
            detectedItems: itemsOutcome.detectedItems,
            itemAssessments: firstItemAssessments,
            raw: null,
          };
        }
      }

      let cardVerification: CardTextVerificationResult | null = null;

      // If the items (and card-on-box) checks passed and this order has a card,
      // additionally verify that the card photo is legible and that its text
      // matches the expected card message. Short-circuit when items/card-on-box
      // already fail.
      if (outcome.approved && assignment.has_card && claimedCardPath) {
        const cardPhoto = await downloadObjectToBuffer(claimedCardPath);
        const cardResult = await runCardTextVerification(
          cardPhoto,
          assignment.card_message ?? "",
          { workspaceOwnerId: wreq.workspaceOwnerId, orderId: assignment.order_id },
        );
        cardVerification = cardResult;
        if (!cardResult.legible) {
          outcome = {
            approved: false,
            reasonCode: "illegible_card",
            reason: cardResult.reason ?? "The card text is not clearly legible. Please retake the card photo.",
            detectedItems: outcome.detectedItems,
            itemAssessments: outcome.itemAssessments,
            raw: outcome.raw,
          };
        } else if (assignment.card_message && !cardResult.approved) {
          // Only enforce message matching when the order actually has a card message.
          outcome = {
            approved: false,
            reasonCode: "card_message_mismatch",
            reason: cardResult.reason ?? "The card text does not match the order message.",
            detectedItems: outcome.detectedItems,
            itemAssessments: outcome.itemAssessments,
            raw: outcome.raw,
          };
        }
      }


      const auditRecord = {
        approved: outcome.approved,
        reason_code: outcome.reasonCode,
        reason: outcome.reason,
        expected_items: expectedItems,
        detected_items: outcome.detectedItems,
        item_assessments: firstItemAssessments,
        missing_item_confirmations: missingItemConfirmations,
        card_verification: cardVerification
          ? {
              expected_text: assignment.card_message ?? "",
              detected_text: cardVerification.detectedText,
              legible: cardVerification.legible,
              approved: cardVerification.approved,
              confidence: cardVerification.confidence ?? null,
              decision_path: cardVerification.decisionPath ?? [],
              passes: cardVerification.evidence ?? [],
              photo_path: claimedCardPath,
            }
          : null,
        model_raw: outcome.raw,
        photo_path: claimedPhotoPath,
      };
      const persisted = await db.query<VerificationStateRow>(
        `UPDATE order_florist_assignments
            SET verification_status = $2,
                verification_result = $3::jsonb,
                verified_at = now(),
                verification_started_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $6
            AND location_id = $7
            AND verification_status = 'verifying'
            AND photo_set_rev = $4
            AND photo_items_path = $5
            AND photo_card_path IS NOT DISTINCT FROM $8
          RETURNING ${VERIFICATION_STATE_RETURNING}`,
        [
          assignment.id,
          outcome.approved ? "approved" : "rejected",
          JSON.stringify(auditRecord),
          claimedRev,
          claimedPhotoPath,
          wreq.workspaceOwnerId,
          assignment.location_id,
          claimedCardPath,
        ],
      );
      if (persisted.rowCount === 0) {
        // The photo set changed mid-run (replacement bumped photo_set_rev —
        // even if a NEWER verify run re-claimed 'verifying' in the meantime,
        // this stale result must not apply to it). Operator re-verifies.
        res.status(409).json({ success: false, error: "Photo changed during verification. Please verify again." });
        return;
      }
      if (outcome.approved) {
        await enqueueRealDeliveryPublication(db, assignment.id, wreq.workspaceOwnerId);
      }

      const state = verificationState(persisted.rows[0]);
      let orderStatusUpdated = false;
      if (outcome.approved) {
        void syncApprovedFloristPhotoToTookan(assignment.id, wreq.workspaceOwnerId);
        const advance = await autoAdvanceOrderAfterVerification({
          orderId: assignment.order_id,
          orderExternalId: assignment.order_external_id,
          workspaceOwnerId: wreq.workspaceOwnerId,
          actorUserId: wreq.userId ?? null,
          log: req.log,
        });
        orderStatusUpdated = advance.advanced;
      }
      res.json({ success: true, verification: state, order_status_updated: orderStatusUpdated });
    } catch (err) {
      // Transport-level failure: release the claim so the operator can retry.
      await db
        .query(
          `UPDATE order_florist_assignments
              SET verification_status = 'none', verification_started_at = NULL, updated_at = now()
            WHERE id = $1 AND workspace_owner_id = $3 AND location_id = $4
              AND verification_status = 'verifying' AND photo_set_rev = $2`,
          [assignment.id, claimedRev, wreq.workspaceOwnerId, assignment.location_id],
        )
        .catch(() => {});
      req.log.error({ err, assignmentId: assignment.id }, "florist photo verification failed");
      res.status(502).json({ success: false, error: "Photo verification failed. Please try again." });
    }
  },
);

export default router;

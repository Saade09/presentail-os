/**
 * routes/recipeConsumptionExceptions.ts
 *
 * REST endpoints for the durable recipe-consumption exception subsystem.
 *
 * Mounts under /inventory/recipe-consumption-exceptions
 *
 * GET  /inventory/recipe-consumption-exceptions
 *   List open/retrying exceptions for the workspace.
 *   Requires: owner OR base_items.view OR base_items.manage
 *
 * GET  /inventory/recipe-consumption-exceptions/:id
 *   Detail view of a single exception including full attempt_history.
 *   Requires: owner OR base_items.view OR base_items.manage
 *
 * POST /inventory/recipe-consumption-exceptions/:id/retry
 *   Lock the exception, re-validate current state, attempt to post the
 *   consumption movement using the original idempotency key, and mark
 *   resolved only after the movement exists/commits.
 *   Requires: owner OR base_items.manage
 *
 * Auth: requireAuth + resolveWorkspace (same pattern as baseItems.ts).
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { postMovement, InventoryError } from "../lib/inventoryService";
import {
  buildConsumptionKey,
  postRecipeConsumption,
  type ExceptionReason,
  type ExceptionStatus,
  type ExceptionSourceSnapshot,
  type ExceptionAttempt,
  type RecipeConsumptionException,
} from "../lib/recipeConsumption";

const router = Router();
const ExceptionIdSchema = z.string().uuid();

router.use(requireAuth, resolveWorkspace);

// ── Permission helpers ─────────────────────────────────────────────────────────

function canView(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceRole === "owner" ||
    (wreq.allowedPages?.includes("base_items.manage") ?? false) ||
    (wreq.allowedPages?.includes("base_items.view") ?? false)
  );
}

function canManage(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceRole === "owner" ||
    (wreq.allowedPages?.includes("base_items.manage") ?? false)
  );
}

// ── DB row type ───────────────────────────────────────────────────────────────

interface ExceptionRow {
  id: string;
  workspace_owner_id: string;
  order_id: string;
  line_item_id: string;
  base_item_id: number | null;
  product_id: number | null;
  location_id: number | null;
  reason: ExceptionReason;
  status: ExceptionStatus;
  idempotency_key: string;
  source_snapshot: ExceptionSourceSnapshot;
  attempt_history: ExceptionAttempt[];
  resolved_movement_id: number | null;
  created_at: string;
  updated_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Append one attempt record to the exception's attempt_history and update status/resolved fields. */
async function recordAttemptResult(
  exceptionId: string,
  workspaceOwnerId: string,
  attempt: ExceptionAttempt,
  resolvedMovementId: number | null,
): Promise<void> {
  const newStatus: ExceptionStatus = attempt.succeeded ? "resolved" : "open";
  await db.query(
    `UPDATE recipe_consumption_exceptions
        SET attempt_history      = attempt_history || $1::jsonb,
            status               = $2,
            resolved_movement_id = CASE WHEN $3::boolean THEN $4 ELSE resolved_movement_id END,
            updated_at           = now()
      WHERE id = $5
        AND workspace_owner_id = $6`,
    [
      JSON.stringify([attempt]),
      newStatus,
      attempt.succeeded,
      resolvedMovementId,
      exceptionId,
      workspaceOwnerId,
    ],
  );
}

// ── GET /inventory/recipe-consumption-exceptions ──────────────────────────────

router.get("/inventory/recipe-consumption-exceptions", async (req: Request, res: Response) => {
  const wreq = workspace(req);
  if (!canView(wreq)) {
    res.status(403).json({ error: "Requires owner, base_items.view, or base_items.manage permission" });
    return;
  }

  try {
    const statusFilter = (req.query.status as string | undefined) ?? "open";
    const validStatuses: ExceptionStatus[] = ["open", "retrying", "resolved"];
    const statuses: ExceptionStatus[] = statusFilter === "all"
      ? validStatuses
      : statusFilter.split(",").filter((s): s is ExceptionStatus =>
          validStatuses.includes(s as ExceptionStatus),
        );

    if (statuses.length === 0) {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }

    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt((req.query.pageSize as string) ?? "50", 10) || 50));
    const offset = (page - 1) * pageSize;

    const result = await db.query<ExceptionRow & { total_count: string }>(
      `SELECT
         e.id, e.workspace_owner_id, e.order_id, e.line_item_id,
         e.base_item_id, e.product_id, e.location_id,
         e.reason, e.status, e.idempotency_key,
         e.source_snapshot, e.attempt_history,
         e.resolved_movement_id, e.created_at, e.updated_at,
         COUNT(*) OVER () AS total_count
       FROM recipe_consumption_exceptions e
       WHERE e.workspace_owner_id = $1
         AND e.status = ANY($2::text[])
       ORDER BY e.created_at DESC
       LIMIT $3 OFFSET $4`,
      [wreq.workspaceOwnerId, statuses, pageSize, offset],
    );

    const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;
    const items = result.rows.map(({ total_count: _tc, ...row }) => row);

    res.json({ items, total, page, pageSize });
  } catch (err) {
    logger.error(
      { err, workspaceOwnerId: wreq.workspaceOwnerId },
      "recipeConsumptionExceptions: GET list failed",
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /inventory/recipe-consumption-exceptions/:id ─────────────────────────

router.get("/inventory/recipe-consumption-exceptions/:id", async (req: Request, res: Response) => {
  const wreq = workspace(req);
  if (!canView(wreq)) {
    res.status(403).json({ error: "Requires owner, base_items.view, or base_items.manage permission" });
    return;
  }

  try {
    const { id } = req.params;
    if (!ExceptionIdSchema.safeParse(id).success) {
      res.status(400).json({ error: "Invalid exception id" });
      return;
    }
    const result = await db.query<ExceptionRow>(
      `SELECT id, workspace_owner_id, order_id, line_item_id,
              base_item_id, product_id, location_id,
              reason, status, idempotency_key,
              source_snapshot, attempt_history,
              resolved_movement_id, created_at, updated_at
         FROM recipe_consumption_exceptions
        WHERE id = $1
          AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: "Exception not found" });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error(
      { err, id: req.params.id, workspaceOwnerId: wreq.workspaceOwnerId },
      "recipeConsumptionExceptions: GET detail failed",
    );
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /inventory/recipe-consumption-exceptions/:id/retry ──────────────────

router.post(
  "/inventory/recipe-consumption-exceptions/:id/retry",
  async (req: Request, res: Response) => {
    const wreq = workspace(req);
    if (!canManage(wreq)) {
      res.status(403).json({ error: "Requires owner or base_items.manage permission" });
      return;
    }

    const { id } = req.params;
    if (!ExceptionIdSchema.safeParse(id).success) {
      res.status(400).json({ error: "Invalid exception id" });
      return;
    }
    const client = await db.connect();

    try {
      await client.query("BEGIN");

      // 1. Lock the exception row — prevents concurrent retries
      const lockResult = await client.query<ExceptionRow>(
        `SELECT id, workspace_owner_id, order_id, line_item_id,
                base_item_id, product_id, location_id,
                reason, status, idempotency_key,
                source_snapshot, attempt_history,
                resolved_movement_id, created_at, updated_at
           FROM recipe_consumption_exceptions
          WHERE id = $1
            AND workspace_owner_id = $2
          FOR UPDATE`,
        [id, wreq.workspaceOwnerId],
      );

      if (lockResult.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Exception not found" });
        return;
      }

      const exc = lockResult.rows[0];

      if (exc.status === "resolved") {
        await client.query("ROLLBACK");
        res.status(409).json({
          error: "Exception already resolved",
          resolvedMovementId: exc.resolved_movement_id,
        });
        return;
      }

      // Mark as retrying
      await client.query(
        `UPDATE recipe_consumption_exceptions
            SET status = 'retrying', updated_at = now()
          WHERE id = $1`,
        [id],
      );

      const attemptedAt = new Date().toISOString();
      const { orderId, lineItemId, baseItemId, productId } = {
        orderId: exc.order_id,
        lineItemId: exc.line_item_id,
        baseItemId: exc.base_item_id,
        productId: exc.product_id,
      };

      // 2. Re-validate current state — location
      //    Re-resolve fulfillment location from live DB data
      const assignmentRow = await client.query<{ location_id: number }>(
        `SELECT location_id FROM order_florist_assignments
          WHERE order_id = $1 AND workspace_owner_id = $2
          LIMIT 1`,
        [orderId, wreq.workspaceOwnerId],
      );
      let locationId: number | null =
        assignmentRow.rowCount && assignmentRow.rows[0]?.location_id
          ? assignmentRow.rows[0].location_id
          : null;

      if (locationId == null) {
        const orderRow = await client.query<{ location_id: number | null }>(
          `SELECT location_id FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
          [orderId, wreq.workspaceOwnerId],
        );
        locationId = orderRow.rows[0]?.location_id ?? null;
      }

      if (locationId == null) {
        // Still missing — record failed attempt and reopen
        const attempt: ExceptionAttempt = {
          attemptedAt,
          reason: "MISSING_FULFILMENT_LOCATION",
          detail: { orderId, lineItemId, baseItemId, productId },
          succeeded: false,
        };
        await client.query(
          `UPDATE recipe_consumption_exceptions
              SET status = 'open',
                  attempt_history = attempt_history || $1::jsonb,
                  updated_at = now()
            WHERE id = $2`,
          [JSON.stringify([attempt]), id],
        );
        await client.query("COMMIT");
        res.status(422).json({
          error: "Retry failed: fulfillment location still missing",
          reason: "MISSING_FULFILMENT_LOCATION",
          attempt,
        });
        return;
      }

      // 3. Re-validate recipe / base item data from live DB
      if (baseItemId == null) {
        const originalOrderedQty = Number(
          exc.source_snapshot.failureDetail?.orderedQty,
        );
        const originalEventCycle = Number(exc.source_snapshot.eventCycle);
        if (
          !Number.isFinite(originalOrderedQty) ||
          originalOrderedQty <= 0 ||
          !Number.isInteger(originalEventCycle) ||
          originalEventCycle < 0
        ) {
          const attempt: ExceptionAttempt = {
            attemptedAt,
            reason: "INTEGRITY_FAILURE",
            detail: {
              orderId,
              lineItemId,
              reason: "Original fulfilment quantity or event cycle is missing",
            },
            succeeded: false,
          };
          await client.query(
            `UPDATE recipe_consumption_exceptions
                SET status = 'open',
                    reason = 'INTEGRITY_FAILURE',
                    attempt_history = attempt_history || $1::jsonb,
                    updated_at = now()
              WHERE id = $2`,
            [JSON.stringify([attempt]), id],
          );
          await client.query("COMMIT");
          res.status(422).json({
            error: "Retry failed: immutable fulfilment snapshot is incomplete",
            reason: "INTEGRITY_FAILURE",
            attempt,
          });
          return;
        }
        const expectedRecipe = await client.query<{ base_item_id: number }>(
          `SELECT DISTINCT pr.base_item_id
             FROM order_line_items oli
             JOIN products p ON p.id = oli.product_id
             JOIN product_recipes pr ON pr.product_id = p.id
             JOIN base_items bi
               ON bi.id = pr.base_item_id
              AND bi.workspace_owner_id = $2
            WHERE oli.id::text = $1
              AND p.workspace_owner_id = $2
            ORDER BY pr.base_item_id`,
          [lineItemId, wreq.workspaceOwnerId],
        );

        if (expectedRecipe.rowCount === 0) {
          // Recipe still missing
          const attempt: ExceptionAttempt = {
            attemptedAt,
            reason: "MISSING_RECIPE",
            detail: { orderId, lineItemId, productId, locationId },
            succeeded: false,
          };
          await client.query(
            `UPDATE recipe_consumption_exceptions
                SET status = 'open',
                    attempt_history = attempt_history || $1::jsonb,
                    location_id = $2,
                    updated_at = now()
              WHERE id = $3`,
            [JSON.stringify([attempt]), locationId, id],
          );
          await client.query("COMMIT");
          res.status(422).json({
            error: "Retry failed: recipe still missing",
            reason: "MISSING_RECIPE",
            attempt,
          });
          return;
        }

        // A missing-recipe exception represents the whole line item, not one
        // ingredient. Re-run the canonical service so a corrected multi-item
        // recipe posts every ingredient with its own stable movement identity.
        const retryResult = await postRecipeConsumption(
          client,
          orderId,
          wreq.workspaceOwnerId,
          {
            fulfillmentCycle: originalEventCycle,
            orderedQuantityOverrides: {
              [lineItemId]: originalOrderedQty,
            },
          },
        );
        const expectedBaseItemIds = expectedRecipe.rows.map((row) => row.base_item_id);
        const expectedMovementKeys = expectedBaseItemIds.map((expectedBaseItemId) =>
          buildConsumptionKey(
            orderId,
            lineItemId,
            expectedBaseItemId,
            originalEventCycle,
          ),
        );
        const activeMovements = await client.query<{ id: number; base_item_id: number }>(
          `SELECT a.id, a.base_item_id
             FROM base_item_stock_adjustments a
            WHERE a.workspace_owner_id = $1
              AND a.order_id = $2
              AND a.order_line_item_id = $3
              AND a.movement_type = 'product_consumption'
              AND a.idempotency_key = ANY($4::text[])
              AND NOT EXISTS (
                SELECT 1
                  FROM base_item_stock_adjustments r
                 WHERE r.reversal_of_id = a.id
                   AND r.movement_type = 'order_cancellation'
              )
            ORDER BY a.id`,
          [wreq.workspaceOwnerId, orderId, lineItemId, expectedMovementKeys],
        );
        const postedBaseItemIds = new Set(
          activeMovements.rows.map((row) => row.base_item_id),
        );
        const missingBaseItemIds = expectedBaseItemIds.filter(
          (expectedId) => !postedBaseItemIds.has(expectedId),
        );

        if (missingBaseItemIds.length > 0) {
          const retryFailure = retryResult.skippedEntries?.find(
            (entry) =>
              entry.lineItemId === lineItemId &&
              entry.baseItemId != null &&
              missingBaseItemIds.includes(entry.baseItemId),
          );
          const reason: ExceptionReason =
            retryFailure?.reason === "MISSING_LEDGER_BASELINE" ||
            retryFailure?.reason === "INSUFFICIENT_STOCK" ||
            retryFailure?.reason === "UNSUPPORTED_UNIT_CONVERSION" ||
            retryFailure?.reason === "INTEGRITY_FAILURE" ||
            retryFailure?.reason === "MISSING_FULFILMENT_LOCATION"
              ? retryFailure.reason
              : "INTEGRITY_FAILURE";
          const attempt: ExceptionAttempt = {
            attemptedAt,
            reason,
            detail: {
              orderId,
              lineItemId,
              expectedBaseItemIds,
              postedMovementIds: activeMovements.rows.map((row) => row.id),
              missingBaseItemIds,
            },
            succeeded: false,
          };
          await client.query(
            `UPDATE recipe_consumption_exceptions
                SET status = 'open',
                    reason = $1,
                    attempt_history = attempt_history || $2::jsonb,
                    location_id = $3,
                    updated_at = now()
              WHERE id = $4`,
            [reason, JSON.stringify([attempt]), locationId, id],
          );
          await client.query("COMMIT");
          res.status(422).json({
            error: "Retry failed: one or more recipe ingredients remain unresolved",
            reason,
            attempt,
          });
          return;
        }

        const movementIds = activeMovements.rows.map((row) => row.id);
        const resolvedMovementId = movementIds[0];
        const successAttempt: ExceptionAttempt = {
          attemptedAt,
          reason: exc.reason,
          detail: {
            movementIds,
            baseItemIds: expectedBaseItemIds,
            locationId,
            note: "Corrected recipe posted through canonical consumption service",
          },
          succeeded: true,
          movementId: resolvedMovementId,
        };
        await client.query(
          `UPDATE recipe_consumption_exceptions
              SET status = 'resolved',
                  resolved_movement_id = $1,
                  attempt_history = attempt_history || $2::jsonb,
                  location_id = $3,
                  updated_at = now()
            WHERE id = $4`,
          [resolvedMovementId, JSON.stringify([successAttempt]), locationId, id],
        );
        await client.query("COMMIT");
        res.json({
          success: true,
          exceptionId: id,
          status: "resolved",
          movementId: resolvedMovementId,
          movementIds,
          note: "Corrected recipe posted in full",
        });
        return;
      }

      const currentBaseItemId = exc.base_item_id as number;

      // 4. Re-resolve quantity / recipe from live DB
      const liveRecipe = await client.query<{
        recipe_qty: string;
        canonical_unit: string;
        ordered_qty: string;
        base_item_name: string;
        product_name: string;
      }>(
        `SELECT
           pr.quantity::text         AS recipe_qty,
           COALESCE(bip.unit, 'unit') AS canonical_unit,
           oli.quantity::text        AS ordered_qty,
           bi.name                   AS base_item_name,
           p.name                    AS product_name
         FROM order_line_items oli
         JOIN products p ON p.id = oli.product_id
         JOIN product_recipes pr ON pr.product_id = p.id AND pr.base_item_id = $3
         JOIN base_items bi ON bi.id = pr.base_item_id
         LEFT JOIN base_item_packages bip ON bip.base_item_id = bi.id AND bip.is_default = true
         WHERE oli.id::text = $1
           AND p.workspace_owner_id = $2
         LIMIT 1`,
        [lineItemId, wreq.workspaceOwnerId, currentBaseItemId],
      );

      if (liveRecipe.rowCount === 0) {
        // Recipe or base item data no longer available
        const attempt: ExceptionAttempt = {
          attemptedAt,
          reason: "MISSING_RECIPE",
          detail: { orderId, lineItemId, baseItemId: currentBaseItemId, locationId },
          succeeded: false,
        };
        await client.query(
          `UPDATE recipe_consumption_exceptions
              SET status = 'open',
                  attempt_history = attempt_history || $1::jsonb,
                  updated_at = now()
            WHERE id = $2`,
          [JSON.stringify([attempt]), id],
        );
        await client.query("COMMIT");
        res.status(422).json({
          error: "Retry failed: recipe/base item data no longer available",
          reason: "MISSING_RECIPE",
          attempt,
        });
        return;
      }

      const liveRow = liveRecipe.rows[0];
      const capturedRecipe =
        exc.source_snapshot.recipeSnapshot &&
        typeof exc.source_snapshot.recipeSnapshot === "object"
          ? (exc.source_snapshot.recipeSnapshot as Record<string, unknown>)
          : null;
      const orderedQty = Number(capturedRecipe?.orderedQty);
      const recipeQty = Number(capturedRecipe?.recipeQty);
      const capturedCanonicalQty = Number(
        capturedRecipe?.canonicalQtyPerLineItem,
      );
      const capturedCanonicalUnit =
        typeof capturedRecipe?.canonicalUnit === "string"
          ? capturedRecipe.canonicalUnit
          : "";
      const capturedBaseItemId = Number(capturedRecipe?.baseItemId);
      const liveOrderedQty = Number(liveRow.ordered_qty);
      const liveRecipeQty = Number(liveRow.recipe_qty);

      if (
        !capturedRecipe ||
        !Number.isFinite(orderedQty) ||
        !Number.isFinite(recipeQty) ||
        !Number.isFinite(capturedCanonicalQty) ||
        orderedQty <= 0 ||
        recipeQty <= 0 ||
        capturedCanonicalQty <= 0 ||
        capturedBaseItemId !== currentBaseItemId ||
        !capturedCanonicalUnit
      ) {
        const attempt: ExceptionAttempt = {
          attemptedAt,
          reason: "INTEGRITY_FAILURE",
          detail: {
            orderId,
            lineItemId,
            baseItemId: currentBaseItemId,
            reason: "Immutable recipe calculation snapshot is missing or invalid",
          },
          succeeded: false,
        };
        await client.query(
          `UPDATE recipe_consumption_exceptions
              SET status = 'open',
                  attempt_history = attempt_history || $1::jsonb,
                  updated_at = now()
            WHERE id = $2`,
          [JSON.stringify([attempt]), id],
        );
        await client.query("COMMIT");
        res.status(422).json({
          error: "Retry failed: immutable recipe snapshot is invalid",
          reason: "INTEGRITY_FAILURE",
          attempt,
        });
        return;
      }
      if (
        liveRow.canonical_unit.trim().toLowerCase() !==
        capturedCanonicalUnit.trim().toLowerCase()
      ) {
        const attempt: ExceptionAttempt = {
          attemptedAt,
          reason: "UNSUPPORTED_UNIT_CONVERSION",
          detail: {
            orderId,
            lineItemId,
            baseItemId: currentBaseItemId,
            capturedCanonicalUnit,
            liveCanonicalUnit: liveRow.canonical_unit,
          },
          succeeded: false,
        };
        await client.query(
          `UPDATE recipe_consumption_exceptions
              SET status = 'open',
                  reason = 'UNSUPPORTED_UNIT_CONVERSION',
                  attempt_history = attempt_history || $1::jsonb,
                  updated_at = now()
            WHERE id = $2`,
          [JSON.stringify([attempt]), id],
        );
        await client.query("COMMIT");
        res.status(422).json({
          error: "Retry failed: canonical unit changed after fulfilment",
          reason: "UNSUPPORTED_UNIT_CONVERSION",
          attempt,
        });
        return;
      }
      if (liveOrderedQty !== orderedQty || liveRecipeQty !== recipeQty) {
        const attempt: ExceptionAttempt = {
          attemptedAt,
          reason: "INTEGRITY_FAILURE",
          detail: {
            orderId,
            lineItemId,
            baseItemId: currentBaseItemId,
            capturedOrderedQty: orderedQty,
            liveOrderedQty,
            capturedRecipeQty: recipeQty,
            liveRecipeQty,
            reason: "Order or recipe quantity changed after physical fulfilment",
          },
          succeeded: false,
        };
        await client.query(
          `UPDATE recipe_consumption_exceptions
              SET status = 'open',
                  reason = 'INTEGRITY_FAILURE',
                  attempt_history = attempt_history || $1::jsonb,
                  updated_at = now()
            WHERE id = $2`,
          [JSON.stringify([attempt]), id],
        );
        await client.query("COMMIT");
        res.status(422).json({
          error: "Retry failed: order or recipe changed after fulfilment",
          reason: "INTEGRITY_FAILURE",
          attempt,
        });
        return;
      }

      // 5. Resolve only against this immutable event identity. A movement from
      // another fulfilment cycle must never satisfy this exception.
      const existingMovementRow = await client.query<{ id: number }>(
        `SELECT id
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1
            AND idempotency_key = $2
            AND movement_type = 'product_consumption'
          LIMIT 1`,
        [wreq.workspaceOwnerId, exc.idempotency_key],
      );

      if (existingMovementRow.rowCount! > 0) {
        const existingMovementId = existingMovementRow.rows[0]?.id ?? null;
        const attempt: ExceptionAttempt = {
          attemptedAt,
          reason: exc.reason,
          detail: { note: "Movement already exists — marking resolved", movementId: existingMovementId },
          succeeded: true,
          movementId: existingMovementId,
        };
        await client.query(
          `UPDATE recipe_consumption_exceptions
              SET status = 'resolved',
                  resolved_movement_id = $1,
                  attempt_history = attempt_history || $2::jsonb,
                  updated_at = now()
            WHERE id = $3`,
          [existingMovementId, JSON.stringify([attempt]), id],
        );
        await client.query("COMMIT");
        res.json({
          success: true,
          exceptionId: id,
          status: "resolved",
          movementId: existingMovementId,
          note: "Movement already existed — exception marked resolved",
        });
        return;
      }

      // 6. Re-check ledger baseline unless allow_negative_stock is on
      const settingsRow = await client.query<{ inventory_allow_negative_stock: boolean }>(
        `SELECT inventory_allow_negative_stock FROM workspace_settings WHERE workspace_owner_id = $1`,
        [wreq.workspaceOwnerId],
      );
      const allowNegative = settingsRow.rows[0]?.inventory_allow_negative_stock ?? false;

      if (!allowNegative) {
        const baselineRow = await client.query<{ cutover_balance: string }>(
          `SELECT cutover_balance FROM base_item_ledger_settings
            WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
          [wreq.workspaceOwnerId, currentBaseItemId, locationId],
        );
        if (baselineRow.rowCount === 0) {
          const attempt: ExceptionAttempt = {
            attemptedAt,
            reason: "MISSING_LEDGER_BASELINE",
            detail: { baseItemId: currentBaseItemId, locationId },
            succeeded: false,
          };
          await client.query(
            `UPDATE recipe_consumption_exceptions
                SET status = 'open',
                    attempt_history = attempt_history || $1::jsonb,
                    updated_at = now()
              WHERE id = $2`,
            [JSON.stringify([attempt]), id],
          );
          await client.query("COMMIT");
          res.status(422).json({
            error: "Retry failed: ledger baseline still missing",
            reason: "MISSING_LEDGER_BASELINE",
            attempt,
          });
          return;
        }
      }

      // 7. Compute quantity and build idempotency key using original event identity
      const canonicalConsumed = capturedCanonicalQty;
      const quantityChange = -canonicalConsumed;

      // Reuse original idempotency key (preserves event identity across retries)
      const idempotencyKey = exc.idempotency_key;

      const recipeSnapshot = {
        ...capturedRecipe,
        retriedFromExceptionId: id,
        retryValidation: {
          productName: liveRow.product_name,
          baseItemName: liveRow.base_item_name,
          liveOrderedQty: String(liveOrderedQty),
          liveRecipeQty: String(liveRecipeQty),
          liveCanonicalUnit: liveRow.canonical_unit,
        },
      };

      // 8. Post the movement — at most once via original idempotency key
      let movementId: number | null = null;
      try {
        const postResult = await postMovement(client, {
          workspaceOwnerId: wreq.workspaceOwnerId,
          baseItemId: currentBaseItemId,
          locationId,
          quantityChange,
          reason: `Order ${orderId} (retry from exception ${id})`,
          movementType: "product_consumption",
          orderId,
          orderLineItemId: lineItemId,
          productId,
          idempotencyKey,
          recipeSnapshot,
          inventoryAllowNegativeStock: allowNegative,
        });

        if (postResult.posted) {
          movementId = postResult.movementId ?? null;
        } else {
          // DB dedup fired — movement already posted via this key; count as resolved
          movementId = postResult.movementId ?? null;
        }
      } catch (err) {
        if (err instanceof InventoryError) {
          const reason: ExceptionReason =
            err.code === "INSUFFICIENT_STOCK"
              ? "INSUFFICIENT_STOCK"
              : "INTEGRITY_FAILURE";
          const attempt: ExceptionAttempt = {
            attemptedAt,
            reason,
            detail: {
              code: err.code,
              baseItemId: currentBaseItemId,
              locationId,
              ...err.detail,
            },
            succeeded: false,
          };
          await client.query(
            `UPDATE recipe_consumption_exceptions
                SET status = 'open',
                    reason = $1,
                    attempt_history = attempt_history || $2::jsonb,
                    updated_at = now()
              WHERE id = $3`,
            [reason, JSON.stringify([attempt]), id],
          );
          await client.query("COMMIT");
          res.status(422).json({
            error:
              reason === "INSUFFICIENT_STOCK"
                ? "Retry failed: insufficient stock"
                : "Retry failed: inventory data is still invalid",
            reason,
            attempt,
          });
          return;
        }
        // Unexpected error — rollback and bubble
        await client.query("ROLLBACK");
        throw err;
      }

      // 9. Verify the movement is now committed by checking it exists in the same txn
      //    (the INSERT or the duplicate check above guarantees it if movementId is set)
      if (movementId == null) {
        // Dedup fired but movementId not returned — look it up
        const lookupRow = await client.query<{ id: number }>(
          `SELECT id FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1
              AND idempotency_key = $2
            LIMIT 1`,
          [wreq.workspaceOwnerId, idempotencyKey],
        );
        movementId = lookupRow.rows[0]?.id ?? null;
      }
      if (movementId == null) {
        throw new Error(
          `Recipe consumption retry ${id} did not create or resolve to a movement`,
        );
      }

      // 10. Mark resolved only after confirming movement exists
      const successAttempt: ExceptionAttempt = {
        attemptedAt,
        reason: exc.reason,
        detail: { movementId, idempotencyKey, locationId, baseItemId: currentBaseItemId },
        succeeded: true,
        movementId,
      };

      await client.query(
        `UPDATE recipe_consumption_exceptions
            SET status = 'resolved',
                resolved_movement_id = $1,
                attempt_history = attempt_history || $2::jsonb,
                updated_at = now()
          WHERE id = $3`,
        [movementId, JSON.stringify([successAttempt]), id],
      );

      await client.query("COMMIT");

      logger.info(
        {
          exceptionId: id,
          orderId,
          lineItemId,
          baseItemId: currentBaseItemId,
          locationId,
          movementId,
          workspaceOwnerId: wreq.workspaceOwnerId,
        },
        "recipeConsumptionExceptions: retry succeeded — exception resolved",
      );

      res.json({
        success: true,
        exceptionId: id,
        status: "resolved",
        movementId,
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error(
        { err, id, workspaceOwnerId: wreq.workspaceOwnerId },
        "recipeConsumptionExceptions: retry failed with unexpected error",
      );
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  },
);

export default router;

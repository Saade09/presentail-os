import { db } from "./db";
import type { Pool, PoolClient } from "pg";
import { logger } from "./logger";
import {
  editTookanDeliveryTask,
  isTookanEnabled,
} from "./tookan";
import {
  objectStorageService,
  buildPublicObjectUrl,
} from "./objectStorage";

type ApprovedFloristPhotoRow = {
  assignment_id: number;
  order_id: string;
  photo_items_path: string;
  photo_set_rev: number;
  verification_status: string;
  tookan_job_id: string;
};

/**
 * Publish the current approved prepared-order photo to the linked Tookan task.
 *
 * This is intentionally fail-soft: florist approval and order status changes
 * must not depend on object storage or Tookan availability. The assignment and
 * order are always scoped together, and the second read after copying is a
 * revision guard against a replacement while the private object is being
 * published.
 */
export async function syncApprovedFloristPhotoToTookan(
  assignmentId: number,
  workspaceOwnerId: string,
): Promise<void> {
  await syncApprovedPhoto({ assignmentId, workspaceOwnerId });
}

/**
 * Order-keyed entry point for Tookan task creation/retry paths, where the
 * florist assignment id is not already loaded.
 */
export async function syncApprovedFloristPhotoForOrderToTookan(
  orderId: string,
  workspaceOwnerId: string,
): Promise<void> {
  await syncApprovedPhoto({ orderId, workspaceOwnerId });
}

async function syncApprovedPhoto(selector: {
  assignmentId?: number;
  orderId?: string;
  workspaceOwnerId: string;
}): Promise<void> {
  const { assignmentId, orderId, workspaceOwnerId } = selector;
  let client: PoolClient | null = null;
  try {
    if (!isTookanEnabled()) return;

    const current = await loadApprovedPhoto(selector);
    if (!current) return;

    const expectedPrefix = `/objects/${workspaceOwnerId}/uploads/`;
    if (!current.photo_items_path.startsWith(expectedPrefix)) {
      logger.warn(
        { assignmentId, workspaceOwnerId },
        "tookan florist photo sync skipped: photo is not a workspace private upload",
      );
      return;
    }

    const publicKey = await objectStorageService.copyPrivateObjectToPublic(
      current.photo_items_path,
      floristPhotoPublicKey(workspaceOwnerId, current.order_id, current.photo_set_rev),
      workspaceOwnerId,
    );
    const publicUrl = buildPublicObjectUrl(publicKey);
    if (!publicUrl) return;

    // A replacement resets verification and increments photo_set_rev. Lock the
    // assignment and order while performing the final check and provider edit:
    // a replacement that started during the storage copy is observed here,
    // while one that starts after this check waits until the current approved
    // image has finished syncing. Competing revision syncs therefore cannot
    // complete out of order and leave Tookan pointing at the older image.
    client = await db.connect();
    await client.query("BEGIN");
    const stillCurrent = await loadApprovedPhoto(
      {
        assignmentId: current.assignment_id,
        workspaceOwnerId,
        photoSetRev: current.photo_set_rev,
        photoItemsPath: current.photo_items_path,
        tookanJobId: current.tookan_job_id,
      },
      client,
      true,
    );
    if (!stillCurrent) {
      await client.query("ROLLBACK");
      client.release();
      client = null;
      logger.info(
        { assignmentId, workspaceOwnerId, photoSetRev: current.photo_set_rev },
        "tookan florist photo sync skipped: approved photo was replaced",
      );
      return;
    }

    await editTookanDeliveryTask(current.tookan_job_id, null, {
      referenceImages: [publicUrl],
    });
    await client.query("COMMIT");
    client.release();
    client = null;
    logger.info(
      {
        assignmentId,
        orderId: current.order_id,
        tookanJobId: current.tookan_job_id,
        photoSetRev: current.photo_set_rev,
      },
      "tookan florist prepared-order photo synced",
    );
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original storage/provider/database error is more useful.
      }
      client.release();
      client = null;
    }
    logger.warn(
      { assignmentId, orderId, workspaceOwnerId, err },
      "tookan florist photo sync failed (non-blocking)",
    );
  }
}

export function floristPhotoPublicKey(
  workspaceOwnerId: string,
  orderId: string,
  photoSetRev: number,
): string {
  return `florist-orders/${workspaceOwnerId}/${orderId}/prepared-order-rev-${photoSetRev}`;
}

async function loadApprovedPhoto(
  selector: {
    assignmentId?: number;
    orderId?: string;
    workspaceOwnerId: string;
    photoSetRev?: number;
    photoItemsPath?: string;
    tookanJobId?: string;
  },
  queryable: Pool | PoolClient = db,
  forUpdate = false,
): Promise<ApprovedFloristPhotoRow | null> {
  const {
    assignmentId,
    orderId,
    workspaceOwnerId,
    photoSetRev,
    photoItemsPath,
    tookanJobId,
  } = selector;
  const predicates = [
    "ofa.verification_status = 'approved'",
    "ofa.photo_items_path IS NOT NULL",
    "o.tookan_job_id IS NOT NULL",
  ];
  const values: unknown[] = [workspaceOwnerId];
  predicates.unshift("ofa.workspace_owner_id = $1");

  if (assignmentId !== undefined) {
    values.push(assignmentId);
    predicates.push(`ofa.id = $${values.length}`);
  } else if (orderId !== undefined) {
    values.push(orderId);
    predicates.push(`ofa.order_id = $${values.length}`);
  } else {
    return null;
  }

  if (photoSetRev !== undefined) {
    values.push(photoSetRev);
    predicates.push(`ofa.photo_set_rev = $${values.length}`);
  }
  if (photoItemsPath !== undefined) {
    values.push(photoItemsPath);
    predicates.push(`ofa.photo_items_path = $${values.length}`);
  }
  if (tookanJobId !== undefined) {
    values.push(tookanJobId);
    predicates.push(`o.tookan_job_id = $${values.length}`);
  }

  const result = await queryable.query<ApprovedFloristPhotoRow>(
    `SELECT ofa.id AS assignment_id,
            ofa.order_id,
            ofa.photo_items_path,
            ofa.photo_set_rev,
            ofa.verification_status,
            o.tookan_job_id
       FROM order_florist_assignments ofa
       JOIN orders o
         ON o.id = ofa.order_id
        AND o.workspace_owner_id = ofa.workspace_owner_id
       WHERE ${predicates.join(" AND ")}
       LIMIT 1
       ${forUpdate ? "FOR UPDATE OF ofa, o" : ""}`,
    values,
  );
  const row = result.rows[0];
  if (
    !row ||
    row.verification_status !== "approved" ||
    !row.photo_items_path ||
    !row.tookan_job_id
  ) {
    return null;
  }
  return row;
}
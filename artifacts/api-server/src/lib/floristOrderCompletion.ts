import type { Pool, PoolClient } from "pg";

type QueryClient = Pool | PoolClient;

/**
 * Mark the florist assignment for an order completed without touching any
 * other workspace's assignment. This is deliberately separate from the
 * florist-side completion route: order completion is allowed to reconcile the
 * assignment without requiring florist photo verification.
 *
 * The status predicate makes the operation idempotent and, together with
 * COALESCE, preserves an existing completion timestamp on repeated updates.
 */
export async function completeFloristAssignmentForOrder(
  client: QueryClient,
  orderId: string,
  workspaceOwnerId: string,
): Promise<void> {
  await client.query(
    `UPDATE order_florist_assignments
        SET status = 'completed',
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
      WHERE order_id = $1
        AND workspace_owner_id = $2
        AND status <> 'completed'`,
    [orderId, workspaceOwnerId],
  );
}

/**
 * Repair assignments left active after their parent order was completed.
 * This is safe to run on every startup and is workspace-scoped through the
 * parent order/assignment join.
 */
export async function reconcileCompletedFloristAssignments(
  client: QueryClient,
): Promise<void> {
  await client.query(`
    UPDATE order_florist_assignments AS assignment
       SET status = 'completed',
           completed_at = COALESCE(assignment.completed_at, now()),
           updated_at = now()
      FROM orders AS order_row
     WHERE order_row.id = assignment.order_id
       AND order_row.workspace_owner_id = assignment.workspace_owner_id
       AND order_row.status = 'completed'
       AND assignment.status <> 'completed'
  `);
}
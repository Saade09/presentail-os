import { db } from "./db.js";

/**
 * Generate the next CMC POS delivery order number for a workspace, in the
 * form `CMC-{SEQUENCE}` (monotonically increasing per workspace, starting
 * at 1001).
 *
 * Race-safety: the sequence is allocated atomically via an
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING seq` against
 * `cmc_order_counters`, keyed by workspace_owner_id. Concurrent callers
 * each receive a distinct sequence value.
 */
export async function generateCmcOrderNumber(workspaceOwnerId: string): Promise<string> {
  const { rows } = await db.query<{ seq: number }>(
    `
    INSERT INTO cmc_order_counters (workspace_owner_id, seq)
    VALUES ($1, 1001)
    ON CONFLICT (workspace_owner_id)
    DO UPDATE SET seq = cmc_order_counters.seq + 1
    RETURNING seq
    `,
    [workspaceOwnerId],
  );

  const seq = rows[0]?.seq ?? 1001;
  return `CMC-${seq}`;
}

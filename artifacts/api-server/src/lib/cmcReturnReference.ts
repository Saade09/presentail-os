import { db } from "./db.js";

/**
 * Generate the next CMC return reference for a workspace, in the form
 * `RET-YYMMDD-NNN` (zero-padded sequential per day per workspace, starting
 * at 001).
 *
 * Race-safety: the sequence is allocated atomically via an
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING seq` against
 * `cmc_return_counters`, keyed by (workspace_owner_id, date_key). Concurrent
 * callers each receive a distinct sequence value.
 *
 * The unique constraint on cmc_returns.reference provides a DB-level backstop
 * in the unlikely event two processes collide across a day boundary.
 */
export async function generateReturnReference(workspaceOwnerId: string): Promise<string> {
  const now = new Date();
  // Format: YYMMDD  e.g. "260810" for 2026-08-10
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const dateKey = `${yy}${mm}${dd}`;

  const { rows } = await db.query<{ seq: number }>(
    `
    INSERT INTO cmc_return_counters (workspace_owner_id, date_key, seq)
    VALUES ($1, $2, 1)
    ON CONFLICT (workspace_owner_id, date_key)
    DO UPDATE SET seq = cmc_return_counters.seq + 1
    RETURNING seq
    `,
    [workspaceOwnerId, dateKey],
  );

  const seq = rows[0]?.seq ?? 1;
  return `RET-${dateKey}-${String(seq).padStart(3, "0")}`;
}

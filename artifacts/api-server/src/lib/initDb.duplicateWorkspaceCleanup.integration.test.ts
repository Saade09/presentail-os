/**
 * Integration tests: exercise cleanupDuplicatePresentailWorkspace against a
 * real PostgreSQL database. Verifies the targeted delete of the duplicate
 * auto-created workspace membership, the data-safety guard, and idempotency
 * (running twice is a no-op).
 *
 * Skips automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { cleanupDuplicatePresentailWorkspace } from "./initDb";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// Must match DUPLICATE_WORKSPACE_OWNER_ID in initDb.ts.
const DUPLICATE_OWNER_ID = "user_3EBoKbIwm2kCtm6L2fWzflvnqel";
const DUPLICATE_EMAIL = "taleb@presentail.com";

describe.skipIf(!DATABASE_URL)(
  "cleanupDuplicatePresentailWorkspace — real DB (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    async function membershipCount(): Promise<number> {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM workspace_members WHERE workspace_owner_id = $1`,
        [DUPLICATE_OWNER_ID],
      );
      return r.rows[0].n as number;
    }

    async function cleanupRows(): Promise<void> {
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [
        DUPLICATE_OWNER_ID,
      ]);
      await pool.query(
        `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
        [DUPLICATE_OWNER_ID],
      );
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanupRows();
      await pool.end();
    });

    beforeEach(async () => {
      await cleanupRows();
    });

    it("deletes the duplicate owner membership when the workspace is empty", async () => {
      await pool.query(
        `INSERT INTO workspace_members
           (workspace_owner_id, member_user_id, member_email, role, joined_at)
         VALUES ($1, $2, $3, 'owner', now())`,
        [DUPLICATE_OWNER_ID, "user_3EWmcHCwXK4X2ihqJPqwu7YjbBB", DUPLICATE_EMAIL],
      );
      expect(await membershipCount()).toBe(1);

      await cleanupDuplicatePresentailWorkspace();

      expect(await membershipCount()).toBe(0);
    });

    it("is idempotent — running twice (and on a DB without the row) is a no-op", async () => {
      // No row present at all (like dev databases).
      await cleanupDuplicatePresentailWorkspace();
      expect(await membershipCount()).toBe(0);

      // With the row: first run deletes, second run is a no-op.
      await pool.query(
        `INSERT INTO workspace_members
           (workspace_owner_id, member_user_id, member_email, role, joined_at)
         VALUES ($1, $2, $3, 'owner', now())`,
        [DUPLICATE_OWNER_ID, "user_3EWmcHCwXK4X2ihqJPqwu7YjbBB", DUPLICATE_EMAIL],
      );
      await cleanupDuplicatePresentailWorkspace();
      await cleanupDuplicatePresentailWorkspace();
      expect(await membershipCount()).toBe(0);
    });

    it("does NOT delete when the workspace has data in a key table (safety guard)", async () => {
      await pool.query(
        `INSERT INTO workspace_members
           (workspace_owner_id, member_user_id, member_email, role, joined_at)
         VALUES ($1, $2, $3, 'owner', now())`,
        [DUPLICATE_OWNER_ID, "user_3EWmcHCwXK4X2ihqJPqwu7YjbBB", DUPLICATE_EMAIL],
      );
      await pool.query(
        `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'Guard Location')`,
        [DUPLICATE_OWNER_ID],
      );

      await cleanupDuplicatePresentailWorkspace();

      // Guard tripped — the membership row must survive.
      expect(await membershipCount()).toBe(1);
    });

    it("does not touch memberships of other workspaces", async () => {
      const OTHER_OWNER = `__other_ws_${Date.now()}`;
      await pool.query(
        `INSERT INTO workspace_members
           (workspace_owner_id, member_user_id, member_email, role, joined_at)
         VALUES ($1, $1, $2, 'owner', now())`,
        [OTHER_OWNER, `owner-${Date.now()}@example.com`],
      );
      try {
        await cleanupDuplicatePresentailWorkspace();
        const r = await pool.query(
          `SELECT count(*)::int AS n FROM workspace_members WHERE workspace_owner_id = $1`,
          [OTHER_OWNER],
        );
        expect(r.rows[0].n).toBe(1);
      } finally {
        await pool.query(
          `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
          [OTHER_OWNER],
        );
      }
    });
  },
);

/**
 * Integration test: confirm that deleting an access_request row automatically
 * removes any referencing notification_seen_ids rows via the ON DELETE CASCADE
 * foreign key added in Task #752.
 *
 * Runs against a real Postgres instance (not mocks) so that the actual
 * constraint behaviour is verified.  The suite skips automatically when
 * DATABASE_URL is not set.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_EMAIL = "cascade-test-notification-seen@example.com";
const USER_ID = "__cascade_test_notification_seen__";

describe.skipIf(!DATABASE_URL)(
  "notification_seen_ids cascade delete — real database (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });

      // Clean up any leftover rows from a previous interrupted run.
      // notification_seen_ids rows are cleaned up explicitly here in case a
      // prior run failed before the cascade could fire (e.g. the FK wasn't
      // present), leaving orphaned rows that would confuse the next run.
      await pool.query(
        `DELETE FROM notification_seen_ids WHERE user_id = $1`,
        [USER_ID],
      );
      await pool.query(
        `DELETE FROM access_requests WHERE requester_email = $1`,
        [OWNER_EMAIL],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      // Belt-and-suspenders cleanup — handles the case where the cascade is
      // broken (exactly the regression this test catches) and the child row
      // was not removed automatically.
      await pool.query(
        `DELETE FROM notification_seen_ids WHERE user_id = $1`,
        [USER_ID],
      );
      await pool.query(
        `DELETE FROM access_requests WHERE requester_email = $1`,
        [OWNER_EMAIL],
      );
      await pool.end();
    });

    it(
      "deleting an access_request cascades to notification_seen_ids and removes the seen row",
      async () => {
        // 1. Insert an access_request.
        const arResult = await pool.query<{ id: number }>(
          `INSERT INTO access_requests (requester_email, status)
           VALUES ($1, 'pending')
           RETURNING id`,
          [OWNER_EMAIL],
        );
        const accessRequestId = arResult.rows[0].id;

        // 2. Insert a notification_seen_ids row that references it.
        await pool.query(
          `INSERT INTO notification_seen_ids (user_id, access_request_id)
           VALUES ($1, $2)`,
          [USER_ID, accessRequestId],
        );

        // Confirm the seen row exists before deletion.
        const beforeDelete = await pool.query<{ cnt: string }>(
          `SELECT count(*) AS cnt FROM notification_seen_ids
            WHERE user_id = $1 AND access_request_id = $2`,
          [USER_ID, accessRequestId],
        );
        expect(
          parseInt(beforeDelete.rows[0].cnt, 10),
          "notification_seen_ids row must exist before the access_request is deleted",
        ).toBe(1);

        // 3. Delete the access_request — the FK cascade should fire.
        await pool.query(`DELETE FROM access_requests WHERE id = $1`, [accessRequestId]);

        // 4. The notification_seen_ids row must be gone.
        const afterDelete = await pool.query<{ cnt: string }>(
          `SELECT count(*) AS cnt FROM notification_seen_ids
            WHERE user_id = $1 AND access_request_id = $2`,
          [USER_ID, accessRequestId],
        );
        expect(
          parseInt(afterDelete.rows[0].cnt, 10),
          "notification_seen_ids row must be removed by ON DELETE CASCADE when the access_request is deleted",
        ).toBe(0);
      },
    );
  },
);

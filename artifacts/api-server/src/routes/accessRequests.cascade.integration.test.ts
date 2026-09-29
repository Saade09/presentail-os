/**
 * Integration test: verifies that deleting an access_requests row automatically
 * removes all referencing notification_seen_ids rows via ON DELETE CASCADE.
 *
 * This exercises the FK constraint added in initDb.ts:
 *   ALTER TABLE notification_seen_ids
 *     ADD CONSTRAINT notification_seen_ids_access_request_id_fkey
 *     FOREIGN KEY (access_request_id)
 *     REFERENCES access_requests(id)
 *     ON DELETE CASCADE;
 *
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const TEST_USER_ID = "__cascade_test_user__";
const TEST_EMAIL = "cascade-test@example.com";

describe.skipIf(!DATABASE_URL)(
  "notification_seen_ids ON DELETE CASCADE — real database (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      await pool.query(
        `DELETE FROM notification_seen_ids WHERE user_id = $1`,
        [TEST_USER_ID],
      );
      await pool.query(
        `DELETE FROM access_requests WHERE requester_email = $1`,
        [TEST_EMAIL],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM notification_seen_ids WHERE user_id = $1`,
        [TEST_USER_ID],
      );
      await pool.query(
        `DELETE FROM access_requests WHERE requester_email = $1`,
        [TEST_EMAIL],
      );
      await pool.end();
    });

    it("deleting an access_request cascades to notification_seen_ids", async () => {
      const arResult = await pool.query<{ id: number }>(
        `INSERT INTO access_requests (requester_email, status)
         VALUES ($1, 'pending')
         RETURNING id`,
        [TEST_EMAIL],
      );
      const requestId = arResult.rows[0].id;

      await pool.query(
        `INSERT INTO notification_seen_ids (user_id, access_request_id)
         VALUES ($1, $2)`,
        [TEST_USER_ID, requestId],
      );

      const beforeDelete = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM notification_seen_ids
          WHERE user_id = $1 AND access_request_id = $2`,
        [TEST_USER_ID, requestId],
      );
      expect(
        parseInt(beforeDelete.rows[0].count, 10),
        "notification_seen_ids row should exist before deletion",
      ).toBe(1);

      await pool.query(`DELETE FROM access_requests WHERE id = $1`, [requestId]);

      const afterDelete = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM notification_seen_ids
          WHERE user_id = $1 AND access_request_id = $2`,
        [TEST_USER_ID, requestId],
      );
      expect(
        parseInt(afterDelete.rows[0].count, 10),
        "notification_seen_ids row must be removed automatically by ON DELETE CASCADE",
      ).toBe(0);
    });

    it("multiple notification_seen_ids rows for the same request are all cascade-deleted", async () => {
      const arResult = await pool.query<{ id: number }>(
        `INSERT INTO access_requests (requester_email, status)
         VALUES ($1, 'pending')
         RETURNING id`,
        [TEST_EMAIL],
      );
      const requestId = arResult.rows[0].id;

      const adminUserIds = [
        "__cascade_admin_a__",
        "__cascade_admin_b__",
        "__cascade_admin_c__",
      ];
      for (const adminId of adminUserIds) {
        await pool.query(
          `INSERT INTO notification_seen_ids (user_id, access_request_id)
           VALUES ($1, $2)`,
          [adminId, requestId],
        );
      }

      const beforeDelete = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM notification_seen_ids WHERE access_request_id = $1`,
        [requestId],
      );
      expect(
        parseInt(beforeDelete.rows[0].count, 10),
        "all three notification_seen_ids rows should exist before deletion",
      ).toBe(3);

      await pool.query(`DELETE FROM access_requests WHERE id = $1`, [requestId]);

      const afterDelete = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM notification_seen_ids WHERE access_request_id = $1`,
        [requestId],
      );
      expect(
        parseInt(afterDelete.rows[0].count, 10),
        "all notification_seen_ids rows must be removed by ON DELETE CASCADE",
      ).toBe(0);

      await pool.query(
        `DELETE FROM notification_seen_ids WHERE user_id = ANY($1)`,
        [adminUserIds],
      );
    });
  },
);

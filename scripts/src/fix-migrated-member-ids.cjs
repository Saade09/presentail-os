/**
 * One-time fix: clear stale old-Clerk member_user_id values for the three
 * migrated non-owner workspace members (sara, tania, mohammad @presentail.com).
 *
 * After this runs their rows look like pending invites and the claimMembership
 * email-match path will pick them up correctly on next sign-in.
 *
 * Also deletes any orphan owner rows that were auto-provisioned when those
 * users first signed in and were incorrectly routed into an empty workspace.
 */

"use strict";

const pg = require("pg");
const { Client } = pg;

const MAIN_WORKSPACE_OWNER_ID = "user_3DCcbYtdoRYrTOqHwKxb1gwXxJR";
const OLD_CLERK_PREFIX = "user_3Cw";
const AFFECTED_EMAILS = [
  "sara@presentail.com",
  "tania@presentail.com",
  "mohammad@presentail.com",
];

(async () => {
  const DST = process.env.DATABASE_URL;
  if (!DST) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: DST });
  await client.connect();

  try {
    await client.query("BEGIN");

    // Step 1: Show current state before changes
    const before = await client.query(
      `SELECT id, workspace_owner_id, member_user_id, member_email, role, joined_at
         FROM workspace_members
        WHERE workspace_owner_id = $1
          AND member_email = ANY($2::text[])
        ORDER BY id`,
      [MAIN_WORKSPACE_OWNER_ID, AFFECTED_EMAILS],
    );
    console.log("Before (main workspace rows for affected emails):");
    console.table(before.rows);

    // Step 2: Clear stale member_user_id and joined_at for rows that still
    // carry an old-Clerk ID (starts with the old prefix).
    const cleared = await client.query(
      `UPDATE workspace_members
          SET member_user_id = NULL,
              joined_at      = NULL
        WHERE workspace_owner_id = $1
          AND member_email       = ANY($2::text[])
          AND member_user_id LIKE $3
          AND joined_at IS NOT NULL
        RETURNING id, member_email, member_user_id, joined_at`,
      [MAIN_WORKSPACE_OWNER_ID, AFFECTED_EMAILS, `${OLD_CLERK_PREFIX}%`],
    );
    console.log(`\nCleared ${cleared.rowCount} stale member_user_id row(s):`);
    console.table(cleared.rows);

    // Step 3: Delete orphan owner rows (workspace_owner_id = member_user_id)
    // created when the user was auto-provisioned into an empty workspace.
    const deleted = await client.query(
      `DELETE FROM workspace_members
        WHERE workspace_owner_id = member_user_id
          AND member_email = ANY($1::text[])
        RETURNING id, workspace_owner_id, member_email`,
      [AFFECTED_EMAILS],
    );
    console.log(`\nDeleted ${deleted.rowCount} orphan owner row(s):`);
    console.table(deleted.rows);

    await client.query("COMMIT");

    // Step 4: Verify final state
    const after = await client.query(
      `SELECT id, workspace_owner_id, member_user_id, member_email, role, joined_at
         FROM workspace_members
        WHERE member_email = ANY($1::text[])
        ORDER BY id`,
      [AFFECTED_EMAILS],
    );
    console.log("\nAfter (all rows for affected emails):");
    console.table(after.rows);

    const pendingCount = after.rows.filter(
      (r) => r.member_user_id === null && r.joined_at === null,
    ).length;
    console.log(
      `\nDone. ${pendingCount} row(s) are now pending invites (member_user_id IS NULL, joined_at IS NULL).`,
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Script failed, transaction rolled back:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
})();

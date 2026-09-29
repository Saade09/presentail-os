/**
 * One-time fix: claim stuck invite rows where the user authenticated but
 * the POST /invite/claim call never completed (member_user_id IS NULL even
 * though the invited user has already joined or exists in Clerk).
 *
 * Two resolution paths:
 *  A) DB-only: the same email already has a joined row in the same workspace →
 *     copy member_user_id + joined_at from that row.
 *  B) Clerk lookup: no joined row exists yet → look up the Clerk user by email,
 *     then set member_user_id = clerk_user_id and joined_at = now().
 *
 * The script is idempotent and safe to re-run.  It performs a DRY-RUN by
 * default; pass --apply to commit changes.
 *
 * Usage:
 *   DATABASE_URL=<url> CLERK_SECRET_KEY=<sk_live_…> node scripts/src/fix-stuck-invites.cjs
 *   DATABASE_URL=<url> CLERK_SECRET_KEY=<sk_live_…> node scripts/src/fix-stuck-invites.cjs --apply
 */

"use strict";

const pg = require("pg");
const https = require("https");
const { Client } = pg;

const DRY_RUN = !process.argv.includes("--apply");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Perform a GET against the Clerk backend API and return parsed JSON. */
function clerkGet(path, secretKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.clerk.com",
      path,
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) {
            reject(new Error(`Clerk API ${res.statusCode}: ${body}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Clerk response: ${body}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Look up a Clerk user by email address.
 * Returns { id, primaryEmailAddress } or null if not found.
 */
async function clerkUserByEmail(email, secretKey) {
  const encoded = encodeURIComponent(email.toLowerCase());
  const data = await clerkGet(`/v1/users?email_address=${encoded}&limit=1`, secretKey);
  const users = Array.isArray(data) ? data : (data.data ?? []);
  if (!users.length) return null;
  return users[0];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const DST = process.env.DATABASE_URL;
  const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

  if (!DST) {
    console.error("ERROR: DATABASE_URL is not set");
    process.exit(1);
  }
  if (!CLERK_SECRET_KEY) {
    console.warn(
      "WARN: CLERK_SECRET_KEY is not set — Clerk lookups will be skipped (only DB-matched rows will be fixed).",
    );
  }

  console.log(
    DRY_RUN
      ? "\n=== DRY RUN (pass --apply to commit changes) ===\n"
      : "\n=== APPLY MODE (changes will be committed) ===\n",
  );

  const client = new Client({ connectionString: DST });
  await client.connect();

  try {
    // ------------------------------------------------------------------
    // 1. Find all stuck invite rows
    // ------------------------------------------------------------------
    const stuckResult = await client.query(
      `SELECT id, workspace_owner_id, member_email, invite_token, invite_expires_at
         FROM workspace_members
        WHERE invite_token IS NOT NULL
          AND member_user_id IS NULL
        ORDER BY id`,
    );

    if (stuckResult.rowCount === 0) {
      console.log("No stuck invite rows found. Nothing to do.");
      return;
    }

    console.log(`Found ${stuckResult.rowCount} stuck invite row(s):\n`);
    console.table(
      stuckResult.rows.map((r) => ({
        id: r.id,
        workspace_owner_id: r.workspace_owner_id,
        member_email: r.member_email,
        invite_expires_at: r.invite_expires_at,
      })),
    );

    // ------------------------------------------------------------------
    // 2. For each stuck row, determine the correct member_user_id
    // ------------------------------------------------------------------
    const fixes = []; // { id, member_email, source, member_user_id, joined_at }

    for (const row of stuckResult.rows) {
      const email = row.member_email.toLowerCase();

      // Path A: joined row already exists in the same workspace
      const joinedResult = await client.query(
        `SELECT member_user_id, joined_at
           FROM workspace_members
          WHERE workspace_owner_id = $1
            AND LOWER(member_email) = $2
            AND member_user_id IS NOT NULL
            AND joined_at IS NOT NULL
          ORDER BY joined_at ASC
          LIMIT 1`,
        [row.workspace_owner_id, email],
      );

      if (joinedResult.rowCount > 0) {
        const joined = joinedResult.rows[0];
        fixes.push({
          id: row.id,
          member_email: row.member_email,
          source: "db-joined-row",
          member_user_id: joined.member_user_id,
          joined_at: joined.joined_at,
        });
        continue;
      }

      // Path B: no joined row — try Clerk lookup
      if (!CLERK_SECRET_KEY) {
        console.warn(
          `  [SKIP] id=${row.id} email=${row.member_email} — no joined row and CLERK_SECRET_KEY not set`,
        );
        continue;
      }

      let clerkUser = null;
      try {
        clerkUser = await clerkUserByEmail(email, CLERK_SECRET_KEY);
      } catch (err) {
        console.warn(`  [WARN] Clerk lookup failed for ${row.member_email}: ${err.message}`);
      }

      if (!clerkUser) {
        console.warn(
          `  [SKIP] id=${row.id} email=${row.member_email} — not found in Clerk (user may not have signed up yet)`,
        );
        continue;
      }

      fixes.push({
        id: row.id,
        member_email: row.member_email,
        source: "clerk-lookup",
        member_user_id: clerkUser.id,
        joined_at: new Date(),
      });
    }

    // ------------------------------------------------------------------
    // 3. Report planned fixes
    // ------------------------------------------------------------------
    if (fixes.length === 0) {
      console.log("\nNo fixable rows found (no matching joined rows or Clerk users).");
      return;
    }

    console.log(`\nPlanned fixes (${fixes.length} row(s)):\n`);
    console.table(
      fixes.map((f) => ({
        id: f.id,
        member_email: f.member_email,
        source: f.source,
        member_user_id: f.member_user_id,
        joined_at: f.joined_at instanceof Date ? f.joined_at.toISOString() : f.joined_at,
      })),
    );

    if (DRY_RUN) {
      console.log("\nDry run complete. Re-run with --apply to commit these changes.");
      return;
    }

    // ------------------------------------------------------------------
    // 4. Apply fixes inside a transaction
    // ------------------------------------------------------------------
    await client.query("BEGIN");

    let applied = 0;
    for (const fix of fixes) {
      const result = await client.query(
        `UPDATE workspace_members
            SET member_user_id = $1,
                joined_at      = $2
          WHERE id = $3
            AND member_user_id IS NULL
          RETURNING id, member_email, member_user_id, joined_at`,
        [fix.member_user_id, fix.joined_at, fix.id],
      );
      if (result.rowCount > 0) {
        console.log(
          `  Fixed id=${fix.id} (${fix.member_email}) via ${fix.source} → member_user_id=${fix.member_user_id}`,
        );
        applied++;
      } else {
        console.warn(
          `  [WARN] id=${fix.id} was already updated before our transaction (skipped).`,
        );
      }
    }

    await client.query("COMMIT");

    // ------------------------------------------------------------------
    // 5. Verify final state for all affected rows
    // ------------------------------------------------------------------
    const ids = fixes.map((f) => f.id);
    const afterResult = await client.query(
      `SELECT id, member_email, member_user_id, joined_at, invite_token
         FROM workspace_members
        WHERE id = ANY($1::int[])
        ORDER BY id`,
      [ids],
    );
    console.log("\nFinal state of affected rows:\n");
    console.table(afterResult.rows);

    const stillStuck = afterResult.rows.filter((r) => r.member_user_id === null).length;
    console.log(
      `\nDone. Applied ${applied}/${fixes.length} fix(es). Still stuck: ${stillStuck}.`,
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nScript failed, transaction rolled back:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
})();

/**
 * One-shot script: create a test CMC branch request in 'submitted' status
 * and push it to Tookan for today, ~1 hour from now.
 *
 * Usage (from repo root):
 *   cd artifacts/api-server && node_modules/.bin/tsx scripts/test-tookan-branch-request.ts
 */
import { db } from "../src/lib/db";
import { createTookanStockRequestTask, isTookanEnabled } from "../src/lib/tookan";

async function run() {
  if (!isTookanEnabled()) {
    console.error("❌ Tookan is not enabled (TOOKAN_API_KEY not set or TOOKAN_ENABLED=false).");
    process.exit(1);
  }

  // TEST_ADDRESS: used when the chosen location has no address in the DB.
  // Tookan requires a non-empty customer_address to accept the task.
  const TEST_ADDRESS = "Al Barsha, Dubai, United Arab Emirates";

  // 1. Find a real workspace + destination location (prefer UAE locations)
  const locResult = await db.query<{
    workspace_owner_id: string;
    loc_id: number;
    loc_name: string;
    address: string | null;
  }>(`
    SELECT wm.workspace_owner_id,
           l.id        AS loc_id,
           l.name      AS loc_name,
           l.address
    FROM   workspace_members wm
    JOIN   locations l ON l.workspace_owner_id = wm.workspace_owner_id
    WHERE  NOT l.name ILIKE '%e2e%'
    ORDER  BY CASE WHEN l.country = 'United Arab Emirates' THEN 0 ELSE 1 END, l.id
    LIMIT  5
  `);

  if (locResult.rows.length === 0) {
    console.error("❌ No workspace + location found. Make sure the DB is seeded.");
    process.exit(1);
  }

  const row = locResult.rows.find((r) => r.address) ?? locResult.rows[0];
  const { workspace_owner_id, loc_id, loc_name } = row;
  const address = row.address ?? TEST_ADDRESS;

  // If the location has no address, temporarily set one so createTookanStockRequestTask
  // can build a non-empty customer_address (Tookan rejects empty addresses).
  let patchedAddress = false;
  if (!row.address) {
    await db.query(
      `UPDATE locations SET address = $1 WHERE id = $2`,
      [TEST_ADDRESS, loc_id],
    );
    patchedAddress = true;
    console.log(`ℹ️  Patched location ${loc_id} address → "${TEST_ADDRESS}" (will restore after test)`);
  }

  console.log(`Workspace : ${workspace_owner_id}`);
  console.log(`Location  : ${loc_id} — ${loc_name} (${address})`);

  // 2. needed_by = 1 hour from now
  const neededBy = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  console.log(`needed_by : ${neededBy}`);

  // 3. Insert branch request in 'submitted' status directly
  //    (we skip draft→submit transition to keep this script self-contained)
  const reqResult = await db.query<{ id: string }>(`
    INSERT INTO cmc_requests
      (workspace_owner_id, destination_location_id, purpose, priority,
       needed_by, notes, created_by_user_id, status)
    VALUES ($1, $2, 'stock_replenishment', 'normal',
            $3, 'TEST — sent by test-tookan-branch-request script', $4, 'submitted')
    RETURNING id
  `, [workspace_owner_id, loc_id, neededBy, workspace_owner_id]);

  const requestId = reqResult.rows[0].id;
  console.log(`\nCreated request: ${requestId}`);

  // 4. Add a test line item
  await db.query(`
    INSERT INTO cmc_request_line_items (request_id, name, requested_qty)
    VALUES ($1, 'Test Product A', 3)
  `, [requestId]);
  console.log("Line item  : 3 x Test Product A");

  // 5. Log the submit event
  await db.query(`
    INSERT INTO cmc_request_events (request_id, actor_user_id, from_status, to_status, notes)
    VALUES ($1, $2, 'draft', 'submitted', 'auto-submitted by test script')
  `, [requestId, workspace_owner_id]);

  // 6. Call the real createTookanStockRequestTask (same code as the submit transition)
  console.log("\nCalling createTookanStockRequestTask …");
  await createTookanStockRequestTask(requestId, workspace_owner_id);

  // 7. Read back the result
  const check = await db.query<{
    tookan_job_id: string | null;
    tookan_task_id: string | null;
  }>(`SELECT tookan_job_id, tookan_task_id FROM cmc_requests WHERE id = $1`, [requestId]);

  const { tookan_job_id, tookan_task_id } = check.rows[0];

  // 8. Restore the location address if we patched it
  if (patchedAddress) {
    await db.query(`UPDATE locations SET address = NULL WHERE id = $1`, [loc_id]);
    console.log(`ℹ️  Restored location ${loc_id} address → NULL`);
  }

  if (tookan_job_id && tookan_job_id !== "pending") {
    console.log(`\n✅ Tookan task created!`);
    console.log(`   tookan_job_id  : ${tookan_job_id}`);
    console.log(`   tookan_task_id : ${tookan_task_id}`);
    console.log(`   request id     : ${requestId}`);
  } else {
    console.error(`\n❌ Tookan task creation failed — tookan_job_id=${tookan_job_id ?? "NULL"}`);
    console.error("   Check api-server logs for the error detail.");
    if (patchedAddress) {
      await db.query(`UPDATE locations SET address = NULL WHERE id = $1`, [loc_id]);
    }
    process.exit(1);
  }
}

run()
  .catch((e) => {
    console.error("Fatal:", e.message ?? e);
    process.exit(1);
  })
  .finally(() => db.end());

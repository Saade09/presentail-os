/**
 * One-shot script: create a test CMC branch request and push it to Tookan
 * for today, ~1 hour from now.
 *
 * Usage: node artifacts/api-server/scripts/test-tookan-branch-request.mjs
 */
import pg from "pg";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

async function run() {
  // 1. Find a workspace that has locations with addresses
  const wsResult = await db.query(`
    SELECT wm.workspace_owner_id, l.id AS loc_id, l.name AS loc_name, l.address
    FROM workspace_members wm
    JOIN locations l ON l.workspace_owner_id = wm.workspace_owner_id
    WHERE l.address IS NOT NULL AND l.address != ''
    ORDER BY l.id
    LIMIT 1
  `);

  if (wsResult.rows.length === 0) {
    // Fallback: any workspace + any location (even without address)
    const fbWs = await db.query(`SELECT DISTINCT workspace_owner_id FROM workspace_members LIMIT 1`);
    const fbLoc = await db.query(`SELECT id, name FROM locations LIMIT 1`);
    if (fbWs.rows.length === 0 || fbLoc.rows.length === 0) {
      throw new Error("No workspace or location found in DB");
    }
    wsResult.rows.push({
      workspace_owner_id: fbWs.rows[0].workspace_owner_id,
      loc_id: fbLoc.rows[0].id,
      loc_name: fbLoc.rows[0].name,
      address: null,
    });
  }

  const { workspace_owner_id, loc_id, loc_name, address } = wsResult.rows[0];
  console.log(`Using workspace: ${workspace_owner_id}`);
  console.log(`Using location: ${loc_id} — ${loc_name} (${address})`);

  // 2. needed_by = 1 hour from now (ISO string)
  const neededBy = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  console.log(`needed_by: ${neededBy}`);

  // 3. Create the branch request in 'draft' status
  const reqResult = await db.query(
    `INSERT INTO cmc_requests
       (workspace_owner_id, destination_location_id, purpose, priority, needed_by, notes, created_by_user_id)
     VALUES ($1, $2, 'stock_replenishment', 'normal', $3, 'Test request from test-tookan script', $4)
     RETURNING id`,
    [workspace_owner_id, loc_id, neededBy, workspace_owner_id],
  );
  const requestId = reqResult.rows[0].id;
  console.log(`Created cmc_request: ${requestId}`);

  // 4. Add a line item
  await db.query(
    `INSERT INTO cmc_request_line_items (request_id, name, requested_qty)
     VALUES ($1, 'Test Product A', 2)`,
    [requestId],
  );
  console.log("Added line item: 2 x Test Product A");

  // 5. Transition to 'submitted'
  await db.query(
    `UPDATE cmc_requests SET status = 'submitted', updated_at = now() WHERE id = $1`,
    [requestId],
  );
  await db.query(
    `INSERT INTO cmc_request_events (request_id, actor_user_id, from_status, to_status, notes)
     VALUES ($1, $2, 'draft', 'submitted', 'auto-submitted by test script')`,
    [requestId, workspace_owner_id],
  );
  console.log("Status → submitted");

  // 6. Check if Tookan is enabled via environment variable
  const tookanKey = process.env.TOOKAN_API_KEY;
  if (!tookanKey) {
    console.log("\n⚠️  TOOKAN_API_KEY not set — skipping live Tookan call.");
    console.log("The request is created and submitted in the DB. You can retry Tookan from the dashboard.");
    return;
  }

  // 7. Call Tookan directly (mirrors createTookanStockRequestTask logic)
  const tz = process.env.TOOKAN_TIMEZONE ?? "UTC";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateStr = fmt.format(new Date(neededBy));
  const [dateOnly] = dateStr.split("T");
  const windowStart = `${dateOnly} ${new Date(neededBy).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz })}`;
  const windowEnd = `${dateOnly} ${new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz })}`;

  const payload = {
    api_key: tookanKey,
    order_id: `BR-${requestId.slice(0, 8).toUpperCase()}`,
    job_description: "2 x Test Product A",
    job_pickup_name: "Warehouse",
    job_pickup_phone: "",
    job_pickup_address: address ?? "Dubai, UAE",
    job_delivery_name: loc_name ?? "Branch",
    job_delivery_phone: "",
    job_delivery_address: address ?? "Dubai, UAE",
    job_delivery_datetime: windowStart,
    has_pickup: 0,
    has_delivery: 1,
    layout_type: 0,
    tracking_link: 1,
    timezone: -330,
    auto_assignment: 1,
    tags: "branch_request,test",
  };

  const resp = await fetch("https://api.tookanapp.com/v2/create_task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  console.log("\nTookan response:", JSON.stringify(data, null, 2));

  if (data.status === 200) {
    const jobId = data.data?.job_id ?? data.data?.job_ids?.[0];
    const taskId = data.data?.job_id ?? null;
    await db.query(
      `UPDATE cmc_requests SET tookan_job_id = $1, tookan_task_id = $2, updated_at = now() WHERE id = $3`,
      [String(jobId), String(taskId), requestId],
    );
    console.log(`\n✅ Tookan task created! job_id=${jobId}`);
    console.log(`   Request ID: ${requestId}`);
    console.log(`   View in dashboard: /branch-requests/${requestId}`);
  } else {
    console.error(`\n❌ Tookan error: ${data.message}`);
  }
}

run()
  .catch((e) => { console.error("Fatal:", e.message); process.exit(1); })
  .finally(() => db.end());

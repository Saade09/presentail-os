/**
 * Seed branch print configs
 *
 * Upserts the five branch print configurations (Achrafieh, Dubai, Abu Dhabi,
 * Jdeideh, Jdeideh Central Warehouse) into branch_print_configs for the
 * active workspace.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run seed:branch-print-configs
 *
 * Requires DATABASE_URL to be set. The workspace owner is resolved from
 * workspace_members (the workspace with the most members). In databases with
 * multiple workspaces, set WORKSPACE_OWNER_ID explicitly to override.
 */

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const BRANCHES: Array<{ name: string; machineId: string; printerId: string }> = [
  { name: "Achrafieh", machineId: "ACH-CARD-01", printerId: "KONICA MINOLTA C251I" },
  { name: "Dubai", machineId: "DXB-CARD-01", printerId: "HP Color LaserJet Pro 3203" },
  { name: "Abu Dhabi", machineId: "AD-CARD-01", printerId: "HP Color LaserJet Pro 3203" },
  { name: "Jdeideh", machineId: "JD-CARD-01", printerId: "KONICA MINOLTA C251i" },
  { name: "Jdeideh Central Warehouse", machineId: "724313", printerId: "75172952" },
];

const pool = new Pool({ connectionString: DATABASE_URL });

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    let workspaceOwnerId = process.env.WORKSPACE_OWNER_ID;
    if (!workspaceOwnerId) {
      const res = await client.query<{ workspace_owner_id: string; members: string }>(
        `SELECT workspace_owner_id, COUNT(*) AS members
           FROM workspace_members
          GROUP BY workspace_owner_id
          ORDER BY COUNT(*) DESC, MIN(id) ASC
          LIMIT 1`,
      );
      workspaceOwnerId = res.rows[0]?.workspace_owner_id;
      if (workspaceOwnerId) {
        console.log(
          `Resolved active workspace owner ${workspaceOwnerId} (${res.rows[0].members} members). Set WORKSPACE_OWNER_ID to override.`,
        );
      }
    }
    if (!workspaceOwnerId) {
      throw new Error(
        "No workspace found. Set WORKSPACE_OWNER_ID or ensure workspace_members has rows.",
      );
    }

    const values: string[] = [];
    const params: string[] = [workspaceOwnerId];
    for (const branch of BRANCHES) {
      const base = params.length;
      params.push(branch.name, branch.machineId, branch.printerId);
      values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3})`);
    }

    const result = await client.query<{ name: string; inserted: boolean }>(
      `INSERT INTO branch_print_configs (workspace_owner_id, name, machine_id, printer_id)
       VALUES ${values.join(", ")}
       ON CONFLICT (workspace_owner_id, name)
       DO UPDATE SET
         machine_id = EXCLUDED.machine_id,
         printer_id = EXCLUDED.printer_id,
         updated_at = now()
       RETURNING name, (xmax = 0) AS inserted`,
      params,
    );

    for (const row of result.rows) {
      console.log(
        `${row.inserted ? "Inserted" : "Updated"} branch print config: ${row.name}`,
      );
    }
    console.log(
      `Done. ${result.rows.length} branch print configs upserted for workspace ${workspaceOwnerId}.`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

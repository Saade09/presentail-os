import { Router } from "express";
import { db } from "../lib/db";

const router = Router();

if (process.env.NODE_ENV !== "production") {
  /**
   * POST /test/access-request
   * Seeds a pending access_request row for e2e testing.
   * Body: { ownerEmail, requesterClerkId, requesterEmail, requesterName }
   * Returns: { id }
   */
  router.post("/test/access-request", async (req, res) => {
    const { ownerEmail, requesterClerkId, requesterEmail, requesterName } = req.body ?? {};
    if (!ownerEmail || !requesterClerkId || !requesterEmail || !requesterName) {
      res.status(400).json({
        error: "ownerEmail, requesterClerkId, requesterEmail, and requesterName are required",
      });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        LIMIT 1`,
      [ownerEmail],
    );
    const workspaceOwnerId = ownerResult.rows[0]?.workspace_owner_id;
    if (!workspaceOwnerId) {
      res.status(404).json({ error: "Workspace owner not found" });
      return;
    }

    await db.query(
      `DELETE FROM access_requests
        WHERE requester_clerk_id = $1
          AND workspace_owner_id = $2`,
      [requesterClerkId, workspaceOwnerId],
    );

    const result = await db.query<{ id: number }>(
      `INSERT INTO access_requests
         (workspace_owner_id, requester_clerk_id, requester_email, requester_name, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [workspaceOwnerId, requesterClerkId, requesterEmail, requesterName],
    );

    res.json({ id: result.rows[0].id });
  });

  /**
   * DELETE /test/access-request/:clerkId
   * Removes test access_request rows and any associated workspace_member rows.
   */
  router.delete("/test/access-request/:clerkId", async (req, res) => {
    const { clerkId } = req.params;
    const ownerEmail = typeof req.query.ownerEmail === "string"
      ? req.query.ownerEmail.trim()
      : "";
    if (!ownerEmail) {
      res.status(400).json({ error: "ownerEmail is required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        LIMIT 1`,
      [ownerEmail],
    );
    const workspaceOwnerId = ownerResult.rows[0]?.workspace_owner_id;
    if (!workspaceOwnerId) {
      res.status(404).json({ error: "Workspace owner not found" });
      return;
    }

    const arResult = await db.query<{ requester_email: string }>(
      `SELECT requester_email
         FROM access_requests
        WHERE requester_clerk_id = $1
          AND workspace_owner_id = $2`,
      [clerkId, workspaceOwnerId],
    );
    const email = arResult.rows[0]?.requester_email;
    if (email) {
      await db.query(
        `DELETE FROM workspace_members
          WHERE member_email = $1
            AND workspace_owner_id = $2`,
        [email, workspaceOwnerId],
      );
    }
    await db.query(
      `DELETE FROM access_requests
        WHERE requester_clerk_id = $1
          AND workspace_owner_id = $2`,
      [clerkId, workspaceOwnerId],
    );
    res.json({ ok: true });
  });

  /**
   * POST /test/brand
   * Seeds a brand row (with a primary brand_logos entry) for e2e testing.
   * Body: { ownerEmail, name }
   * Returns: { id }
   */
  router.post("/test/brand", async (req, res) => {
    const { ownerEmail, name } = req.body ?? {};
    if (!ownerEmail || !name) {
      res.status(400).json({ error: "ownerEmail and name are required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        ORDER BY id DESC
        LIMIT 1`,
      [ownerEmail],
    );
    if (ownerResult.rows.length === 0) {
      res.status(404).json({ error: `Owner not found for email: ${ownerEmail}` });
      return;
    }
    const workspaceOwnerId = ownerResult.rows[0].workspace_owner_id;

    // Idempotent cleanup of any leftover brand with this exact name.
    await db.query(
      `DELETE FROM brand_logos
        WHERE brand_id IN (
          SELECT id FROM brands
           WHERE workspace_owner_id = $1 AND lower(name) = lower($2)
        )`,
      [workspaceOwnerId, name],
    );
    await db.query(
      `DELETE FROM brands WHERE workspace_owner_id = $1 AND lower(name) = lower($2)`,
      [workspaceOwnerId, name],
    );

    const logoBuf = Buffer.from("e2e-test-seed-logo");
    const brandResult = await db.query<{ id: number }>(
      `INSERT INTO brands (workspace_owner_id, name, logo_data, logo_mime)
       VALUES ($1, $2, $3, 'image/png')
       RETURNING id`,
      [workspaceOwnerId, name, logoBuf],
    );
    const brandId = brandResult.rows[0].id;
    await db.query(
      `INSERT INTO brand_logos (brand_id, workspace_owner_id, logo_data, logo_mime, sort_order)
       VALUES ($1, $2, $3, 'image/png', 0)`,
      [brandId, workspaceOwnerId, logoBuf],
    );

    res.json({ id: brandId });
  });

  /**
   * DELETE /test/brand/:id
   * Removes a seeded brand and any brand_logos rows referencing it.
   */
  router.delete("/test/brand/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db.query(`DELETE FROM brand_logos WHERE brand_id = $1`, [id]);
    await db.query(`DELETE FROM brands WHERE id = $1`, [id]);
    res.json({ ok: true });
  });

  /**
   * POST /test/role
   * Seeds a workspace_role for e2e testing.
   * Body: { ownerEmail, name }
   * Returns: { id }
   */
  router.post("/test/role", async (req, res) => {
    const { ownerEmail, name } = req.body ?? {};
    if (!ownerEmail || !name) {
      res.status(400).json({ error: "ownerEmail and name are required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        ORDER BY id DESC
        LIMIT 1`,
      [ownerEmail],
    );
    if (ownerResult.rows.length === 0) {
      res.status(404).json({ error: `Owner not found for email: ${ownerEmail}` });
      return;
    }
    const workspaceOwnerId = ownerResult.rows[0].workspace_owner_id;

    await db.query(
      `INSERT INTO workspace_roles (workspace_owner_id, name)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [workspaceOwnerId, name],
    );
    const roleResult = await db.query<{ id: number }>(
      `SELECT id FROM workspace_roles WHERE workspace_owner_id = $1 AND name = $2`,
      [workspaceOwnerId, name],
    );
    res.json({ id: roleResult.rows[0].id });
  });

  /**
   * DELETE /test/role/:id
   * Removes a workspace_role by id.
   */
  router.delete("/test/role/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await db.query(`DELETE FROM workspace_roles WHERE id = $1`, [id]);
    res.json({ ok: true });
  });

  /**
   * POST /test/location
   * Seeds a workspace location for e2e testing.
   * Body: { ownerEmail, name, locationType? }
   * Returns: { id }
   */
  router.post("/test/location", async (req, res) => {
    const { ownerEmail, name, locationType } = req.body ?? {};
    if (!ownerEmail || !name) {
      res.status(400).json({ error: "ownerEmail and name are required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        ORDER BY id DESC
        LIMIT 1`,
      [ownerEmail],
    );
    if (ownerResult.rows.length === 0) {
      res.status(404).json({ error: `Owner not found for email: ${ownerEmail}` });
      return;
    }
    const workspaceOwnerId = ownerResult.rows[0].workspace_owner_id;

    const result = await db.query<{ id: number }>(
      `INSERT INTO locations (workspace_owner_id, name, location_type)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [workspaceOwnerId, name, locationType ?? "Point of Sale"],
    );
    res.json({ id: result.rows[0].id });
  });

  /**
   * DELETE /test/location/:id
   * Removes a seeded location and any member_locations rows referencing it.
   */
  router.delete("/test/location/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db.query(`DELETE FROM member_locations WHERE location_id = $1`, [id]);
    await db.query(`DELETE FROM locations WHERE id = $1`, [id]);
    res.json({ ok: true });
  });

  /**
   * PUT /test/countries
   * Overrides available_countries in workspace_settings for e2e testing.
   * Body: { ownerEmail, countries: string[] }
   * Returns: { ok: true }
   */
  router.put("/test/countries", async (req, res) => {
    const { ownerEmail, countries } = req.body ?? {};
    if (!ownerEmail || !Array.isArray(countries) || countries.length === 0) {
      res.status(400).json({ error: "ownerEmail and a non-empty countries array are required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        ORDER BY id DESC
        LIMIT 1`,
      [ownerEmail],
    );
    if (ownerResult.rows.length === 0) {
      res.status(404).json({ error: `Owner not found for email: ${ownerEmail}` });
      return;
    }
    const workspaceOwnerId = ownerResult.rows[0].workspace_owner_id;

    await db.query(
      `INSERT INTO workspace_settings (workspace_owner_id, offline_alert_threshold_minutes, offline_alert_email_enabled, available_countries)
       VALUES ($1, 5, false, $2)
       ON CONFLICT (workspace_owner_id) DO UPDATE
         SET available_countries = EXCLUDED.available_countries`,
      [workspaceOwnerId, countries],
    );

    res.json({ ok: true });
  });

  /**
   * POST /test/driver
   * Seeds a fleet_drivers row for e2e testing.
   * Body: { ownerEmail, firstName, lastName, phone, vehicleType? }
   * Returns: { id }
   */
  router.post("/test/driver", async (req, res) => {
    const { ownerEmail, firstName, lastName, phone, vehicleType } = req.body ?? {};
    if (!ownerEmail || !firstName || !lastName || !phone) {
      res.status(400).json({ error: "ownerEmail, firstName, lastName, and phone are required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        ORDER BY id DESC
        LIMIT 1`,
      [ownerEmail],
    );
    if (ownerResult.rows.length === 0) {
      res.status(404).json({ error: `Owner not found for email: ${ownerEmail}` });
      return;
    }
    const workspaceOwnerId = ownerResult.rows[0].workspace_owner_id;

    const normalizedPhone = phone.replace(/[^+0-9]/g, "");
    const vt = vehicleType ?? "Car";

    await db.query(
      `INSERT INTO fleet_vehicle_types (workspace_owner_id, name, sort_order)
       VALUES ($1, $2, 0)
       ON CONFLICT (workspace_owner_id, name) DO NOTHING`,
      [workspaceOwnerId, vt],
    );

    // Idempotent cleanup: remove any existing driver with the same normalised
    // phone for this workspace so reruns after partial failures don't 409.
    const existing = await db.query<{ id: number }>(
      `SELECT id FROM fleet_drivers
        WHERE workspace_owner_id = $1
          AND regexp_replace(phone, '[^+0-9]', '', 'g') = $2
          AND deleted_at IS NULL`,
      [workspaceOwnerId, normalizedPhone],
    );
    for (const row of existing.rows) {
      await db.query(`DELETE FROM fleet_driver_order_assignments WHERE driver_id = $1`, [row.id]);
      await db.query(`DELETE FROM fleet_driver_api_tokens WHERE driver_id = $1`, [row.id]);
      await db.query(`DELETE FROM fleet_driver_vehicles WHERE driver_id = $1`, [row.id]);
      await db.query(`DELETE FROM fleet_driver_availability WHERE driver_id = $1`, [row.id]);
      await db.query(`DELETE FROM fleet_drivers WHERE id = $1`, [row.id]);
    }

    const result = await db.query<{ id: number }>(
      `INSERT INTO fleet_drivers
         (workspace_owner_id, first_name, last_name, phone, vehicle_type, onboarding_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [workspaceOwnerId, firstName, lastName, normalizedPhone, vt],
    );

    res.json({ id: result.rows[0].id });
  });

  /**
   * DELETE /test/driver/:id
   * Removes a seeded fleet_drivers row and any dependent rows for e2e cleanup.
   */
  router.delete("/test/driver/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db.query(`DELETE FROM fleet_driver_order_assignments WHERE driver_id = $1`, [id]);
    await db.query(`DELETE FROM fleet_driver_api_tokens WHERE driver_id = $1`, [id]);
    await db.query(`DELETE FROM fleet_driver_vehicles WHERE driver_id = $1`, [id]);
    await db.query(`DELETE FROM fleet_driver_availability WHERE driver_id = $1`, [id]);
    await db.query(`DELETE FROM fleet_drivers WHERE id = $1`, [id]);
    res.json({ ok: true });
  });

  /**
   * GET /test/driver/count?ownerEmail=...&phone=...
   * Returns the count of non-deleted fleet_drivers with that normalised phone
   * for the given workspace owner. Used in e2e tests to verify the DB state
   * after a duplicate-phone rejection.
   */
  router.get("/test/driver/count", async (req, res) => {
    const ownerEmail = req.query.ownerEmail as string | undefined;
    const phone = req.query.phone as string | undefined;
    if (!ownerEmail || !phone) {
      res.status(400).json({ error: "ownerEmail and phone query params are required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        ORDER BY id DESC
        LIMIT 1`,
      [ownerEmail],
    );
    if (ownerResult.rows.length === 0) {
      res.status(404).json({ error: `Owner not found for email: ${ownerEmail}` });
      return;
    }
    const workspaceOwnerId = ownerResult.rows[0].workspace_owner_id;
    const normalizedPhone = phone.replace(/[^+0-9]/g, "");

    const result = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM fleet_drivers
        WHERE workspace_owner_id = $1
          AND regexp_replace(phone, '[^+0-9]', '', 'g') = $2
          AND deleted_at IS NULL`,
      [workspaceOwnerId, normalizedPhone],
    );

    res.json({ count: parseInt(result.rows[0].count, 10) });
  });

  /**
   * DELETE /test/countries
   * Resets available_countries to the default list (Lebanon, United Arab Emirates)
   * for the workspace identified by ownerEmail. Only updates available_countries;
   * all other workspace_settings fields (threshold, email alerts) are left as-is.
   * Body: { ownerEmail }
   */
  router.delete("/test/countries", async (req, res) => {
    const ownerEmail = (req.body ?? {}).ownerEmail ?? req.query.ownerEmail;
    if (!ownerEmail) {
      res.status(400).json({ error: "ownerEmail is required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        ORDER BY id DESC
        LIMIT 1`,
      [ownerEmail],
    );
    if (ownerResult.rows.length === 0) {
      res.status(404).json({ error: `Owner not found for email: ${ownerEmail}` });
      return;
    }
    const workspaceOwnerId = ownerResult.rows[0].workspace_owner_id;

    await db.query(
      `UPDATE workspace_settings
          SET available_countries = $2
        WHERE workspace_owner_id = $1`,
      [workspaceOwnerId, ["Lebanon", "United Arab Emirates"]],
    );

    res.json({ ok: true });
  });

  /**
   * POST /test/member
   * Seeds a non-owner workspace_member for e2e testing.
   * Body: { ownerEmail, memberEmail }
   * Returns: { id }
   */
  router.post("/test/member", async (req, res) => {
    const { ownerEmail, memberEmail } = req.body ?? {};
    if (!ownerEmail || !memberEmail) {
      res.status(400).json({ error: "ownerEmail and memberEmail are required" });
      return;
    }

    const ownerResult = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM workspace_members
        WHERE member_email = $1 AND role = 'owner'
        ORDER BY id DESC
        LIMIT 1`,
      [ownerEmail],
    );
    if (ownerResult.rows.length === 0) {
      res.status(404).json({ error: `Owner not found for email: ${ownerEmail}` });
      return;
    }
    const workspaceOwnerId = ownerResult.rows[0].workspace_owner_id;

    // Clear dependent member_locations rows before removing any existing member
    // to avoid FK-constraint failures on reruns after interrupted test runs.
    await db.query(
      `DELETE FROM member_locations
        WHERE member_id IN (
          SELECT id FROM workspace_members
           WHERE workspace_owner_id = $1 AND member_email = $2 AND role = 'member'
        )`,
      [workspaceOwnerId, memberEmail],
    );
    await db.query(
      `DELETE FROM workspace_members
        WHERE workspace_owner_id = $1 AND member_email = $2 AND role = 'member'`,
      [workspaceOwnerId, memberEmail],
    );

    const result = await db.query<{ id: number }>(
      `INSERT INTO workspace_members (workspace_owner_id, member_email, role, invited_by_email)
       VALUES ($1, $2, 'member', $3)
       RETURNING id`,
      [workspaceOwnerId, memberEmail, ownerEmail],
    );
    res.json({ id: result.rows[0].id });
  });

  /**
   * DELETE /test/member/:id
   * Removes a seeded workspace_member and any member_locations rows referencing it.
   */
  router.delete("/test/member/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db.query(`DELETE FROM member_locations WHERE member_id = $1`, [id]);
    await db.query(`DELETE FROM workspace_members WHERE id = $1`, [id]);
    res.json({ ok: true });
  });
}

export default router;

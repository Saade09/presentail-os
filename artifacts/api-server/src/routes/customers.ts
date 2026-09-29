import { Router, type Request, type Response, type NextFunction } from "express";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { requireApiKey } from "../lib/apiKeyAuth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { upsertCustomerFromOrder, recomputeCustomerAggregates } from "../lib/customerUpsert";
import { broadcastEvent } from "../lib/eventsSse";
import { fireWebhookEvent } from "../lib/catalogWebhook";

const router = Router();

/**
 * Auth middleware that accepts EITHER a Clerk session OR a workspace API key
 * (Bearer pk_live_…). Used by checkout-style endpoints invoked from external
 * services that don't carry a Clerk session.
 */
function requireAuthOrApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = (req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer pk_live_")) {
    requireApiKey(req, res, next);
    return;
  }
  requireAuth(req, res, next);
}

type CustomerRow = {
  id: number;
  workspace_owner_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  notes: string | null;
  source: string | null;
  website_user_id: string | null;
  date_of_birth: string | null;
  gender: string | null;
  marketing_opt_in: boolean;
  saved_addresses: unknown[];
  total_orders: number;
  total_spent: string;
  last_order_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

// The upsert-from-order endpoint is intentionally mounted BEFORE the
// generic Clerk-only middleware so it can accept either a Clerk session
// or a workspace API key (for the external checkout flow).
router.post(
  "/customers/upsert-from-order",
  requireAuthOrApiKey,
  resolveWorkspace,
  async (req, res) => {
    const wreq = workspace(req);
    const body = req.body as Record<string, unknown>;
    const contact = {
      firstName: typeof body.firstName === "string" ? body.firstName : null,
      lastName: typeof body.lastName === "string" ? body.lastName : null,
      email: typeof body.email === "string" ? body.email : null,
      phone: typeof body.phone === "string" ? body.phone : null,
      country: typeof body.country === "string" ? body.country : null,
      city: typeof body.city === "string" ? body.city : null,
      source: typeof body.source === "string" ? body.source : "checkout",
    };
    const customerId = await upsertCustomerFromOrder(wreq.workspaceOwnerId, contact);
    if (!customerId) {
      res.status(400).json({ error: "email or phone is required" });
      return;
    }
    if (typeof body.recompute === "boolean" && body.recompute) {
      try { await recomputeCustomerAggregates(customerId); } catch (err) {
        logger.warn({ err, customerId }, "recompute aggregates failed");
      }
    }
    const r = await db.query<CustomerRow>(
      `SELECT * FROM customers WHERE id = $1 AND workspace_owner_id = $2`,
      [customerId, wreq.workspaceOwnerId],
    );
    res.status(200).json({ customer: r.rows[0] ?? null, customerId });
  },
);

/**
 * POST /api/customers — create or upsert a customer from a website payload.
 * Accepts either Clerk session or API key bearer token.
 * Matches on email, phone, or website_user_id in that order.
 */
router.post(
  "/customers",
  requireAuthOrApiKey,
  resolveWorkspace,
  async (req, res) => {
    const wreq = workspace(req);
    const body = req.body as Record<string, unknown>;

    const email = typeof body.email === "string" && body.email.trim() ? body.email.trim().toLowerCase() : null;
    const phone = typeof body.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
    const websiteUserId = typeof body.websiteUserId === "string" && body.websiteUserId.trim()
      ? body.websiteUserId.trim()
      : (typeof body.website_user_id === "string" && body.website_user_id.trim() ? body.website_user_id.trim() : null);

    if (!email && !phone && !websiteUserId) {
      res.status(400).json({ success: false, error: "At least one of email, phone, or website_user_id is required" });
      return;
    }

    const firstName = typeof body.firstName === "string" ? body.firstName.trim() || null : (typeof body.first_name === "string" ? body.first_name.trim() || null : null);
    const lastName = typeof body.lastName === "string" ? body.lastName.trim() || null : (typeof body.last_name === "string" ? body.last_name.trim() || null : null);
    const country = typeof body.country === "string" ? body.country.trim() || null : null;
    const city = typeof body.city === "string" ? body.city.trim() || null : null;
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
    const source = typeof body.source === "string" ? body.source.trim() || null : "website";
    const gender = typeof body.gender === "string" ? body.gender.trim() || null : null;
    const marketingOptIn = typeof body.marketingOptIn === "boolean" ? body.marketingOptIn : (typeof body.marketing_opt_in === "boolean" ? body.marketing_opt_in : false);
    const dateOfBirth = typeof body.dateOfBirth === "string" && body.dateOfBirth.trim() ? body.dateOfBirth.trim() : (typeof body.date_of_birth === "string" && body.date_of_birth.trim() ? body.date_of_birth.trim() : null);
    const savedAddresses = Array.isArray(body.savedAddresses) ? body.savedAddresses : (Array.isArray(body.saved_addresses) ? body.saved_addresses : null);

    const ownerId = wreq.workspaceOwnerId;

    // Try to find existing customer by website_user_id, then email, then phone
    let existingId: number | null = null;

    if (websiteUserId) {
      const r = await db.query<{ id: number }>(
        `SELECT id FROM customers WHERE workspace_owner_id = $1 AND website_user_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [ownerId, websiteUserId],
      );
      if (r.rows[0]) existingId = r.rows[0].id;
    }
    if (!existingId && email) {
      const r = await db.query<{ id: number }>(
        `SELECT id FROM customers WHERE workspace_owner_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1`,
        [ownerId, email],
      );
      if (r.rows[0]) existingId = r.rows[0].id;
    }
    if (!existingId && phone) {
      const r = await db.query<{ id: number }>(
        `SELECT id FROM customers WHERE workspace_owner_id = $1 AND phone = $2 AND deleted_at IS NULL LIMIT 1`,
        [ownerId, phone],
      );
      if (r.rows[0]) existingId = r.rows[0].id;
    }

    let customer: CustomerRow;
    let isNew = false;

    if (existingId) {
      // Update existing customer with incoming data (prefer incoming non-null values)
      const setClauses: string[] = [];
      const params: unknown[] = [];

      const addSet = (col: string, val: unknown) => {
        params.push(val);
        setClauses.push(`${col} = $${params.length}`);
      };

      if (websiteUserId) addSet("website_user_id", websiteUserId);
      if (firstName) addSet("first_name", firstName);
      if (lastName) addSet("last_name", lastName);
      if (email) addSet("email", email);
      if (phone) addSet("phone", phone);
      if (country) addSet("country", country);
      if (city) addSet("city", city);
      if (gender) addSet("gender", gender);
      if (dateOfBirth) addSet("date_of_birth", dateOfBirth);
      if (marketingOptIn) addSet("marketing_opt_in", true);
      if (savedAddresses) addSet("saved_addresses", JSON.stringify(savedAddresses));
      setClauses.push("updated_at = now()");

      params.push(existingId);
      params.push(ownerId);
      const r = await db.query<CustomerRow>(
        `UPDATE customers SET ${setClauses.join(", ")} WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length} RETURNING *`,
        params,
      );
      customer = r.rows[0];
      broadcastEvent(ownerId, { event: "customer.updated", workspaceId: ownerId, data: { id: customer.id } });
      void fireWebhookEvent("customer.updated", ownerId, { customer: customer as unknown as Record<string, unknown> });
    } else {
      // Create new customer
      const r = await db.query<CustomerRow>(
        `INSERT INTO customers
           (workspace_owner_id, first_name, last_name, email, phone, country, city,
            notes, source, website_user_id, gender, date_of_birth, marketing_opt_in, saved_addresses)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [ownerId, firstName, lastName, email, phone, country, city,
         notes, source, websiteUserId, gender, dateOfBirth, marketingOptIn,
         JSON.stringify(savedAddresses ?? [])],
      );
      customer = r.rows[0];
      isNew = true;
      broadcastEvent(ownerId, { event: "customer.created", workspaceId: ownerId, data: { id: customer.id } });
      void fireWebhookEvent("customer.created", ownerId, { customer: customer as unknown as Record<string, unknown> });
    }

    res.status(isNew ? 201 : 200).json({ success: true, data: customer });
  },
);

router.use("/customers", requireAuth, resolveWorkspace);

const SORTABLE: Record<string, string> = {
  created_at: "created_at",
  last_order_at: "last_order_at",
  total_orders: "total_orders",
  total_spent: "total_spent",
  name: "COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')",
};

/** GET /api/customers — paginated list with search + sort. */
router.get("/customers", async (req, res) => {
  const wreq = workspace(req);
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "50", 10)));
  const offset = (page - 1) * limit;
  const search = ((req.query.search as string) || "").trim();
  const sortKey = ((req.query.sort as string) || "created_at").toLowerCase();
  const sortDir = ((req.query.dir as string) || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortCol = SORTABLE[sortKey] ?? SORTABLE.created_at;
  const includeDeleted = req.query.include_deleted === "true";

  const conds: string[] = ["workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];
  let idx = 2;

  if (!includeDeleted) {
    conds.push("deleted_at IS NULL");
  }

  if (search) {
    const like = `%${search.replace(/([%_\\])/g, "\\$1")}%`;
    conds.push(
      `(COALESCE(first_name,'') ILIKE $${idx} ESCAPE '\\' OR COALESCE(last_name,'') ILIKE $${idx} ESCAPE '\\' OR COALESCE(email,'') ILIKE $${idx} ESCAPE '\\' OR COALESCE(phone,'') ILIKE $${idx} ESCAPE '\\')`,
    );
    params.push(like);
    idx++;
  }
  const where = conds.join(" AND ");

  const [rowsRes, countRes] = await Promise.all([
    db.query<CustomerRow>(
      `SELECT id, workspace_owner_id, first_name, last_name, email, phone,
              country, city, notes, source, website_user_id, date_of_birth,
              gender, marketing_opt_in, saved_addresses, total_orders,
              total_spent, last_order_at, created_at, updated_at, deleted_at
        FROM customers
        WHERE ${where}
        ORDER BY ${sortCol} ${sortDir} NULLS LAST, id DESC
        LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(*)::int AS total FROM customers WHERE ${where}`,
      params,
    ),
  ]);

  res.json({
    customers: rowsRes.rows,
    total: parseInt(String(countRes.rows[0]?.total ?? "0"), 10),
    page,
    limit,
  });
});

/** GET /api/customers/:id */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a customer id route param that may be either a numeric customers.id
 * or a contacts.id UUID (from the Customers dashboard contact pool). A UUID is
 * resolved to the matching customers row via the contact's email/phone.
 * Returns the numeric customer id, or null when nothing matches.
 */
async function resolveCustomerIdParam(
  raw: string,
  workspaceOwnerId: string,
): Promise<number | null | "invalid"> {
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (!UUID_RE.test(raw)) return "invalid";
  const r = await db.query<{ id: number }>(
    `SELECT cu.id
       FROM contacts c
       JOIN customers cu
         ON cu.workspace_owner_id = c.workspace_owner_id
        AND cu.deleted_at IS NULL
        AND ((c.email IS NOT NULL AND cu.email = c.email)
             OR (c.phone IS NOT NULL AND cu.phone = c.phone))
      WHERE c.id = $1 AND c.workspace_owner_id = $2
      ORDER BY cu.id ASC LIMIT 1`,
    [raw, workspaceOwnerId],
  );
  return r.rows[0]?.id ?? null;
}

router.get("/customers/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = await resolveCustomerIdParam(req.params.id, wreq.workspaceOwnerId);
  if (id === "invalid") {
    res.status(400).json({ error: "Invalid customer id" });
    return;
  }
  if (id === null) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const r = await db.query<CustomerRow>(
    `SELECT * FROM customers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  res.json({ customer: r.rows[0] });
});

/** PATCH /api/customers/:id */
router.patch("/customers/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid customer id" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const stringEditable: Record<string, string> = {
    phone: "phone",
    notes: "notes",
    city: "city",
    country: "country",
    firstName: "first_name",
    lastName: "last_name",
    gender: "gender",
    websiteUserId: "website_user_id",
    website_user_id: "website_user_id",
    source: "source",
  };
  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const [k, col] of Object.entries(stringEditable)) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      const v = body[k];
      if (v !== null && typeof v !== "string") {
        res.status(400).json({ error: `${k} must be a string or null` });
        return;
      }
      // Avoid duplicate column set if both snake and camel keys present
      if (setClauses.some((c) => c.startsWith(`${col} =`))) continue;
      params.push(typeof v === "string" ? v.trim() || null : null);
      setClauses.push(`${col} = $${params.length}`);
    }
  }

  // Boolean field: marketing_opt_in
  for (const k of ["marketingOptIn", "marketing_opt_in"]) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      if (typeof body[k] !== "boolean") {
        res.status(400).json({ error: `${k} must be a boolean` });
        return;
      }
      if (!setClauses.some((c) => c.startsWith("marketing_opt_in ="))) {
        params.push(body[k]);
        setClauses.push(`marketing_opt_in = $${params.length}`);
      }
    }
  }

  // Date field: date_of_birth
  for (const k of ["dateOfBirth", "date_of_birth"]) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      const v = body[k];
      if (v !== null && typeof v !== "string") {
        res.status(400).json({ error: `${k} must be a date string or null` });
        return;
      }
      if (!setClauses.some((c) => c.startsWith("date_of_birth ="))) {
        params.push(typeof v === "string" ? v.trim() || null : null);
        setClauses.push(`date_of_birth = $${params.length}`);
      }
    }
  }

  // JSONB field: saved_addresses
  for (const k of ["savedAddresses", "saved_addresses"]) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      if (!Array.isArray(body[k])) {
        res.status(400).json({ error: `${k} must be an array` });
        return;
      }
      if (!setClauses.some((c) => c.startsWith("saved_addresses ="))) {
        params.push(JSON.stringify(body[k]));
        setClauses.push(`saved_addresses = $${params.length}`);
      }
    }
  }

  if (setClauses.length === 0) {
    res.status(400).json({ error: "No editable fields provided" });
    return;
  }
  setClauses.push("updated_at = now()");
  params.push(id);
  params.push(wreq.workspaceOwnerId);
  const r = await db.query<CustomerRow>(
    `UPDATE customers
        SET ${setClauses.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length} AND deleted_at IS NULL
      RETURNING *`,
    params,
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const customer = r.rows[0];
  broadcastEvent(wreq.workspaceOwnerId, { event: "customer.updated", workspaceId: wreq.workspaceOwnerId, data: { id: customer.id } });
  res.json({ customer });
});

/** DELETE /api/customers/:id — soft delete. */
router.delete("/customers/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners may delete customers" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid customer id" });
    return;
  }
  const r = await db.query<{ id: number }>(
    `UPDATE customers SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  broadcastEvent(wreq.workspaceOwnerId, { event: "customer.deleted", workspaceId: wreq.workspaceOwnerId, data: { id } });
  res.json({ success: true });
});

/** GET /api/customers/:id/orders — paginated orders for a customer. */
router.get("/customers/:id/orders", async (req, res) => {
  const wreq = workspace(req);
  const id = await resolveCustomerIdParam(req.params.id, wreq.workspaceOwnerId);
  if (id === "invalid") {
    res.status(400).json({ error: "Invalid customer id" });
    return;
  }
  if (id === null) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "50", 10)));
  const offset = (page - 1) * limit;

  // Verify the customer belongs to this workspace.
  const ok = await db.query<{ id: number }>(
    `SELECT id FROM customers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (ok.rowCount === 0) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const [rowsRes, countRes] = await Promise.all([
    db.query<{
      id: string;
      display_order_number: string | null;
      status: string;
      source: string;
      ordered_at: string | null;
      created_at: string;
      totals: unknown;
      express_delivery_selected: boolean;
      express_delivery_fee: string | null;
    }>(
      `SELECT id, display_order_number, status, source, ordered_at, created_at,
              totals, express_delivery_selected, express_delivery_fee
         FROM orders
        WHERE workspace_owner_id = $1 AND customer_id = $2
        ORDER BY ordered_at DESC NULLS LAST, created_at DESC
        LIMIT $3 OFFSET $4`,
      [wreq.workspaceOwnerId, id, limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM orders WHERE workspace_owner_id = $1 AND customer_id = $2`,
      [wreq.workspaceOwnerId, id],
    ),
  ]);

  res.json({
    orders: rowsRes.rows,
    total: parseInt(countRes.rows[0]?.total ?? "0", 10),
    page,
    limit,
  });
});

/**
 * POST /api/customers/:id/merge
 * Body: { targetId: number }
 *
 * Merges the customer at :id (the "loser") into :targetId (the "survivor"):
 *   - Reassigns all linked orders to the survivor.
 *   - Fills in any missing fields on the survivor from the loser
 *     (first/last name, email, phone, country, city, source).
 *   - Concatenates notes (survivor first, then loser, separated by a blank line).
 *   - Deletes the loser row.
 *   - Recomputes total_orders, total_spent, last_order_at on the survivor.
 *
 * Both customers must belong to the caller's workspace and be distinct rows.
 */
router.post("/customers/:id/merge", async (req, res) => {
  const wreq = workspace(req);
  const loserId = parseInt(req.params.id, 10);
  const body = req.body as Record<string, unknown>;
  const targetId =
    typeof body.targetId === "number"
      ? body.targetId
      : typeof body.targetId === "string"
        ? parseInt(body.targetId, 10)
        : NaN;

  if (isNaN(loserId) || isNaN(targetId)) {
    res.status(400).json({ error: "Invalid customer id" });
    return;
  }
  if (loserId === targetId) {
    res.status(400).json({ error: "Cannot merge a customer into itself" });
    return;
  }

  const client = await db.connect();
  try {
    const merged = await withTransaction(client, async () => {
      const both = await client.query<CustomerRow>(
        `SELECT * FROM customers
          WHERE id = ANY($1::int[]) AND workspace_owner_id = $2
          FOR UPDATE`,
        [[loserId, targetId], wreq.workspaceOwnerId],
      );
      if (both.rowCount !== 2) {
        const err = new Error("CUSTOMER_NOT_FOUND") as Error & { httpStatus?: number };
        err.httpStatus = 404;
        throw err;
      }
      const survivor = both.rows.find((r) => r.id === targetId)!;
      const loser = both.rows.find((r) => r.id === loserId)!;

      const sNotes = (survivor.notes ?? "").trim();
      const lNotes = (loser.notes ?? "").trim();
      const mergedNotes = [sNotes, lNotes].filter(Boolean).join("\n\n") || null;

      const pick = (s: string | null, l: string | null): string | null => s ?? l;

      await client.query(
        `UPDATE customers
            SET first_name = $2,
                last_name  = $3,
                email      = $4,
                phone      = $5,
                country    = $6,
                city       = $7,
                source     = $8,
                notes      = $9,
                updated_at = now()
          WHERE id = $1`,
        [
          targetId,
          pick(survivor.first_name, loser.first_name),
          pick(survivor.last_name, loser.last_name),
          pick(survivor.email, loser.email),
          pick(survivor.phone, loser.phone),
          pick(survivor.country, loser.country),
          pick(survivor.city, loser.city),
          pick(survivor.source, loser.source),
          mergedNotes,
        ],
      );

      await client.query(`DELETE FROM customers WHERE id = $1`, [loserId]);

      await recomputeCustomerAggregates(targetId, client);

      const r = await client.query<CustomerRow>(
        `SELECT * FROM customers WHERE id = $1`,
        [targetId],
      );
      return r.rows[0]!;
    });

    res.json({ customer: merged });
  } catch (err: unknown) {
    const httpStatus =
      err && typeof err === "object" && "httpStatus" in err
        ? (err as { httpStatus?: number }).httpStatus
        : undefined;
    if (httpStatus === 404) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    logger.error({ err, loserId, targetId }, "customer merge failed");
    res.status(500).json({ error: "Failed to merge customers" });
  } finally {
    client.release();
  }
});

export default router;

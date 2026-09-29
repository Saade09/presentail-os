import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { CASH_DESK_CURRENCIES } from "@workspace/payment-constants";
import { db } from "../lib/db";
import { requireAuth, authed } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";

const router = Router();
router.use(requireAuth, resolveWorkspace);

type CashDrawerRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  code: string;
  location_id: number | null;
  currency: string;
  secondary_currency: string | null;
  is_active: boolean;
  notes: string | null;
  created_by_clerk_id: string | null;
  updated_by_clerk_id: string | null;
  created_at: string;
  updated_at: string;
};

function hasPermission(wreq: ReturnType<typeof workspace>, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

const CASH_DESK_CURRENCY_SET: ReadonlySet<string> = new Set(CASH_DESK_CURRENCIES);

function normalizeCurrency(v: unknown): string {
  return String(v ?? "").trim().toUpperCase();
}

/**
 * Resolve an optional secondary currency value, validating it against the
 * accepted set and ensuring it differs from the main currency. Empty / "NONE"
 * resolves to null. Returns either the resolved value or an error message.
 */
function resolveSecondaryCurrency(
  raw: unknown,
  mainCurrency: string,
): { value: string | null } | { error: string } {
  const s = normalizeCurrency(raw);
  if (!s || s === "NONE") return { value: null };
  if (!CASH_DESK_CURRENCY_SET.has(s)) {
    return { error: `secondary_currency must be one of: ${CASH_DESK_CURRENCIES.join(", ")}` };
  }
  if (s === mainCurrency) {
    return { error: "secondary_currency must be different from the main currency" };
  }
  return { value: s };
}

async function fetchClerkNames(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const filtered = [...new Set(userIds.filter(Boolean))];
  if (filtered.length === 0) return map;
  try {
    const users = await clerkClient.users.getUserList({ userId: filtered, limit: 100 });
    for (const u of users.data) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
      map.set(u.id, name || (u.primaryEmailAddress?.emailAddress ?? u.id));
    }
  } catch (err) {
    logger.warn({ err }, "Failed to batch-fetch Clerk names for cash drawers");
  }
  return map;
}

/**
 * GET /api/cash-drawers
 * List workspace cash drawers. include_inactive=true to include deactivated.
 * Optional: location_id=<id> to filter by location.
 * Returns all drawers (available and occupied) with open-session details.
 */
router.get("/cash-drawers", async (req, res) => {
  const wreq = workspace(req);
  const includeInactive = req.query.include_inactive === "true";
  const locationIdRaw = req.query.location_id;
  const locationId =
    typeof locationIdRaw === "string" && locationIdRaw.trim()
      ? parseInt(locationIdRaw.trim(), 10)
      : null;

  const conditions = ["d.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];
  if (!includeInactive) conditions.push("d.is_active = true");
  if (locationId != null && Number.isFinite(locationId)) {
    params.push(locationId);
    conditions.push(`d.location_id = $${params.length}`);
  }

  type DrawerListRow = CashDrawerRow & {
    location_name: string | null;
    open_session_id: number | null;
    open_session_opened_at: string | null;
    open_session_operator_clerk_id: string | null;
  };

  const result = await db.query<DrawerListRow>(
    `SELECT d.*,
            l.name AS location_name,
            open_sess.id AS open_session_id,
            open_sess.opened_at AS open_session_opened_at,
            open_sess.opened_by_clerk_id AS open_session_operator_clerk_id
       FROM cash_drawers d
       LEFT JOIN locations l ON l.id = d.location_id
       LEFT JOIN LATERAL (
         SELECT cs.id, cs.opened_at, cs.opened_by_clerk_id
           FROM cash_sessions cs
          WHERE cs.drawer_id = d.id AND cs.workspace_owner_id = d.workspace_owner_id
            AND cs.status = 'open'
          ORDER BY cs.opened_at DESC LIMIT 1
       ) open_sess ON true
      WHERE ${conditions.join(" AND ")}
      ORDER BY d.is_active DESC, d.name ASC`,
    params,
  );

  // Batch-resolve operator names for occupied drawers
  const clerkIds = result.rows
    .map((r) => r.open_session_operator_clerk_id)
    .filter((id): id is string => Boolean(id));
  const nameMap = await fetchClerkNames(clerkIds);

  const drawers = result.rows.map((row) => ({
    ...row,
    open_session_operator_name: row.open_session_operator_clerk_id
      ? (nameMap.get(row.open_session_operator_clerk_id) ?? null)
      : null,
  }));

  res.json({ drawers });
});

/**
 * GET /api/cash-drawers/:id
 */
router.get("/cash-drawers/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid drawer id" });
    return;
  }
  const result = await db.query<CashDrawerRow & { location_name: string | null }>(
    `SELECT d.*, l.name AS location_name
       FROM cash_drawers d
       LEFT JOIN locations l ON l.id = d.location_id
      WHERE d.id = $1 AND d.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Cash drawer not found" });
    return;
  }
  res.json({ drawer: result.rows[0] });
});

/**
 * POST /api/cash-drawers
 */
router.post("/cash-drawers", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceActualRole !== "owner" && wreq.workspaceActualRole !== "admin") {
    res.status(403).json({ error: "Only workspace owners and admins can create cash drawers" });
    return;
  }
  const { name, code, location_id, currency, secondary_currency, notes } = req.body ?? {};
  const trimmedName = String(name ?? "").trim();
  const trimmedCode = String(code ?? "").trim().toUpperCase();
  if (!trimmedName) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!trimmedCode) {
    res.status(400).json({ error: "code is required" });
    return;
  }

  const mainCurrency = normalizeCurrency(currency) || "AED";
  if (!CASH_DESK_CURRENCY_SET.has(mainCurrency)) {
    res.status(400).json({ error: `currency must be one of: ${CASH_DESK_CURRENCIES.join(", ")}` });
    return;
  }
  const secondary = resolveSecondaryCurrency(secondary_currency, mainCurrency);
  if ("error" in secondary) {
    res.status(400).json({ error: secondary.error });
    return;
  }

  const dup = await db.query(
    `SELECT id FROM cash_drawers WHERE workspace_owner_id = $1 AND UPPER(code) = $2`,
    [wreq.workspaceOwnerId, trimmedCode],
  );
  if (dup.rowCount && dup.rowCount > 0) {
    res.status(409).json({ error: "A drawer with this code already exists" });
    return;
  }

  const userId = authed(req).userId;
  const result = await db.query<CashDrawerRow>(
    `INSERT INTO cash_drawers
       (workspace_owner_id, name, code, location_id, currency, secondary_currency, notes, created_by_clerk_id, updated_by_clerk_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     RETURNING *`,
    [
      wreq.workspaceOwnerId,
      trimmedName,
      trimmedCode,
      location_id != null && Number.isFinite(Number(location_id)) ? Number(location_id) : null,
      mainCurrency,
      secondary.value,
      notes ? String(notes).trim() || null : null,
      userId,
    ],
  );
  res.status(201).json({ drawer: result.rows[0] });
});

/**
 * PATCH /api/cash-drawers/:id
 * Update name/code/location/currency/notes or toggle is_active.
 */
router.patch("/cash-drawers/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid drawer id" });
    return;
  }

  const existing = await db.query<CashDrawerRow>(
    `SELECT * FROM cash_drawers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Cash drawer not found" });
    return;
  }

  const body = req.body ?? {};
  const togglingActive = "is_active" in body;
  const isAdminOrOwner = wreq.workspaceActualRole === "owner" || wreq.workspaceActualRole === "admin";
  if (togglingActive && Object.keys(body).length === 1) {
    if (!isAdminOrOwner) {
      res.status(403).json({ error: "Only workspace owners and admins can activate or deactivate cash drawers" });
      return;
    }
  } else if (!hasPermission(wreq, "cash_drawers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to edit cash drawers" });
    return;
  }

  const prev = existing.rows[0];

  // Block deactivation while an open session exists on the drawer.
  if (togglingActive && body.is_active === false) {
    const openSession = await db.query(
      `SELECT id FROM cash_sessions WHERE drawer_id = $1 AND workspace_owner_id = $2 AND status = 'open'`,
      [id, wreq.workspaceOwnerId],
    );
    if (openSession.rowCount && openSession.rowCount > 0) {
      res.status(409).json({ error: "Cannot deactivate a drawer with an open session" });
      return;
    }
  }

  const code = "code" in body ? String(body.code ?? "").trim().toUpperCase() : prev.code;
  if (!code) {
    res.status(400).json({ error: "code is required" });
    return;
  }
  if (code !== prev.code) {
    const dup = await db.query(
      `SELECT id FROM cash_drawers WHERE workspace_owner_id = $1 AND UPPER(code) = $2 AND id <> $3`,
      [wreq.workspaceOwnerId, code, id],
    );
    if (dup.rowCount && dup.rowCount > 0) {
      res.status(409).json({ error: "A drawer with this code already exists" });
      return;
    }
  }

  const newCurrency = "currency" in body
    ? normalizeCurrency(body.currency) || prev.currency
    : prev.currency;
  if (!CASH_DESK_CURRENCY_SET.has(newCurrency)) {
    res.status(400).json({ error: `currency must be one of: ${CASH_DESK_CURRENCIES.join(", ")}` });
    return;
  }
  let newSecondary: string | null;
  if ("secondary_currency" in body) {
    const resolved = resolveSecondaryCurrency(body.secondary_currency, newCurrency);
    if ("error" in resolved) {
      res.status(400).json({ error: resolved.error });
      return;
    }
    newSecondary = resolved.value;
  } else {
    // Secondary not in payload — keep it, but re-validate against any new
    // main currency so the two can never end up equal.
    newSecondary = prev.secondary_currency;
    if (newSecondary && newSecondary === newCurrency) {
      res.status(400).json({ error: "secondary_currency must be different from the main currency" });
      return;
    }
  }

  const userId = authed(req).userId;
  const result = await db.query<CashDrawerRow>(
    `UPDATE cash_drawers
        SET name               = $3,
            code               = $4,
            location_id        = $5,
            currency           = $6,
            secondary_currency = $7,
            notes              = $8,
            is_active          = $9,
            updated_by_clerk_id = $10,
            updated_at  = now()
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING *`,
    [
      id,
      wreq.workspaceOwnerId,
      "name" in body ? String(body.name ?? "").trim() || prev.name : prev.name,
      code,
      "location_id" in body
        ? (body.location_id != null && Number.isFinite(Number(body.location_id)) ? Number(body.location_id) : null)
        : prev.location_id,
      newCurrency,
      newSecondary,
      "notes" in body ? (body.notes ? String(body.notes).trim() || null : null) : prev.notes,
      togglingActive ? Boolean(body.is_active) : prev.is_active,
      userId,
    ],
  );
  res.json({ drawer: result.rows[0] });
});

export default router;

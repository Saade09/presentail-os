import { Router, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, type WorkspaceRequest } from "../lib/workspace";
import { hasCmcPosBaseAccess } from "../lib/cmcAccess";
import { clerkClient } from "@clerk/express";
import { createManualOrder } from "../lib/orderCreate";
import { generateCmcOrderNumber } from "../lib/cmcOrderNumber";
import { generateReturnReference } from "../lib/cmcReturnReference";
import { objectStorageClient } from "../lib/objectStorage";
import { z } from "zod/v4";
import { computeMonthlySales, resolveMonthBounds, type MonthlySalesMode } from "../lib/cmcMonthlySales";
import {
  generateCmcCommissionSummaryPdf,
  generateCmcCommissionStatementPdf,
} from "../lib/cmcMonthlySalesPdf";
import { isTookanEnabled, createTookanStockRequestTask, createTookanReturnTask } from "../lib/tookan";
import { postMovement } from "../lib/inventoryService";
import {
  generateSessionNumber,
  logSessionActivity,
  recomputeSessionTotals,
  recordCashTransaction,
  computeShiftOverdue,
} from "../lib/cashDesk";
import { broadcastEvent } from "../lib/eventsSse";

const router = Router();
const cmcUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const CMC_REPORTING_TIMEZONE = "Asia/Beirut";

router.use(requireAuth, resolveWorkspace);

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

function can(wreq: WorkspaceRequest, key: string): boolean {
  return wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(key);
}

// Base CMC POS gate: owners, the canonical Dashboard page, the legacy
// `cmc-pos` page, or any legacy `cmc_pos.*` permission. New Order intentionally
// remains separate and is enforced by POST /orders/manual.
function requireCmcPos(req: Request, res: Response): WorkspaceRequest | null {
  const wreq = workspace(req);
  if (!hasCmcPosBaseAccess(wreq)) {
    res.status(403).json({ error: "Requires CMC POS access" });
    return null;
  }
  return wreq;
}

function requireCmcAudit(req: Request, res: Response): WorkspaceRequest | null {
  const wreq = workspace(req);
  if (!can(wreq, "cmc_pos.audit")) {
    res.status(403).json({ error: "Requires cmc_pos.audit permission" });
    return null;
  }
  return wreq;
}

function hasSub(wreq: WorkspaceRequest, sub: string): boolean {
  return wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(sub);
}

function actorId(req: Request): string {
  const r = req as Request & { userId?: string };
  return r.userId ?? "unknown";
}

// ---------------------------------------------------------------------------
// Image upload for custom items
// ---------------------------------------------------------------------------

async function uploadCmcItemImage(buffer: Buffer, mime: string, workspaceOwnerId: string): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const objectId = randomUUID();
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/cmc-items/${objectId}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: mime, resumable: false });
  return `/objects/${workspaceOwnerId}/cmc-items/${objectId}`;
}

router.post("/cmc-pos/upload-image", cmcUpload.single("image"), async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "An image file is required" });
    return;
  }
  const mime = file.mimetype as string;
  const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
  if (!ALLOWED_MIME_TYPES.includes(mime)) {
    res.status(400).json({ error: "File must be a JPG, PNG, or WebP image" });
    return;
  }
  try {
    const url = await uploadCmcItemImage(file.buffer, mime, wreq.workspaceOwnerId);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: "Failed to upload image" });
  }
});

// ---------------------------------------------------------------------------
// CMC POS Locations — locations that have at least one active cash drawer
// Used by the Start Shift panel to auto-select the workspace's CMC location
// without exposing the full workspace location list.
// ---------------------------------------------------------------------------

router.get("/cmc-pos/locations", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;

  // DISTINCT ON (l.id) picks one drawer per location (the lowest drawer id).
  // We include the drawer currencies so the frontend can show a currency picker
  // when the drawer accepts two currencies (secondary_currency IS NOT NULL).
  const result = await db.query<{
    id: number; name: string; currency: string; secondary_currency: string | null;
  }>(
    `SELECT DISTINCT ON (l.id) l.id, l.name, d.currency, d.secondary_currency
       FROM cash_drawers d
       JOIN locations l ON l.id = d.location_id
      WHERE d.workspace_owner_id = $1 AND d.is_active = true
      ORDER BY l.id ASC, d.id ASC`,
    [wreq.workspaceOwnerId],
  );

  res.json({ locations: result.rows });
});

// ---------------------------------------------------------------------------
// Shifts — open / close / active
// ---------------------------------------------------------------------------

/** Batch-fetch display names for a list of Clerk user IDs. */
async function fetchClerkNamesLocal(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const filtered = [...new Set(userIds.filter(Boolean))];
  if (filtered.length === 0) return map;
  try {
    const users = await clerkClient.users.getUserList({ userId: filtered, limit: 100 });
    for (const u of users.data) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
      map.set(u.id, name || (u.primaryEmailAddress?.emailAddress ?? u.id));
    }
  } catch {
    // Non-fatal: fall back to empty map so the endpoint still responds
  }
  return map;
}

router.get("/cmc-pos/shifts/active", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  // Location-scoped: any open shift at the (optional) location counts as
  // active for the whole team — shelf sales are allowed against a shared
  // open session regardless of who opened it. opened_by_user_id is still
  // returned (via s.*) so the UI can show who opened the shift.
  const rawLocationId = req.query.location_id;
  const locationId = rawLocationId !== undefined ? Number(rawLocationId) : null;
  if (rawLocationId !== undefined && !Number.isFinite(locationId)) {
    res.status(400).json({ error: "location_id must be a number" });
    return;
  }
  const params: unknown[] = [wreq.workspaceOwnerId];
  let locationFilter = "";
  if (locationId !== null) {
    params.push(locationId);
    locationFilter = `AND s.location_id = $${params.length}`;
  }
  const result = await db.query(
    `SELECT s.*, cs.status AS cash_session_status,
            l.name AS location_name, COALESCE(l.timezone, 'UTC') AS location_timezone,
            l.same_day_cutoff_time AS location_cutoff_time,
            l.grace_period_minutes AS location_grace_minutes
       FROM cmc_shifts s
       LEFT JOIN cash_sessions cs ON cs.id = s.cash_session_id
       LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.workspace_owner_id = $1
        AND s.status = 'open'
        ${locationFilter}
      ORDER BY s.opened_at DESC
      LIMIT 1`,
    params,
  );
  const shift = result.rows[0] ?? null;
  if (shift) {
    const { isOverdue, overdueAt } = computeShiftOverdue(
      String(shift.opened_at ?? ""),
      shift.location_cutoff_time as string | null,
      shift.location_timezone as string | null,
      shift.location_grace_minutes as number | null,
    );
    shift.isOverdue = isOverdue;
    shift.overdueAt = overdueAt?.toISOString() ?? null;

    // Check for a pending resolution on the active shift's linked cash session.
    // This powers the manager approve/reject UI: when a resolver submits a
    // resolution that requires approval, the shift remains open and any manager
    // who loads the dashboard sees previousSessionPending = true plus the
    // pending resolution summary needed to render the approve/reject modal.
    if (shift.cash_session_id) {
      const pendingResult = await db.query<{
        id: number;
        resolver_id: string | null;
        counted_balance: string;
        expected_balance: string;
        difference: string;
        reason: string;
        note: string | null;
        currency: string;
        created_at: string;
      }>(
        `SELECT r.id, r.resolver_id, r.counted_balance, r.expected_balance,
                r.difference, r.reason, r.note, r.currency, r.created_at
           FROM cash_session_resolutions r
          WHERE r.cash_session_id = $1
            AND r.workspace_id = $2
            AND r.approval_status = 'pending'
            AND r.resolved_at IS NULL
          ORDER BY r.created_at DESC
          LIMIT 1`,
        [shift.cash_session_id, wreq.workspaceOwnerId],
      );

      if (pendingResult.rows.length > 0) {
        const pending = pendingResult.rows[0];
        // Fetch resolver display name from Clerk (non-fatal)
        let resolverName: string | null = null;
        if (pending.resolver_id) {
          const names = await fetchClerkNamesLocal([pending.resolver_id]);
          resolverName = names.get(pending.resolver_id) ?? null;
        }
        shift.previousSessionPending = true;
        shift.pendingResolution = {
          id: pending.id,
          resolver_name: resolverName,
          counted_balance: pending.counted_balance,
          expected_balance: pending.expected_balance,
          difference: pending.difference,
          reason: pending.reason,
          note: pending.note,
          currency: pending.currency,
          created_at: pending.created_at,
        };
      } else {
        shift.previousSessionPending = false;
        shift.pendingResolution = null;
      }
    } else {
      shift.previousSessionPending = false;
      shift.pendingResolution = null;
    }
  }
  res.json({ shift });
});

router.post("/cmc-pos/shifts", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const body = z.object({
    location_id: z.number().int(),
    opening_cash: z.number().min(0).default(0),
    // Optional: for dual-currency drawers the second opening balance (secondary currency).
    opening_cash_secondary: z.number().min(0).optional(),
    // Optional: when provided for a dual-currency drawer, must match one of the drawer's
    // currencies; defaults to the drawer's primary currency when omitted.
    currency: z.string().optional(),
  }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "location_id is required and opening_cash must be ≥ 0" });
    return;
  }
  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;
  const { location_id, opening_cash, opening_cash_secondary, currency: requestedCurrency } = body.data;

  // Fast pre-check: this user already has an open shift (avoids acquiring a tx lock).
  const existing = await db.query(
    `SELECT id FROM cmc_shifts WHERE workspace_owner_id = $1 AND opened_by_user_id = $2 AND status = 'open' LIMIT 1`,
    [wsId, uid],
  );
  if (existing.rows.length > 0) {
    res.status(409).json({ error: "You already have an open shift", shift_id: existing.rows[0].id });
    return;
  }

  // ── Atomic shift + session creation ──────────────────────────────────────────
  // All state-changing work runs in ONE transaction.
  //
  // Key serialization strategy:
  //   1. Lock the drawer row with FOR UPDATE — serializes concurrent opens for the
  //      same drawer so exactly one sees "no open session" and creates it.
  //   2. The partial unique index idx_cash_sessions_one_open_per_drawer provides
  //      a DB-level backstop (catches any race from outside the shift flow).
  //   3. If the drawer exists but session creation fails → the transaction is
  //      rolled back and the caller receives an error (no orphaned open shifts).
  //   4. If no active drawer exists at the location → 422 NO_ACTIVE_DRAWER is
  //      returned. CMC POS shifts require a linked cash session; allowing a
  //      null-session shift would make cash reconciliation impossible.

  const client = await db.connect();
  try {
    const txResult = await withTransaction(client, async () => {
      // ── Step 1: Re-check this user's shift inside the transaction ─────────
      const existingInTx = await client.query<{ id: number }>(
        `SELECT id FROM cmc_shifts WHERE workspace_owner_id = $1 AND opened_by_user_id = $2 AND status = 'open' LIMIT 1`,
        [wsId, uid],
      );
      if (existingInTx.rows.length > 0) {
        throw Object.assign(new Error("You already have an open shift"), {
          code: "DUPLICATE_USER_SHIFT",
          shift_id: existingInTx.rows[0].id,
        });
      }

      // ── Step 2: Lock the drawer (serializes concurrent session creation) ──
      // FOR UPDATE cannot be used with LEFT JOIN (nullable side restriction).
      // Use a scalar subquery for location_name so the lock applies only to cash_drawers.
      const drawerResult = await client.query<{
        id: number; code: string; currency: string;
        secondary_currency: string | null; location_name: string | null;
        location_timezone: string | null; location_cutoff_time: string | null;
        location_grace_minutes: number | null;
      }>(
        `SELECT d.id, d.code, d.currency, d.secondary_currency,
                (SELECT l.name             FROM locations l WHERE l.id = d.location_id) AS location_name,
                (SELECT l.timezone         FROM locations l WHERE l.id = d.location_id) AS location_timezone,
                (SELECT l.same_day_cutoff_time FROM locations l WHERE l.id = d.location_id) AS location_cutoff_time,
                (SELECT l.grace_period_minutes FROM locations l WHERE l.id = d.location_id) AS location_grace_minutes
           FROM cash_drawers d
          WHERE d.workspace_owner_id = $1 AND d.location_id = $2 AND d.is_active = true
          ORDER BY d.id ASC LIMIT 1
          FOR UPDATE`,
        [wsId, location_id],
      );

      let cashSessionId: number | null = null;
      // Chosen transaction currency for this shift. Set inside the drawer block
      // below and used in Step 5 to write cmc_shifts.currency.
      let chosenCurrency: string | undefined;

      if (!drawerResult.rowCount || drawerResult.rowCount === 0) {
        // No active drawer at this location.
        // CMC POS shifts require an open cash session backed by a cash drawer.
        // Creating a shift without one would make cash reconciliation impossible.
        throw Object.assign(
          new Error(
            "No active cash drawer found at this location. " +
            "A CMC POS shift requires a linked cash session — ask a manager to set up a cash drawer for this location first.",
          ),
          { code: "NO_ACTIVE_DRAWER" },
        );
      }

      // Drawer exists (guaranteed by the NO_ACTIVE_DRAWER guard above).
      {
        const drawer = drawerResult.rows[0];

        // ── Dual-currency drawer: determine shift currency ───────────────────
        // The shift's `currency` column is used by close-shift reconciliation to
        // filter cash_transactions for the primary denomination.
        // When the caller omits `currency` we default to the drawer's primary
        // currency (the new dual-currency form sends opening_cash_secondary
        // instead of a currency picker, so no explicit currency is required).
        // When the caller supplies a `currency` we validate it matches one of
        // the drawer's accepted currencies.
        let drawerChosenCurrency: string = drawer.currency;
        if (drawer.secondary_currency) {
          if (requestedCurrency) {
            const allowed = [drawer.currency.toUpperCase(), drawer.secondary_currency.toUpperCase()];
            if (!allowed.includes(requestedCurrency.toUpperCase())) {
              throw Object.assign(
                new Error(
                  `Invalid currency "${requestedCurrency}". This drawer accepts ${drawer.currency} and ${drawer.secondary_currency}.`,
                ),
                { code: "DUAL_CURRENCY_DRAWER_NOT_SUPPORTED" },
              );
            }
            // Use the canonicalised form from the drawer (preserves original case).
            drawerChosenCurrency = allowed.indexOf(requestedCurrency.toUpperCase()) === 0
              ? drawer.currency
              : drawer.secondary_currency!;
          }
          // No requestedCurrency → default stays as drawer.currency (primary).
        }
        chosenCurrency = drawerChosenCurrency;

        // ── Step 3: Check for existing open session at this drawer ───────────
        const openSession = await client.query<{
          id: number; currency: string; secondary_currency: string | null; opened_at: string;
        }>(
          `SELECT id, currency, secondary_currency, opened_at FROM cash_sessions WHERE workspace_owner_id = $1 AND drawer_id = $2 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`,
          [wsId, drawer.id],
        );

        if (openSession.rows.length > 0) {
          const existingSession = openSession.rows[0];

          // ── Overdue guardrail — block new session if existing one is overdue ─
          // An overdue open session must be resolved via POST /cmc-pos/shifts/resolve
          // before a new shift can be started on the same drawer.
          const { isOverdue: existingIsOverdue } = computeShiftOverdue(
            existingSession.opened_at,
            drawer.location_cutoff_time,
            drawer.location_timezone,
            drawer.location_grace_minutes,
          );
          if (existingIsOverdue) {
            throw Object.assign(
              new Error(
                "An overdue cash session for this drawer has not been resolved yet. " +
                "Please resolve the overdue session first (POST /api/cmc-pos/shifts/resolve) before starting a new shift.",
              ),
              { code: "OVERDUE_SESSION_UNRESOLVED" },
            );
          }

          // ── Currency-compatibility guard (adopted session) ─────────────────
          // An existing open session may have been created outside the CMC shift
          // flow (e.g. from the Cash Desk) and could be:
          //   (a) dual-currency (secondary_currency IS NOT NULL), or
          //   (b) single-currency but in a different currency than chosen.
          // Either case would cause close-shift reconciliation to filter by
          // the shift's currency while the session posted transactions in another
          // denomination, producing incorrect expected-balance calculations.
          // Reject the adopt and require a fresh session for the chosen currency.
          if (existingSession.secondary_currency !== null) {
            throw Object.assign(
              new Error(
                `The open cash session at this drawer is dual-currency (${existingSession.currency}/${existingSession.secondary_currency}). ` +
                `A CMC shift requires a single-currency session. Please close the existing session first, then start the shift.`,
              ),
              { code: "SESSION_CURRENCY_MISMATCH" },
            );
          }
          if (existingSession.currency.toUpperCase() !== drawerChosenCurrency.toUpperCase()) {
            throw Object.assign(
              new Error(
                `The open cash session at this drawer is in ${existingSession.currency}, ` +
                `but the shift was started with ${drawerChosenCurrency}. ` +
                `Please close the existing session first, then start the shift with the matching currency.`,
              ),
              { code: "SESSION_CURRENCY_MISMATCH", session_currency: existingSession.currency, requested_currency: drawerChosenCurrency },
            );
          }

          // Session exists and currency matches — verify no other shift owns it.
          const shiftForSession = await client.query<{ id: number }>(
            `SELECT id FROM cmc_shifts WHERE workspace_owner_id = $1 AND cash_session_id = $2 AND status = 'open' LIMIT 1`,
            [wsId, existingSession.id],
          );
          if (shiftForSession.rows.length > 0) {
            throw Object.assign(
              new Error("Another shift is already active at this location's cash drawer. Ask the current shift holder to close their shift first."),
              { code: "LOCATION_SESSION_IN_USE", existing_shift_id: shiftForSession.rows[0].id },
            );
          }
          cashSessionId = existingSession.id;
          // Stamp the adopted session with the current location so the
          // location-filtered cash-drawer GET can find it.
          await client.query(
            `UPDATE cash_sessions SET location_id = $1 WHERE id = $2`,
            [location_id, existingSession.id],
          );
        } else {
          // ── Step 4: Create a new session (drawer is locked → no race) ──────
          const year = new Date().getFullYear();
          // Inline session-number generation using the transaction client
          const countResult = await client.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt FROM cash_sessions
              WHERE workspace_owner_id = $1 AND drawer_id = $2
                AND EXTRACT(YEAR FROM opened_at) = $3`,
            [wsId, drawer.id, year],
          );
          const seq = (parseInt(countResult.rows[0]?.cnt ?? "0", 10) || 0) + 1;
          const loc = (drawer.location_name ?? "LOC").replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase() || "LOC";
          const drw = (drawer.code ?? "DRW").replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase() || "DRW";
          const sessionNumber = `CS-${loc}-${drw}-${year}-${String(seq).padStart(4, "0")}`;

          // For dual-currency drawers with opening_cash_secondary provided, create a
          // dual-currency session so both denominations are tracked from the start.
          // For single-currency drawers (or dual-currency without a secondary amount),
          // secondary_currency remains NULL and the session stays single-currency.
          // Guard: only populate the secondary slot when it is distinct from the
          // chosen primary currency — a caller who picks the drawer's secondary
          // currency as their primary must not create a session where both columns
          // hold the same value (e.g. USD/USD).
          const sessionSecondaryCurrency =
            drawer.secondary_currency &&
            opening_cash_secondary !== undefined &&
            drawer.secondary_currency.toUpperCase() !== drawerChosenCurrency.toUpperCase()
              ? drawer.secondary_currency
              : null;
          const sessionOpeningCashSecondaryStr =
            sessionSecondaryCurrency !== null && opening_cash_secondary !== undefined
              ? opening_cash_secondary.toFixed(2)
              : null;

          const sessionResult = await client.query<{ id: number }>(
            `INSERT INTO cash_sessions
               (workspace_owner_id, session_number, drawer_id, location_id, currency,
                status, opening_cash, expected_cash, opening_note, opened_by_clerk_id,
                secondary_currency, opening_cash_secondary, expected_cash_secondary,
                cash_in_total_secondary, cash_out_total_secondary, adjustments_total_secondary)
             VALUES ($1, $2, $3, $4, $5, 'open', $6, $6, NULL, $7, $8,
                     $9,
                     $9,
                     CASE WHEN $8::text IS NULL THEN NULL ELSE 0 END,
                     CASE WHEN $8::text IS NULL THEN NULL ELSE 0 END,
                     CASE WHEN $8::text IS NULL THEN NULL ELSE 0 END)
             RETURNING id`,
            [wsId, sessionNumber, drawer.id, location_id, drawerChosenCurrency,
             opening_cash.toFixed(2), uid, sessionSecondaryCurrency, sessionOpeningCashSecondaryStr],
          );
          cashSessionId = sessionResult.rows[0].id;

          // Activity log (uses client to stay in the same transaction)
          await client.query(
            `INSERT INTO cash_session_activity_logs
               (workspace_owner_id, cash_session_id, action, actor_clerk_id, actor_name, detail)
             VALUES ($1, $2, 'opened', $3, NULL, $4)`,
            [wsId, cashSessionId, uid,
             JSON.stringify({ opening_cash: opening_cash.toFixed(2), source: "cmc_shift" })],
          );
        }
      }

      // ── Step 5: Insert the shift with cash_session_id already set ─────────
      // currency is stored so close-shift reconciliation can filter cash_transactions
      // by the chosen currency (important for dual-currency drawer shifts).
      const shiftResult = await client.query<{ id: number; [k: string]: unknown }>(
        `INSERT INTO cmc_shifts
           (workspace_owner_id, location_id, opened_by_user_id, opening_cash, cash_session_id, currency)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [wsId, location_id, uid, opening_cash.toFixed(2), cashSessionId, chosenCurrency],
      );

      return { shift: shiftResult.rows[0], cashSessionId };
    });

    res.status(201).json({ shift: txResult.shift, cash_session_id: txResult.cashSessionId });
  } catch (err) {
    const e = err as { code?: string; message?: string; shift_id?: number; existing_shift_id?: number };
    if (e.code === "NO_ACTIVE_DRAWER") {
      res.status(422).json({ code: "NO_ACTIVE_DRAWER", error: e.message });
    } else if (e.code === "DUAL_CURRENCY_DRAWER_NOT_SUPPORTED") {
      res.status(422).json({ code: "DUAL_CURRENCY_DRAWER_NOT_SUPPORTED", error: e.message });
    } else if (e.code === "DUPLICATE_USER_SHIFT") {
      res.status(409).json({ error: e.message, shift_id: e.shift_id });
    } else if (e.code === "SESSION_CURRENCY_MISMATCH") {
      res.status(422).json({
        code: "SESSION_CURRENCY_MISMATCH",
        error: e.message,
        session_currency: (e as { session_currency?: string }).session_currency,
        requested_currency: (e as { requested_currency?: string }).requested_currency,
      });
    } else if (e.code === "LOCATION_SESSION_IN_USE") {
      res.status(409).json({ code: "LOCATION_SESSION_IN_USE", error: e.message, existing_shift_id: e.existing_shift_id });
    } else if (e.code === "OVERDUE_SESSION_UNRESOLVED") {
      res.status(409).json({ code: "OVERDUE_SESSION_UNRESOLVED", error: e.message });
    } else if ((e as { code?: string }).code === "23505") {
      // DB-level unique constraint fired — two concurrent requests raced past the
      // in-memory checks. Distinguish which constraint was violated:
      const constraint = (e as { constraint?: string }).constraint ?? "";
      if (constraint === "idx_cmc_shifts_one_open_per_user") {
        res.status(409).json({ error: "You already have an open shift", code: "DUPLICATE_USER_SHIFT" });
      } else {
        // idx_cash_sessions_one_open_per_drawer or similar — session-level conflict
        res.status(409).json({
          code: "LOCATION_SESSION_IN_USE",
          error: "A shift was just opened for this location's drawer. Please refresh and try again.",
        });
      }
    } else {
      // Unknown error — propagate so the caller sees a 500 (not a silent success)
      throw err;
    }
  } finally {
    client.release();
  }
});

/**
 * POST /api/cmc-pos/shifts/close
 * Close the location's active shift with full cash reconciliation.
 * Any user with CMC POS access may close the shift — not just the opener.
 * The closer is recorded in closed_by_user_id.
 * Body: { cash_kept, cash_transferred, destination_location_id?, discrepancy_note?, location_id? }
 */
router.post("/cmc-pos/shifts/close", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;

  const body = z.object({
    cash_kept: z.number().min(0),
    cash_transferred: z.number().min(0).default(0),
    destination_location_id: z.number().int().optional().nullable(),
    discrepancy_note: z.string().optional().nullable(),
    // Optional: secondary-currency count for dual-currency sessions.
    cash_kept_secondary: z.number().min(0).optional(),
    // Optional: scope the close to a specific location's active shift.
    location_id: z.number().int().optional().nullable(),
    // Optional: amount loaded into the Whish wallet during shift close (primary currency).
    whish_transferred: z.number().min(0).default(0),
  }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "cash_kept is required and must be ≥ 0" });
    return;
  }
  const { cash_kept, cash_transferred, destination_location_id, discrepancy_note, cash_kept_secondary, location_id, whish_transferred } = body.data;

  // Find the location's active shift — any CMC POS user may close it, not just
  // the opener (closed_by_user_id records who actually performed the close).
  const shiftParams: unknown[] = [wsId];
  let shiftLocationFilter = "";
  if (location_id != null) {
    shiftParams.push(location_id);
    shiftLocationFilter = `AND location_id = $${shiftParams.length}`;
  }
  const shiftResult = await db.query<{
    id: number; location_id: number; cash_session_id: number | null; opening_cash: string; currency: string | null;
  }>(
    `SELECT id, location_id, cash_session_id, opening_cash, currency
       FROM cmc_shifts
      WHERE workspace_owner_id = $1 AND status = 'open' ${shiftLocationFilter}
      ORDER BY opened_at DESC LIMIT 1`,
    shiftParams,
  );
  if (shiftResult.rows.length === 0) {
    res.status(404).json({ error: "No active shift found" });
    return;
  }
  const shift = shiftResult.rows[0];

  // ── Drawer-less shift: close directly (no cash reconciliation) ────────────
  // A shift opened at a location with no cash drawer has cash_session_id = null.
  // There is no ledger to reconcile, so close the shift directly and skip all
  // cash-session work. Transfers are rejected: with no source session there is
  // nowhere for the outgoing transaction to be recorded.
  if (!shift.cash_session_id) {
    if (cash_transferred > 0) {
      res.status(422).json({
        code: "NO_LINKED_SESSION",
        error: "This shift has no linked cash session, so cash cannot be transferred during close. Set cash_transferred to 0.",
      });
      return;
    }
    const directClose = await db.query(
      `UPDATE cmc_shifts
          SET status = 'closed', closed_at = now(), closed_by_user_id = $1,
              closing_cash_kept = $2, closing_cash_transferred = 0,
              discrepancy_note = $3
        WHERE id = $4 AND workspace_owner_id = $5 AND status = 'open'
        RETURNING *`,
      [uid, cash_kept.toFixed(2), discrepancy_note?.trim() ?? null, shift.id, wsId],
    );
    if (directClose.rowCount === 0) {
      res.status(409).json({ error: "Shift not found or already closed. Please refresh and try again." });
      return;
    }
    res.json({
      shift: directClose.rows[0],
      discrepancy: 0,
      expected_balance: 0,
      drawerless: true,
      message: "Shift closed. No cash session was linked, so cash reconciliation was skipped.",
    });
    return;
  }

  // NOTE: Expected balance and discrepancy validation are computed INSIDE the
  // transaction below (from committed ledger rows, after locking the session).
  // Computing them here from the stale expected_cash column would miss cash
  // sales whose fire-and-forget recompute hasn't persisted yet.

  // A session can be finalized independently from its still-open CMC shift
  // (for example, by a supervisor in Cash Desk). That finalization is
  // historical evidence, so recovery may close the shift but must not reconcile,
  // close, or add transfers to the session a second time.
  const linkedSession = await db.query<{
    status: string;
  }>(
    `SELECT status FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [shift.cash_session_id, wsId],
  );
  if (linkedSession.rows.length === 0) {
    res.status(422).json({
      code: "LINKED_SESSION_NOT_FOUND",
      error: "The shift's linked cash session no longer exists. Contact a manager before closing this shift.",
    });
    return;
  }
  if (linkedSession.rows[0].status !== "open") {
    if (cash_transferred > 0) {
      res.status(422).json({
        code: "FINALIZED_SESSION_TRANSFER_UNSUPPORTED",
        error: "This shift's linked cash session is already finalized, so no new cash transfer can be recorded. Set cash_transferred to 0 to finalize the shift.",
      });
      return;
    }

    const recoveryClient = await db.connect();
    try {
      const recovered = await withTransaction(recoveryClient, async () => {
        const locked = await recoveryClient.query<{
          status: string;
          currency: string;
          opening_cash: string;
          expected_cash: string | null;
          actual_cash: string | null;
          difference: string | null;
          expected_cash_secondary: string | null;
          difference_secondary: string | null;
        }>(
          `SELECT status, currency, opening_cash, expected_cash, actual_cash, difference,
                  expected_cash_secondary, difference_secondary
             FROM cash_sessions
            WHERE id = $1 AND workspace_owner_id = $2
            FOR UPDATE`,
          [shift.cash_session_id, wsId],
        );
        if (locked.rows.length === 0) {
          throw Object.assign(new Error("The shift's linked cash session no longer exists. Contact a manager before closing this shift."), {
            code: "LINKED_SESSION_NOT_FOUND",
          });
        }
        if (locked.rows[0].status === "open") {
          throw Object.assign(new Error("The linked cash session was reopened. Refresh and complete the normal reconciliation close."), {
            code: "SESSION_REOPENED",
          });
        }

        const session = locked.rows[0];
        const closeResult = await recoveryClient.query(
          `UPDATE cmc_shifts
              SET status = 'closed', closed_at = now(), closed_by_user_id = $1,
                  closing_cash_kept = $2, closing_cash_transferred = 0,
                  closing_destination_location_id = NULL, discrepancy_note = $3
            WHERE id = $4 AND workspace_owner_id = $5 AND status = 'open'
            RETURNING *`,
          [
            uid,
            (Number(session.actual_cash ?? session.expected_cash ?? session.opening_cash)).toFixed(2),
            discrepancy_note?.trim() ?? null,
            shift.id,
            wsId,
          ],
        );
        if (closeResult.rowCount === 0) {
          throw Object.assign(new Error("Shift not found or already closed. Please refresh and try again."), {
            code: "SHIFT_ALREADY_CLOSED",
          });
        }
        return {
          shift: closeResult.rows[0],
          expectedBalance: Number(session.expected_cash ?? session.opening_cash),
          discrepancy: Number(session.difference ?? 0),
          expectedBalanceSecondary: session.expected_cash_secondary === null
            ? null
            : Number(session.expected_cash_secondary),
          discrepancySecondary: session.difference_secondary === null
            ? null
            : Number(session.difference_secondary),
        };
      });

      res.json({
        shift: recovered.shift,
        discrepancy: recovered.discrepancy,
        expected_balance: recovered.expectedBalance,
        ...(recovered.expectedBalanceSecondary !== null ? {
          expected_balance_secondary: recovered.expectedBalanceSecondary,
          discrepancy_secondary: recovered.discrepancySecondary,
        } : {}),
        session_already_finalized: true,
        message: "Shift closed. Its linked cash session was already finalized, so its reconciliation and audit trail were left unchanged.",
      });
      return;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "LINKED_SESSION_NOT_FOUND") {
        res.status(422).json({ code: e.code, error: e.message });
        return;
      }
      if (e.code === "SESSION_REOPENED" || e.code === "SHIFT_ALREADY_CLOSED") {
        res.status(409).json({ code: e.code, error: e.message });
        return;
      }
      throw err;
    } finally {
      recoveryClient.release();
    }
  }

  // Transfer requires destination
  if (cash_transferred > 0) {
    if (!destination_location_id) {
      res.status(422).json({ error: "destination_location_id is required when cash_transferred > 0" });
      return;
    }
    if (destination_location_id === shift.location_id) {
      res.status(422).json({ error: "destination_location_id must differ from the shift's location" });
      return;
    }
    // ── Security: verify destination belongs to the caller's workspace ──────
    const destLocCheck = await db.query<{ id: number }>(
      `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
      [destination_location_id, wsId],
    );
    if (destLocCheck.rows.length === 0) {
      res.status(422).json({ error: "destination_location_id not found in this workspace" });
      return;
    }
    // ── Require an open cash session at the destination ──────────────────────
    // Without one the transfer has nowhere to land and the incoming tx would
    // have a null cash_session_id, leaving the destination drawer unaffected.
    const destSessionCheck = await db.query<{ id: number; currency: string }>(
      `SELECT cs.id, cs.currency FROM cash_sessions cs
         JOIN cash_drawers d ON d.id = cs.drawer_id
        WHERE cs.workspace_owner_id = $1 AND d.location_id = $2 AND cs.status = 'open'
        ORDER BY cs.opened_at DESC LIMIT 1`,
      [wsId, destination_location_id],
    );
    if (destSessionCheck.rows.length === 0) {
      res.status(422).json({
        code: "NO_DEST_SESSION",
        error: "The destination location has no open cash session. Open a cash session there before transferring.",
      });
      return;
    }

    // ── Currency-equality guard ───────────────────────────────────────────────
    // CMC shifts always open single-currency sessions. Transferring to a session
    // in a different currency would record the same numeric amount in both
    // currencies (e.g. AED 100 transferred as USD 100), corrupting balances.
    // Reject mismatches; same-currency transfers are always safe.
    const srcCurrencyCheck = await db.query<{ currency: string }>(
      `SELECT currency FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2`,
      [shift.cash_session_id, wsId],
    );
    const srcCurrency = srcCurrencyCheck.rows[0]?.currency ?? "";
    const destCurrency = destSessionCheck.rows[0].currency;
    if (srcCurrency && destCurrency && srcCurrency.toUpperCase() !== destCurrency.toUpperCase()) {
      res.status(422).json({
        code: "CURRENCY_MISMATCH_TRANSFER",
        error: `Cannot transfer between sessions with different currencies (source: ${srcCurrency}, destination: ${destCurrency}). ` +
          `Both locations must use the same currency for cash transfers.`,
        source_currency: srcCurrency,
        destination_currency: destCurrency,
      });
      return;
    }
  }

  const client = await db.connect();
  // Track IDs for post-transaction recompute (runs outside the transaction to avoid deadlock)
  let destSessionIdForRecompute: number | null = null;
  // Expected balance and discrepancy are computed inside the transaction and surfaced here
  let finalExpectedBalance = 0;
  let finalDiscrepancy = 0;
  // Secondary-currency reconciliation values (populated when session is dual-currency)
  let finalExpectedBalanceSecondary: number | null = null;
  let finalDiscrepancySecondary: number | null = null;

  let closedShift: Record<string, unknown>;
  try {
    closedShift = await withTransaction(client, async () => {
      // ── Step 1: Lock source session and compute expected balance from ledger ──
      // Locking here serializes concurrent sales/closes: a cash sale that locked
      // the same session will block until we commit; if it reads status='open'
      // before we acquire the lock, our UPDATE to pending_review will serialize
      // with its INSERT — see the sale route's matching FOR UPDATE below.
      //
      // Expected balance is derived from committed ledger rows (not the stale
      // expected_cash column) so it reflects any cash sales whose fire-and-forget
      // recomputeSessionTotals has not yet persisted.
      let sessionCurrency = shift.currency ?? "";
      let sessionSecondaryCurrency: string | null = null;
      if (shift.cash_session_id) {
        const lockedSession = await client.query<{
          opening_cash: string; currency: string;
          secondary_currency: string | null; opening_cash_secondary: string | null;
        }>(
          `SELECT opening_cash, currency, secondary_currency, opening_cash_secondary
             FROM cash_sessions
            WHERE id = $1 AND workspace_owner_id = $2 AND status = 'open'
            FOR UPDATE`,
          [shift.cash_session_id, wsId],
        );
        if (lockedSession.rows.length === 0) {
          throw Object.assign(
            new Error("The linked cash session is already closed. Please refresh and try again."),
            { code: "SESSION_ALREADY_CLOSED" },
          );
        }
        sessionCurrency = lockedSession.rows[0].currency;
        sessionSecondaryCurrency = lockedSession.rows[0].secondary_currency ?? null;
        const openingCash = Number(lockedSession.rows[0].opening_cash);

        // Sum committed cash_transactions for this session (excludes any rows not
        // yet committed, including those from the current transaction which has
        // not posted anything yet).
        // When the shift has an explicit currency (dual-currency drawer), filter
        // to only that currency so reconciliation remains single-currency.
        const shiftCurrency = shift.currency ?? sessionCurrency;
        const ledgerResult = await client.query<{
          cash_in: string; cash_out: string;
        }>(
          `SELECT
              COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount ELSE 0 END), 0)::text AS cash_in,
              COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0)::text AS cash_out
             FROM cash_transactions
            WHERE cash_session_id = $1 AND workspace_owner_id = $2 AND currency = $3`,
          [shift.cash_session_id, wsId, shiftCurrency],
        );
        const cashIn  = Number(ledgerResult.rows[0]?.cash_in  ?? 0);
        const cashOut = Number(ledgerResult.rows[0]?.cash_out ?? 0);
        finalExpectedBalance = openingCash + cashIn - cashOut;

        // ── Secondary-currency expected balance ───────────────────────────────
        // For dual-currency sessions compute the secondary expected balance from
        // committed ledger rows so it reflects any transactions already posted.
        if (sessionSecondaryCurrency) {
          const openingCashSecondary = Number(lockedSession.rows[0].opening_cash_secondary ?? 0);
          const secLedger = await client.query<{ cash_in: string; cash_out: string }>(
            `SELECT
                COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount ELSE 0 END), 0)::text AS cash_in,
                COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0)::text AS cash_out
               FROM cash_transactions
              WHERE cash_session_id = $1 AND workspace_owner_id = $2 AND currency = $3`,
            [shift.cash_session_id, wsId, sessionSecondaryCurrency],
          );
          const secIn  = Number(secLedger.rows[0]?.cash_in  ?? 0);
          const secOut = Number(secLedger.rows[0]?.cash_out ?? 0);
          finalExpectedBalanceSecondary = openingCashSecondary + secIn - secOut;
        }
      }

      // ── Step 2: Validate discrepancy inside the transaction ───────────────────
      // Now that we have the live expected balance, re-check the discrepancy note
      // requirement.  Throwing here rolls back the transaction cleanly.
      finalDiscrepancy = Math.round((cash_kept + cash_transferred + whish_transferred - finalExpectedBalance) * 100) / 100;
      // For dual-currency sessions also validate secondary discrepancy.
      if (sessionSecondaryCurrency && finalExpectedBalanceSecondary !== null) {
        const keptSec = cash_kept_secondary ?? 0;
        finalDiscrepancySecondary = Math.round((keptSec - finalExpectedBalanceSecondary) * 100) / 100;
      }
      const primaryHasGap = Math.abs(finalDiscrepancy) > 0.009;
      const secondaryHasGap = finalDiscrepancySecondary !== null && Math.abs(finalDiscrepancySecondary) > 0.009;
      if ((primaryHasGap || secondaryHasGap) && !discrepancy_note?.trim()) {
        throw Object.assign(
          new Error("A reconciliation note is required when the counted amount differs from the expected balance"),
          { code: "DISCREPANCY_NOTE_REQUIRED", discrepancy: finalDiscrepancy, expected_balance: finalExpectedBalance },
        );
      }

      // ── Step 3: Mark shift closed ─────────────────────────────────────────────
      const closeResult = await client.query(
        `UPDATE cmc_shifts
            SET status = 'closed', closed_at = now(), closed_by_user_id = $1,
                closing_cash_kept = $2, closing_cash_transferred = $3,
                closing_destination_location_id = $4, discrepancy_note = $5,
                closing_whish_transferred = $8
          WHERE id = $6 AND workspace_owner_id = $7 AND status = 'open'
          RETURNING *`,
        [uid, cash_kept.toFixed(2), cash_transferred.toFixed(2),
         destination_location_id ?? null, discrepancy_note?.trim() ?? null,
         shift.id, wsId, whish_transferred.toFixed(2)],
      );
      if (closeResult.rowCount === 0) throw new Error("Shift not found or already closed");
      const closedShiftRow = closeResult.rows[0] as Record<string, unknown>;

      // ── Step 4: Close cash session with frozen reconciliation values ───────────
      // actual_cash = total cash accounted for (kept + transferred).
      // expected_cash = live expected balance computed from ledger (pre-transfer).
      // difference = discrepancy between accounted and expected.
      // These are frozen now — recomputeSessionTotals skips non-open sessions so
      // they cannot be corrupted later by the transfer row we are about to post.
      // For dual-currency sessions also freeze the secondary reconciliation values.
      if (shift.cash_session_id) {
        const totalAccountedFor = (cash_kept + cash_transferred + whish_transferred).toFixed(2);
        // Secondary values (null for single-currency sessions)
        const actualCashSecondary =
          sessionSecondaryCurrency !== null ? (cash_kept_secondary ?? 0).toFixed(2) : null;
        const expectedCashSecondary =
          finalExpectedBalanceSecondary !== null ? finalExpectedBalanceSecondary.toFixed(2) : null;
        const differenceSecondary =
          finalDiscrepancySecondary !== null ? finalDiscrepancySecondary.toFixed(2) : null;

        await client.query(
          `UPDATE cash_sessions
              SET status = 'pending_review', closed_at = now(), closed_by_clerk_id = $1,
                  actual_cash              = $2,
                  expected_cash            = $3,
                  difference               = $4,
                  actual_cash_secondary    = $5,
                  expected_cash_secondary  = $6,
                  difference_secondary     = $7
            WHERE id = $8 AND workspace_owner_id = $9`,
          [uid, totalAccountedFor,
           finalExpectedBalance.toFixed(2),
           finalDiscrepancy.toFixed(2),
           actualCashSecondary,
           expectedCashSecondary,
           differenceSecondary,
           shift.cash_session_id, wsId],
        );
        await client.query(
          `INSERT INTO cash_session_activity_logs
             (workspace_owner_id, cash_session_id, action, actor_clerk_id, actor_name, detail)
           VALUES ($1, $2, 'closed', $3, NULL, $4)`,
          [wsId, shift.cash_session_id, uid,
           JSON.stringify({ actual_cash: cash_kept.toFixed(2), discrepancy: finalDiscrepancy.toFixed(2), source: "cmc_shift_close" })],
        );
      }

      // ── Step 5: Transfer transactions ─────────────────────────────────────────
      // ── Step 5b: Whish wallet transfer transaction ────────────────────────────
      if (whish_transferred > 0 && shift.cash_session_id) {
        await client.query(
          `INSERT INTO cash_transactions
             (workspace_owner_id, cash_session_id, location_id, currency, type, direction,
              amount, description, reference_type, created_by_clerk_id)
           VALUES ($1, $2, $3, $4, 'transfer', 'out', $5, 'Whish wallet transfer', 'whish_transfer', $6)`,
          [wsId, shift.cash_session_id, shift.location_id, sessionCurrency,
           whish_transferred.toFixed(2), uid],
        );
      }

      if (cash_transferred > 0 && destination_location_id) {
        const transferId = randomUUID();

        // Outgoing from source session (source is now pending_review)
        await client.query(
          `INSERT INTO cash_transactions
             (workspace_owner_id, cash_session_id, location_id, currency, type, direction,
              amount, description, reference_type, transfer_id, created_by_clerk_id)
           VALUES ($1, $2, $3, $4, 'transfer', 'out', $5, $6, 'cmc_shift_transfer', $7, $8)`,
          [wsId, shift.cash_session_id, shift.location_id, sessionCurrency,
           cash_transferred.toFixed(2), `Cash transfer to location ${destination_location_id}`,
           transferId, uid],
        );

        // Lock the destination session — prevents a concurrent close from voiding
        // the incoming transfer after we've already posted the outgoing row.
        const destSession = await client.query<{ id: number; currency: string }>(
          `SELECT cs.id, cs.currency
             FROM cash_sessions cs
             JOIN cash_drawers d ON d.id = cs.drawer_id
            WHERE cs.workspace_owner_id = $1 AND d.location_id = $2 AND cs.status = 'open'
            ORDER BY cs.opened_at DESC LIMIT 1
            FOR UPDATE`,
          [wsId, destination_location_id],
        );
        if (destSession.rows.length === 0) {
          throw Object.assign(
            new Error("The destination cash session closed just before the transfer could complete. Please re-check the destination drawer and try again."),
            { code: "DEST_SESSION_CLOSED_RACE" },
          );
        }
        destSessionIdForRecompute = destSession.rows[0].id;
        const destCurrency = destSession.rows[0].currency;

        // ── Currency equality — enforced on the locked destination row ─────────
        // The pre-transaction check may have passed on a session that closed and
        // was replaced by a new one in a different currency before we acquired the
        // lock.  Re-validate here against the locked row to guarantee atomicity.
        // Posting the same numeric amount in two different currencies (e.g. AED
        // outgoing, USD incoming) would corrupt both drawers' reconciliation.
        if (sessionCurrency.toUpperCase() !== destCurrency.toUpperCase()) {
          throw Object.assign(
            new Error(
              `Cannot transfer between sessions with different currencies ` +
              `(source: ${sessionCurrency}, destination: ${destCurrency}). ` +
              `Both locations must use the same currency for cash transfers.`,
            ),
            { code: "CURRENCY_MISMATCH_TRANSFER", source_currency: sessionCurrency, destination_currency: destCurrency },
          );
        }

        // Incoming to destination session
        await client.query(
          `INSERT INTO cash_transactions
             (workspace_owner_id, cash_session_id, location_id, currency, type, direction,
              amount, description, reference_type, transfer_id, created_by_clerk_id)
           VALUES ($1, $2, $3, $4, 'transfer', 'in', $5, $6, 'cmc_shift_transfer', $7, $8)`,
          [wsId, destSessionIdForRecompute, destination_location_id, destCurrency,
           cash_transferred.toFixed(2), `Cash transfer from location ${shift.location_id}`,
           transferId, uid],
        );
      }

      return closedShiftRow;
    });
  } catch (err) {
    client.release();
    const e = err as { code?: string; message?: string; discrepancy?: number; expected_balance?: number };
    if (e.code === "SESSION_ALREADY_CLOSED") {
      res.status(409).json({ code: "SESSION_ALREADY_CLOSED", error: e.message });
      return;
    }
    if (e.code === "CURRENCY_MISMATCH_TRANSFER") {
      res.status(422).json({
        code: "CURRENCY_MISMATCH_TRANSFER",
        error: e.message,
        source_currency: (e as { source_currency?: string }).source_currency,
        destination_currency: (e as { destination_currency?: string }).destination_currency,
      });
      return;
    }
    if (e.code === "DISCREPANCY_NOTE_REQUIRED") {
      res.status(422).json({
        code: "DISCREPANCY_NOTE_REQUIRED",
        error: e.message,
        discrepancy: e.discrepancy,
        expected_balance: e.expected_balance,
      });
      return;
    }
    if (e.code === "DEST_SESSION_CLOSED_RACE") {
      res.status(409).json({ code: "DEST_SESSION_CLOSED_RACE", error: e.message });
      return;
    }
    throw err;
  }
  client.release();

  // Recompute destination session totals OUTSIDE the transaction (global pool;
  // would deadlock if called inside).  Awaited — not fire-and-forget — so the
  // response reflects accurate destination totals and failures surface as 500
  // rather than being silently swallowed.
  // Source session is NOT recomputed: it is now closed/pending_review, and
  // recomputeSessionTotals skips non-open sessions (expected_cash is frozen).
  if (destSessionIdForRecompute) {
    await recomputeSessionTotals(destSessionIdForRecompute, wsId);
  }

  res.json({
    shift: closedShift,
    discrepancy: finalDiscrepancy,
    expected_balance: finalExpectedBalance,
    ...(finalExpectedBalanceSecondary !== null ? {
      expected_balance_secondary: finalExpectedBalanceSecondary,
      discrepancy_secondary: finalDiscrepancySecondary,
    } : {}),
  });
});

router.post("/cmc-pos/shifts/:id/close", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const shiftId = parseInt(req.params.id);
  if (isNaN(shiftId)) {
    res.status(400).json({ error: "Invalid shift id" });
    return;
  }

  // ── Guard: block legacy close for cash-session-linked shifts ─────────────
  // Closing a shift that owns a cash session via this endpoint leaves the
  // session open (orphaned), blocking all future shift opens on that drawer
  // and making reconciliation impossible. Redirect to the reconciliation flow.
  const shiftCheck = await db.query<{ id: number; cash_session_id: number | null }>(
    `SELECT id, cash_session_id FROM cmc_shifts
      WHERE id = $1 AND workspace_owner_id = $2 AND status = 'open'`,
    [shiftId, wreq.workspaceOwnerId],
  );
  if (shiftCheck.rows.length === 0) {
    res.status(404).json({ error: "Shift not found or already closed" });
    return;
  }
  if (shiftCheck.rows[0].cash_session_id !== null) {
    res.status(409).json({
      code: "USE_RECONCILIATION_CLOSE",
      error: "This shift has a linked cash session and must be closed via POST /api/cmc-pos/shifts/close to reconcile the drawer correctly.",
    });
    return;
  }

  const uid = actorId(req);
  const totals = req.body?.totals_by_method ?? {};
  const result = await db.query(
    `UPDATE cmc_shifts
        SET status = 'closed', closed_at = now(), closed_by_user_id = $1, totals_by_method = $2
      WHERE id = $3 AND workspace_owner_id = $4 AND status = 'open'
      RETURNING *`,
    [uid, JSON.stringify(totals), shiftId, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Shift not found or already closed" });
    return;
  }
  res.json({ shift: result.rows[0] });
});

// ---------------------------------------------------------------------------
// Resolution endpoints — overdue cash session resolution flow
// ---------------------------------------------------------------------------

const RESOLUTION_REASONS = [
  "forgot_to_close",
  "employee_unavailable",
  "technical_issue",
  "store_closed_unexpectedly",
  "other",
] as const;

const resolveBodySchema = z.object({
  shiftId: z.number().int(),
  countedBalance: z.number().min(0),
  countedBalanceSecondary: z.number().min(0).optional(),
  currency: z.string().min(1),
  reason: z.enum(RESOLUTION_REASONS),
  note: z.string().optional().nullable(),
});

/**
 * POST /api/cmc-pos/shifts/resolve
 * Resolve an overdue cash session. A valid late-closure reason is the approval:
 * the route records the audit row and immediately closes the session and shift.
 */
router.post("/cmc-pos/shifts/resolve", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;

  const parsed = resolveBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const { shiftId, countedBalance, countedBalanceSecondary, currency, reason, note } = parsed.data;

  // Load the shift
  const shiftResult = await db.query<{
    id: number; cash_session_id: number | null;
    location_id: number; opened_by_user_id: string;
  }>(
    `SELECT id, cash_session_id, location_id, opened_by_user_id
       FROM cmc_shifts
      WHERE id = $1 AND workspace_owner_id = $2 AND status = 'open'`,
    [shiftId, wsId],
  );
  if (!shiftResult.rows.length) {
    res.status(404).json({ error: "Active shift not found" });
    return;
  }
  const shift = shiftResult.rows[0];
  if (!shift.cash_session_id) {
    res.status(422).json({ code: "NO_LINKED_SESSION", error: "This shift has no linked cash session to resolve" });
    return;
  }

  // Location overdue config (outside tx — read-only, no locking needed)
  const locResult = await db.query<{
    same_day_cutoff_time: string | null;
    timezone: string | null;
    grace_period_minutes: number | null;
  }>(
    `SELECT same_day_cutoff_time, timezone, grace_period_minutes
       FROM locations WHERE id = $1`,
    [shift.location_id],
  );
  const loc = locResult.rows[0] ?? {};

  const client = await db.connect();
  try {
    const resolution = await withTransaction(client, async () => {
      // Lock the cash session — prevents concurrent double-close
      const lockedSess = await client.query<{
        id: number; status: string; opened_by_clerk_id: string | null;
        opened_at: string; opening_cash: string; currency: string;
        secondary_currency: string | null;
      }>(
        `SELECT id, status, opened_by_clerk_id, opened_at, opening_cash, currency, secondary_currency
           FROM cash_sessions
          WHERE id = $1 AND workspace_owner_id = $2
          FOR UPDATE`,
        [shift.cash_session_id, wsId],
      );
      if (!lockedSess.rows.length) {
        throw Object.assign(new Error("Linked cash session not found"), { statusCode: 404 });
      }
      const sess = lockedSess.rows[0];
      if (sess.status !== "open") {
        throw Object.assign(
          new Error("The cash session is already resolved or closed"),
          { statusCode: 409, code: "SESSION_ALREADY_CLOSED" },
        );
      }

      if (sess.secondary_currency && countedBalanceSecondary === undefined) {
        throw Object.assign(
          new Error(`A counted balance is required for ${sess.secondary_currency}`),
          { statusCode: 400, code: "SECONDARY_COUNT_REQUIRED" },
        );
      }

      // Validate supplied currency against the session's locked currency.
      // We derive the authoritative currency from the session — the client-supplied
      // value is treated as a confirmation to detect mismatches early.
      if (currency !== sess.currency) {
        throw Object.assign(
          new Error(
            `Currency mismatch: the cash session is denominated in ${sess.currency} ` +
            `but the request supplied "${currency}". Use "${sess.currency}".`,
          ),
          { statusCode: 422, code: "CURRENCY_MISMATCH", expected: sess.currency, received: currency },
        );
      }

      // Prevent duplicate active resolution (unique partial index on cash_session_id WHERE resolved_at IS NULL)
      const existingRes = await client.query<{ id: number }>(
        `SELECT id FROM cash_session_resolutions
          WHERE cash_session_id = $1 AND resolved_at IS NULL`,
        [sess.id],
      );
      if (existingRes.rows.length > 0) {
        throw Object.assign(
          new Error("An active resolution already exists for this session"),
          { statusCode: 409, code: "RESOLUTION_ALREADY_EXISTS", existing_id: existingRes.rows[0].id },
        );
      }

      // Gate on actual overdue state — this endpoint is only for overdue sessions.
      // Non-overdue open shifts must use POST /cmc-pos/shifts/close instead.
      const { isOverdue: sessionIsOverdue, overdueAt } = computeShiftOverdue(
        sess.opened_at,
        loc.same_day_cutoff_time ?? null,
        loc.timezone ?? null,
        loc.grace_period_minutes ?? null,
      );
      if (!sessionIsOverdue) {
        throw Object.assign(
          new Error(
            "This cash session is not currently overdue. " +
            "Use POST /api/cmc-pos/shifts/close to close a session that has not passed its cutoff time.",
          ),
          { statusCode: 422, code: "SESSION_NOT_OVERDUE" },
        );
      }

      // Recompute under the session lock so primary and secondary expected totals
      // use the same authoritative committed-ledger rules as the standard close.
      const reconciledSession = await recomputeSessionTotals(sess.id, wsId, client);
      if (!reconciledSession) {
        throw Object.assign(
          new Error("The cash session changed while it was being resolved"),
          { statusCode: 409, code: "SESSION_ALREADY_CLOSED" },
        );
      }
      const expectedBalance = Number(reconciledSession.expected_cash ?? sess.opening_cash);
      const difference = Math.round((countedBalance - expectedBalance) * 100) / 100;
      const expectedBalanceSecondary = sess.secondary_currency
        ? Number(reconciledSession.expected_cash_secondary ?? 0)
        : null;
      const differenceSecondary =
        sess.secondary_currency && countedBalanceSecondary !== undefined
          ? Math.round((countedBalanceSecondary - (expectedBalanceSecondary ?? 0)) * 100) / 100
          : null;

      // Original business date — calendar date of opening in location timezone
      const tz = (loc.timezone as string | null) ?? "UTC";
      const originalBusinessDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(sess.opened_at));

      // Insert resolution row
      const resInsert = await client.query<{ id: number; [k: string]: unknown }>(
        `INSERT INTO cash_session_resolutions
           (cash_session_id, workspace_id, session_owner_id, resolver_id,
            opened_at, original_business_date, configured_closing_time, grace_period_minutes,
            overdue_at, expected_balance, counted_balance, difference, currency,
            reason, note, manager_override, approval_required, approval_status,
            final_session_status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
         RETURNING *`,
        [
          sess.id, wsId,
          shift.opened_by_user_id ?? sess.opened_by_clerk_id ?? null,
          uid,
          sess.opened_at,
          originalBusinessDate,
          (loc.same_day_cutoff_time as string | null) ?? null,
          (loc.grace_period_minutes as number | null) ?? null,
          overdueAt?.toISOString() ?? null,
          expectedBalance.toFixed(2),
          countedBalance.toFixed(2),
          difference.toFixed(2),
          currency,
          reason,
          note?.trim() ?? null,
           false,
           false,
           null,
           "closed",
        ],
      );
      const resRow = resInsert.rows[0];

      // Immediately close and freeze every tracked currency. Overdue resolution
      // deliberately bypasses standard discrepancy-note and approval workflows.
      await client.query(
        `UPDATE cash_sessions
            SET status = 'closed', closed_at = now(), closed_by_clerk_id = $1,
                actual_cash = $2, expected_cash = $3, difference = $4,
                actual_cash_secondary = $5, expected_cash_secondary = $6,
                difference_secondary = $7
          WHERE id = $8 AND workspace_owner_id = $9`,
        [
          uid,
          countedBalance.toFixed(2),
          expectedBalance.toFixed(2),
          difference.toFixed(2),
          countedBalanceSecondary?.toFixed(2) ?? null,
          expectedBalanceSecondary?.toFixed(2) ?? null,
          differenceSecondary?.toFixed(2) ?? null,
          sess.id,
          wsId,
        ],
      );
      await client.query(
        `UPDATE cmc_shifts
            SET status = 'closed', closed_at = now(), closed_by_user_id = $1, resolution_id = $2
          WHERE id = $3 AND workspace_owner_id = $4`,
        [uid, resRow.id, shiftId, wsId],
      );
      await client.query(
        `UPDATE cash_session_resolutions SET resolved_at = now() WHERE id = $1`,
        [resRow.id],
      );
      await client.query(
        `INSERT INTO cash_session_activity_logs
           (workspace_owner_id, cash_session_id, action, actor_clerk_id, actor_name, detail)
         VALUES ($1,$2,'resolved',$3,NULL,$4)`,
        [
          wsId,
          sess.id,
          uid,
          JSON.stringify({
            resolution_id: resRow.id,
            reason,
            counted_balance: countedBalance,
            expected_balance: expectedBalance,
            difference,
            secondary_currency: sess.secondary_currency,
            counted_balance_secondary: countedBalanceSecondary ?? null,
            expected_balance_secondary: expectedBalanceSecondary,
            difference_secondary: differenceSecondary,
          }),
        ],
      );

      return {
        ...resRow,
        secondary_currency: sess.secondary_currency,
        counted_balance_secondary: countedBalanceSecondary ?? null,
        expected_balance_secondary: expectedBalanceSecondary,
        difference_secondary: differenceSecondary,
      };
    });

    res.status(201).json({ status: "closed", resolution });
  } catch (err) {
    const e = err as {
      statusCode?: number; code?: string; message?: string;
      existing_id?: number; expected?: string; received?: string;
    };
    if (e.statusCode) {
      res.status(e.statusCode).json({
        code: e.code,
        error: e.message,
        ...(e.existing_id ? { existing_resolution_id: e.existing_id } : {}),
        ...(e.expected ? { expected_currency: e.expected, received_currency: e.received } : {}),
      });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

/**
 * POST /api/cmc-pos/shifts/resolve/approve
 * Manager/admin approval of a pending resolution. Executes the close sequence.
 * Requires `cash_sessions.approve` permission or workspace owner.
 */
router.post("/cmc-pos/shifts/resolve/approve", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!can(wreq, "cash_sessions.approve")) {
    res.status(403).json({ error: "Requires cash_sessions.approve permission or owner role" });
    return;
  }
  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;

  const body = z.object({
    resolutionId: z.number().int(),
    approverNote: z.string().optional().nullable(),
  }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "resolutionId is required" });
    return;
  }
  const { resolutionId, approverNote } = body.data;

  const client = await db.connect();
  try {
    const updated = await withTransaction(client, async () => {
      // Lock the resolution row
      const resResult = await client.query<{
        id: number; cash_session_id: number; approval_status: string | null;
        approval_required: boolean; counted_balance: string; expected_balance: string;
        difference: string; resolved_at: string | null;
      }>(
        `SELECT id, cash_session_id, approval_status, approval_required,
                counted_balance, expected_balance, difference, resolved_at
           FROM cash_session_resolutions
          WHERE id = $1 AND workspace_id = $2
          FOR UPDATE`,
        [resolutionId, wsId],
      );
      if (!resResult.rows.length) {
        throw Object.assign(new Error("Resolution not found"), { statusCode: 404 });
      }
      const resolution = resResult.rows[0];
      if (!resolution.approval_required) {
        throw Object.assign(new Error("This resolution did not require approval"), { statusCode: 422 });
      }
      if (resolution.resolved_at !== null || resolution.approval_status === "approved") {
        throw Object.assign(new Error("Resolution already approved or finalized"), { statusCode: 409, code: "ALREADY_APPROVED" });
      }
      if (resolution.approval_status === "rejected") {
        throw Object.assign(new Error("Cannot approve a rejected resolution"), { statusCode: 409, code: "ALREADY_REJECTED" });
      }

      // Lock the cash session
      const sessResult = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2 FOR UPDATE`,
        [resolution.cash_session_id, wsId],
      );
      if (!sessResult.rows.length) {
        throw Object.assign(new Error("Linked cash session not found"), { statusCode: 404 });
      }
      if (sessResult.rows[0].status !== "open") {
        throw Object.assign(new Error("Cash session is already closed"), { statusCode: 409, code: "SESSION_ALREADY_CLOSED" });
      }

      // Find the open shift linked to this session (may have been closed out-of-band)
      const shiftResult = await client.query<{ id: number }>(
        `SELECT id FROM cmc_shifts
          WHERE workspace_owner_id = $1 AND cash_session_id = $2 AND status = 'open'
          LIMIT 1`,
        [wsId, resolution.cash_session_id],
      );

      // Approve: update resolution
      await client.query(
        `UPDATE cash_session_resolutions
            SET approval_status = 'approved', approver_id = $1, approval_at = now(),
                approver_note = $2, final_session_status = 'closed', resolved_at = now()
          WHERE id = $3`,
        [uid, approverNote?.trim() ?? null, resolutionId],
      );

      // Close the cash session with frozen reconciliation values
      await client.query(
        `UPDATE cash_sessions
            SET status = 'closed', closed_at = now(), closed_by_clerk_id = $1,
                actual_cash = $2, expected_cash = $3, difference = $4
          WHERE id = $5 AND workspace_owner_id = $6`,
        [uid, resolution.counted_balance, resolution.expected_balance,
         resolution.difference, resolution.cash_session_id, wsId],
      );

      // Close the shift and record the resolution FK
      if (shiftResult.rows.length > 0) {
        await client.query(
          `UPDATE cmc_shifts
              SET status = 'closed', closed_at = now(), closed_by_user_id = $1, resolution_id = $2
            WHERE id = $3 AND workspace_owner_id = $4`,
          [uid, resolutionId, shiftResult.rows[0].id, wsId],
        );
      }

      // Activity log
      await client.query(
        `INSERT INTO cash_session_activity_logs
           (workspace_owner_id, cash_session_id, action, actor_clerk_id, actor_name, detail)
         VALUES ($1,$2,'resolution_approved',$3,NULL,$4)`,
        [wsId, resolution.cash_session_id, uid,
         JSON.stringify({ resolution_id: resolutionId, approver_note: approverNote?.trim() ?? null })],
      );

      const finalRes = await client.query(
        `SELECT * FROM cash_session_resolutions WHERE id = $1`, [resolutionId],
      );
      return finalRes.rows[0];
    });

    res.json({ status: "approved", resolution: updated });
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode) {
      res.status(e.statusCode).json({ code: e.code, error: e.message });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

/**
 * POST /api/cmc-pos/shifts/resolve/reject
 * Manager/admin rejection of a pending resolution. Session remains open.
 * Requires `cash_sessions.approve` permission or workspace owner.
 */
router.post("/cmc-pos/shifts/resolve/reject", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!can(wreq, "cash_sessions.approve")) {
    res.status(403).json({ error: "Requires cash_sessions.approve permission or owner role" });
    return;
  }
  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;

  const body = z.object({
    resolutionId: z.number().int(),
    approverNote: z.string().optional().nullable(),
  }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "resolutionId is required" });
    return;
  }
  const { resolutionId, approverNote } = body.data;

  const rejectClient = await db.connect();
  try {
    const updatedRow = await withTransaction(rejectClient, async () => {
      // Lock the resolution row — prevents concurrent approve from being overwritten
      const resResult = await rejectClient.query<{
        id: number; cash_session_id: number; approval_status: string | null; resolved_at: string | null;
      }>(
        `SELECT id, cash_session_id, approval_status, resolved_at
           FROM cash_session_resolutions
          WHERE id = $1 AND workspace_id = $2
          FOR UPDATE`,
        [resolutionId, wsId],
      );
      if (!resResult.rows.length) {
        throw Object.assign(new Error("Resolution not found"), { statusCode: 404 });
      }
      const resolution = resResult.rows[0];
      if (resolution.approval_status === "approved" || resolution.resolved_at !== null) {
        throw Object.assign(
          new Error("Cannot reject an already approved or finalized resolution"),
          { statusCode: 409, code: "ALREADY_RESOLVED" },
        );
      }

      // Reject and finalize: set resolved_at so the partial unique index
      // (WHERE resolved_at IS NULL) no longer covers this row, allowing a
      // fresh resolution attempt after rejection.
      await rejectClient.query(
        `UPDATE cash_session_resolutions
            SET approval_status = 'rejected', approver_id = $1, approval_at = now(),
                approver_note = $2, resolved_at = now()
          WHERE id = $3 AND workspace_id = $4`,
        [uid, approverNote?.trim() ?? null, resolutionId, wsId],
      );

      await rejectClient.query(
        `INSERT INTO cash_session_activity_logs
           (workspace_owner_id, cash_session_id, action, actor_clerk_id, actor_name, detail)
         VALUES ($1,$2,'resolution_rejected',$3,NULL,$4)`,
        [wsId, resolution.cash_session_id, uid,
         JSON.stringify({ resolution_id: resolutionId, approver_note: approverNote?.trim() ?? null })],
      );

      const finalRes = await rejectClient.query(
        `SELECT * FROM cash_session_resolutions WHERE id = $1`, [resolutionId],
      );
      return finalRes.rows[0];
    });

    res.json({ status: "rejected", resolution: updatedRow });
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode) {
      res.status(e.statusCode).json({ code: e.code, error: e.message });
      return;
    }
    throw err;
  } finally {
    rejectClient.release();
  }
});

/**
 * GET /api/cmc-pos/shifts
 * Paginated list of shifts (for shift history panel).
 */
router.get("/cmc-pos/shifts", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const locationId = req.query.location_id ? parseInt(req.query.location_id as string) : null;
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  // When ?filter=overdue is passed, restrict to shifts that were resolved via the
  // overdue reconciliation flow (i.e. have a linked cash_session_resolutions row).
  const filterOverdue = req.query.filter === "overdue";

  const params: unknown[] = [wreq.workspaceOwnerId];
  const conditions = ["s.workspace_owner_id = $1"];
  if (locationId) { params.push(locationId); conditions.push(`s.location_id = $${params.length}`); }
  // The LATERAL join alias `r` is available in WHERE after the FROM clause.
  if (filterOverdue) { conditions.push("r.id IS NOT NULL"); }
  const where = conditions.join(" AND ");
  params.push(limit, offset);

  const result = await db.query(
    `SELECT s.*, l.name AS location_name,
            COALESCE(
              (SELECT SUM(ct.amount) FROM cash_transactions ct
               WHERE ct.cash_session_id = s.cash_session_id
                 AND ct.workspace_owner_id = s.workspace_owner_id
                 AND ct.type = 'cash_sale'),
              0
            ) AS cash_sales_total,
            r.id             AS resolution_id,
            r.approval_status AS resolution_status,
            r.reason         AS resolution_reason,
            r.overdue_at,
            r.resolved_at,
            r.original_business_date,
            r.grace_period_minutes AS resolution_grace_minutes
       FROM cmc_shifts s
       LEFT JOIN locations l ON l.id = s.location_id
       LEFT JOIN LATERAL (
         SELECT id, approval_status, reason, overdue_at, resolved_at,
                original_business_date, grace_period_minutes
           FROM cash_session_resolutions
          WHERE cash_session_id = s.cash_session_id
            AND workspace_id = s.workspace_owner_id
          ORDER BY created_at DESC
          LIMIT 1
       ) r ON true
      WHERE ${where}
      ORDER BY s.opened_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ shifts: result.rows });
});

// ---------------------------------------------------------------------------
// Shelf Products — is_cmc=true products with stock
// ---------------------------------------------------------------------------

router.get("/cmc-pos/shelf-products", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const locationId = req.query.location_id ? parseInt(req.query.location_id as string) : null;

  const stockJoin = locationId
    ? `LEFT JOIN (
         SELECT product_id, SUM(quantity_change) AS stock
           FROM base_item_stock_adjustments
          WHERE (location_id = ${locationId} OR location_id IS NULL)
            AND product_id IS NOT NULL
          GROUP BY product_id
       ) stock ON stock.product_id = p.id`
    : "";

  const stockSelect = locationId ? ", COALESCE(stock.stock, 0) AS stock_qty" : "";

  const result = await db.query(
    `SELECT p.id, p.name, p.price_usd, p.price_aed, p.main_image_url,
            p.status, p.sku, p.is_cmc, p.has_input_field${stockSelect}
       FROM products p
       ${stockJoin}
      WHERE p.workspace_owner_id = $1
        AND p.is_cmc = true
        AND p.is_archived = false
        AND p.status != 'not_available'
      ORDER BY p.name ASC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ products: result.rows });
});

// ---------------------------------------------------------------------------
// Branch Products — is_cmc=true products with per-branch stock
// ---------------------------------------------------------------------------

router.get("/cmc-pos/branch-products", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;

  const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
  const category = typeof req.query.category === "string" ? req.query.category.trim() : null;
  const rawPage = typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
  const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
  const offset = (page - 1) * limit;

  const conditions: string[] = [
    "p.workspace_owner_id = $1",
    "p.is_archived = false",
    "p.status != 'not_available'",
  ];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (q) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(
      `(p.name ILIKE $${params.length} ESCAPE '\\' OR p.sku ILIKE $${params.length} ESCAPE '\\' OR p.barcode ILIKE $${params.length} ESCAPE '\\')`,
    );
  }

  if (category) {
    params.push(`%${category.replace(/([%_\\])/g, "\\$1").toLowerCase()}%`);
    conditions.push(
      `EXISTS (SELECT 1 FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = p.id AND lower(cc.name) ILIKE $${params.length} ESCAPE '\\')`,
    );
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await db.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM products p ${whereClause}`,
    params,
  );
  const total = countResult.rows[0]?.total ?? 0;

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const result = await db.query(
    `SELECT p.id, p.name, p.price_usd, p.price_aed, p.main_image_url, p.status, p.sku, p.barcode,
       COALESCE(
         (SELECT json_agg(json_build_object('id', cc.id, 'name', cc.name))
            FROM product_catalog_categories pcc
            JOIN catalog_categories cc ON cc.id = pcc.attribute_id
           WHERE pcc.product_id = p.id),
         '[]'::json
       ) AS catalog_categories
       FROM products p
      ${whereClause}
      ORDER BY p.name ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  res.json({ products: result.rows, total, page, limit });
});

// ---------------------------------------------------------------------------
// Sales — Workflow 1
// ---------------------------------------------------------------------------

const lineItemSchema = z.object({
  product_id: z.number().int().nullable(),
  name: z.string(),
  qty: z.number().int().min(1),
  unit_price: z.number().min(0),
  discount: z.number().min(0).optional().default(0),
  image_url: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  item_type: z.enum(["shelf", "custom"]).default("shelf"),
});

const createSaleSchema = z.object({
  location_id: z.number().int(),
  shift_id: z.number().int().optional().nullable(),
  line_items: z.array(lineItemSchema).min(1),
  payment_method: z.string().optional().nullable(),
  payment_reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  idempotency_key: z.string().optional().nullable(),
  discount_amount: z.number().min(0).optional().default(0),
  // New total-level discount (applies to shelf + custom combined). When
  // discount_type is present it takes precedence over legacy discount_amount,
  // which is recomputed server-side from type + value.
  discount_type: z.enum(["percent", "amount"]).optional().nullable(),
  discount_value: z.number().min(0).optional().nullable(),
  discount_description: z.string().max(500).optional().nullable(),
  customer_contact_id: z.string().optional().nullable(),
  fulfilment_date: z.string().date().optional().nullable(),
  fulfilment_date_to: z.string().date().optional().nullable(),
  receipt_image_url: z.string().min(1).optional().nullable(),
});

router.post("/cmc-pos/sales", async (req, res) => {
  // Sale creation matches the /cmc-pos/sale route guard: any base CMC access
  // (cmc-pos page or any cmc_pos.* permission) may record a sale. The
  // cmc_pos.sell key remains sufficient but is no longer required.
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const parsed = createSaleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid sale data", details: parsed.error.issues });
    return;
  }
  const { location_id, shift_id, line_items, payment_method, payment_reference, notes, idempotency_key, discount_amount, discount_type, discount_value, discount_description, customer_contact_id, fulfilment_date, fulfilment_date_to, receipt_image_url } = parsed.data;

  const shelfSubtotal = line_items
    .filter((li) => li.item_type === "shelf")
    .reduce((s, li) => s + li.unit_price * li.qty, 0);
  const customSubtotal = line_items
    .filter((li) => li.item_type === "custom")
    .reduce((s, li) => s + li.unit_price * li.qty, 0);
  const subtotal = shelfSubtotal + customSubtotal;

  let discAmt: number;
  let total: number;
  let savedDiscountType: string | null = null;
  let savedDiscountValue: number | null = null;
  const savedDiscountDescription = discount_description?.trim() || null;
  if (discount_type) {
    // New path: discount applies to the COMBINED subtotal (shelf + custom).
    // The discount amount is always recomputed server-side from type + value.
    if (discount_value === null || discount_value === undefined) {
      res.status(422).json({ error: "discount_value is required when discount_type is set" });
      return;
    }
    if (discount_type === "percent") {
      if (discount_value > 100) {
        res.status(422).json({ error: "Percentage discount cannot exceed 100%" });
        return;
      }
      discAmt = Math.round(subtotal * discount_value) / 100;
    } else {
      if (discount_value > subtotal) {
        res.status(422).json({ error: "Discount cannot exceed the sale subtotal", subtotal });
        return;
      }
      discAmt = discount_value;
    }
    savedDiscountType = discount_type;
    savedDiscountValue = discount_value;
    total = Math.max(0, subtotal - discAmt);
  } else {
    // Legacy path: amount-only discount against the shelf subtotal.
    const rawDisc = discount_amount ?? 0;
    if (rawDisc > shelfSubtotal) {
      res.status(422).json({ error: "Discount cannot exceed the shelf items subtotal", shelf_subtotal: shelfSubtotal });
      return;
    }
    discAmt = rawDisc;
    total = Math.max(0, shelfSubtotal - discAmt) + customSubtotal;
  }

  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;

  // ── Cash sale gate: derive session from the LOCATION'S open shift ─────────
  // Shelf sales are allowed for any workspace member as long as the requested
  // location has an open shift/cash session — regardless of who opened it.
  // The cash_session_id is always derived server-side from that shift (never
  // accepted from the client), and the sale + ledger entries are attributed
  // to the actual seller (uid), not the shift opener.
  let cashSessionId: number | null = null;
  let resolvedShiftId: string | number | null = shift_id ?? null;
  if (payment_method === "cash") {
    const callerShiftResult = await db.query<{ id: number; location_id: number; cash_session_id: number | null }>(
      `SELECT id, location_id, cash_session_id
         FROM cmc_shifts
        WHERE workspace_owner_id = $1
          AND location_id        = $2
          AND status             = 'open'
        ORDER BY opened_at DESC
        LIMIT 1`,
      [wsId, location_id],
    );
    if (callerShiftResult.rows.length === 0) {
      res.status(422).json({ code: "NO_ACTIVE_CASH_SESSION", error: "No open cash shift at this location — start a shift before recording a cash sale" });
      return;
    }
    const callerShift = callerShiftResult.rows[0];
    if (callerShift.cash_session_id === null) {
      // ── Recovery: try to adopt an open cash session at the shift's location ──
      // Shifts opened before the cash-drawer feature shipped (or at locations
      // where the drawer was configured after the shift was started) have
      // cash_session_id = null.  If an open session exists at this location's
      // active drawer and is not already owned by another open shift, back-patch
      // this shift and proceed.
      //
      // Concurrency strategy: acquire a row-level FOR UPDATE lock on the
      // candidate cash_session row *inside a transaction*, then re-verify that
      // no other shift owns it before linking.  This prevents two concurrent
      // null-session requests from each observing the same session as unowned
      // and both adopting it.  The IS NULL guard on the UPDATE is a second-line
      // defence for concurrent requests against the same shift row.
      const adoptionClient = await db.connect();
      let adoptedSessionId: number | null = null;
      try {
        adoptedSessionId = await withTransaction(adoptionClient, async () => {
          // Lock the best candidate session (row-level; serializes adoption races)
          const candidateResult = await adoptionClient.query<{ id: number }>(
            `SELECT cs.id
               FROM cash_sessions cs
               JOIN cash_drawers d ON d.id = cs.drawer_id
              WHERE cs.workspace_owner_id = $1
                AND d.location_id = $2
                AND d.is_active = true
                AND cs.status = 'open'
              ORDER BY cs.opened_at DESC
              LIMIT 1
              FOR UPDATE OF cs`,
            [wsId, callerShift.location_id],
          );
          if (candidateResult.rows.length === 0) return null;

          const candidateId = candidateResult.rows[0].id;

          // Re-check inside the lock: reject if another open shift already owns it
          const ownerCheck = await adoptionClient.query<{ id: number }>(
            `SELECT id FROM cmc_shifts
              WHERE workspace_owner_id = $1
                AND cash_session_id = $2
                AND status = 'open'
              LIMIT 1`,
            [wsId, candidateId],
          );
          if (ownerCheck.rows.length > 0) return null; // already owned by another shift

          // Link the session to this shift; IS NULL guard handles same-shift races
          const updateResult = await adoptionClient.query<{ id: number }>(
            `UPDATE cmc_shifts
                SET cash_session_id = $1
              WHERE id = $2
                AND workspace_owner_id = $3
                AND cash_session_id IS NULL
              RETURNING id`,
            [candidateId, callerShift.id, wsId],
          );
          return updateResult.rows.length > 0 ? candidateId : null;
        });
      } finally {
        adoptionClient.release();
      }

      if (adoptedSessionId !== null) {
        cashSessionId = adoptedSessionId;
        resolvedShiftId = callerShift.id;
      } else {
        res.status(422).json({ code: "NO_ACTIVE_CASH_SESSION", error: "Your shift has no linked cash session — contact a manager" });
        return;
      }
    } else {
      // Normal path: shift already has a linked session — use it directly
      cashSessionId = callerShift.cash_session_id;
      resolvedShiftId = callerShift.id;
    }
    // If the client provided a shift_id, reject if it doesn't match the
    // location's open shift (stale client state — refresh and retry).
    if (shift_id !== null && shift_id !== undefined && Number(shift_id) !== callerShift.id) {
      res.status(403).json({ code: "SHIFT_OWNERSHIP", error: "shift_id does not match the location's open shift" });
      return;
    }
  }

  // ── Insert sale + ledger entry atomically ─────────────────────────────────
  const client = await db.connect();
  let saleRow: Record<string, unknown>;
  try {
    saleRow = await withTransaction(client, async () => {
      // Lock the session at the start of the transaction to prevent a concurrent
      // shift close from completing between the authorization check above and the
      // ledger INSERT below.  If close committed first, status = 'pending_review'
      // and we reject here; if we go first, close will block on our lock until
      // we commit (at which point close sees the committed sale in the ledger).
      if (cashSessionId) {
        const sessionLock = await client.query<{ id: number }>(
          `SELECT id FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2 AND status = 'open' FOR UPDATE`,
          [cashSessionId, wsId],
        );
        if (sessionLock.rows.length === 0) {
          throw Object.assign(
            new Error("The cash session was closed while your sale was being processed. Please start a new shift before recording cash sales."),
            { code: "CASH_SESSION_CLOSED_DURING_SALE" },
          );
        }
      }

      const result = await client.query(
        `INSERT INTO cmc_sales
           (workspace_owner_id, shift_id, location_id, created_by_user_id,
            line_items, subtotal, discount_amount, total, payment_method,
            payment_reference, notes, idempotency_key, customer_contact_id, fulfilment_date,
            fulfilment_date_to, receipt_image_url, discount_type, discount_value, discount_description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [
          wsId, resolvedShiftId ?? null, location_id, uid, JSON.stringify(line_items),
          subtotal.toFixed(4), discAmt.toFixed(4), total.toFixed(4),
          payment_method ?? null, payment_reference ?? null, notes ?? null,
          idempotency_key ?? null, customer_contact_id ?? null, fulfilment_date ?? null,
          fulfilment_date_to ?? null, receipt_image_url ?? null,
          savedDiscountType, savedDiscountValue !== null ? savedDiscountValue.toFixed(4) : null,
          savedDiscountDescription,
        ],
      );
      const sale = result.rows[0] as Record<string, unknown>;

      // Record cash ledger entry
      if (payment_method === "cash" && cashSessionId) {
        await client.query(
          `INSERT INTO cash_transactions
             (workspace_owner_id, cash_session_id, location_id, currency, type, direction,
              amount, description, reference_type, reference_id, created_by_clerk_id, sale_channel)
           VALUES ($1, $2, $3,
                   COALESCE((SELECT currency FROM cash_sessions WHERE id = $2), 'AED'),
                   'cash_sale', 'in', $4, $5, 'cmc_sale', $6, $7, 'walk_in')
           ON CONFLICT (workspace_owner_id, reference_id) WHERE type = 'cash_sale' AND reference_id IS NOT NULL DO NOTHING`,
          [wsId, cashSessionId, location_id, total.toFixed(2),
           `CMC cash sale`, String(sale.id), uid],
        );
      }

      // ── Stock deductions (atomic with sale insert) ────────────────────────
      // Only deduct shelf items that are linked to a product. Custom items
      // (item_type = 'custom') are excluded — they have no product stock to track.
      // Idempotency key prevents double-counting if the transaction is retried.
      const saleIdStr = String(sale.id);
      for (let i = 0; i < line_items.length; i++) {
        const li = line_items[i];
        if (!li.product_id || li.item_type !== "shelf") continue;
        await client.query(
          `INSERT INTO base_item_stock_adjustments
             (workspace_owner_id, base_item_id, location_id, quantity_change, reason,
               movement_type, note, stock_after, created_by_user_id, product_id,
               idempotency_key, ledger_scope)
            VALUES ($1, NULL, $2, $3, 'cmc_sale', 'cmc_sale', $4, 0, $5, $6, $7,
                    'cmc_product_compat')
            ON CONFLICT (workspace_owner_id, idempotency_key)
              WHERE idempotency_key IS NOT NULL DO NOTHING`,
          [wsId, location_id, -li.qty, `cmc_sale:${saleIdStr}`, uid, li.product_id,
           `cmc_sale:${saleIdStr}:li:${i}`],
        );
      }

      return sale;
    });
  } catch (err: unknown) {
    client.release();
    const pgErr = err as { code?: string; message?: string };
    if (pgErr?.code === "23505") {
      // Idempotency hit on sale idempotency_key
      const dup = await db.query(
        `SELECT * FROM cmc_sales WHERE workspace_owner_id = $1 AND idempotency_key = $2`,
        [wsId, idempotency_key],
      );
      res.status(200).json({ sale: dup.rows[0] });
      return;
    }
    if (pgErr?.code === "CASH_SESSION_CLOSED_DURING_SALE") {
      res.status(409).json({ code: "CASH_SESSION_CLOSED_DURING_SALE", error: pgErr.message });
      return;
    }
    throw err;
  }
  client.release();

  // Recompute session totals outside transaction (best-effort)
  if (cashSessionId) {
    void recomputeSessionTotals(cashSessionId, wsId);
  }

  // Notify dashboard listeners of the new shelf sale.
  broadcastEvent(wsId, {
    event: "cmc_sale.created",
    workspaceId: wsId,
    data: {
      id: String(saleRow.id),
      locationId: location_id,
      total,
      paymentMethod: payment_method ?? null,
    },
  });

  res.status(201).json({ sale: saleRow });
});

router.get("/cmc-pos/sales", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const shiftId = req.query.shift_id ? parseInt(req.query.shift_id as string) : null;
  const locationId = req.query.location_id ? parseInt(req.query.location_id as string) : null;
  const status = req.query.status as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const fromDate = req.query.from as string | undefined;
  const toDate = req.query.to as string | undefined;

  const conditions: string[] = ["workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (shiftId) { params.push(shiftId); conditions.push(`shift_id = $${params.length}`); }
  if (locationId) { params.push(locationId); conditions.push(`location_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (fromDate) { params.push(fromDate); conditions.push(`COALESCE(fulfilment_date::timestamptz, created_at) >= $${params.length}`); }
  if (toDate) { params.push(toDate); conditions.push(`COALESCE(fulfilment_date::timestamptz, created_at) <= $${params.length}`); }

  const where = conditions.join(" AND ");
  const countResult = await db.query(
    `SELECT COUNT(*) AS total FROM cmc_sales WHERE ${where}`,
    params,
  );
  params.push(limit);
  params.push(offset);
  const result = await db.query(
    `SELECT * FROM cmc_sales WHERE ${where} ORDER BY COALESCE(fulfilment_date::timestamptz, created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ sales: result.rows, total: Number(countResult.rows[0].total), limit, offset });
});

router.get("/cmc-pos/sales/export", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;

  const shiftId = req.query.shift_id ? parseInt(req.query.shift_id as string) : null;
  const status = req.query.status as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  const conditions: string[] = ["workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (shiftId) { params.push(shiftId); conditions.push(`shift_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`COALESCE(fulfilment_date::timestamptz, created_at) >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`COALESCE(fulfilment_date::timestamptz, created_at) <= $${params.length}`); }

  params.push(10000);
  const where = conditions.join(" AND ");
  const result = await db.query(
    `SELECT * FROM cmc_sales WHERE ${where} ORDER BY COALESCE(fulfilment_date::timestamptz, created_at) DESC LIMIT $${params.length}`,
    params,
  );

  function csvField(val: unknown): string {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function itemsSummary(items: unknown): string {
    if (!Array.isArray(items)) return "";
    return (items as Array<{ name: string; qty: number }>)
      .map((li) => `${li.name} x${li.qty}`)
      .join("; ");
  }

  type CsvLineItem = { name: string; qty: number; unit_price?: number; item_type?: string };
  function lineItemsCsv(items: unknown): string {
    if (!Array.isArray(items)) return "";
    return (items as CsvLineItem[])
      .map((li) => {
        const lineTotal = ((li.unit_price ?? 0) * li.qty).toFixed(2);
        const type = li.item_type ?? "shelf";
        return `[${type}] ${li.name} x${li.qty} @ $${(li.unit_price ?? 0).toFixed(2)} = $${lineTotal}`;
      })
      .join(" | ");
  }

  const header = ["Sale ID", "Date/Time", "Fulfilment Date", "Location ID", "Line Items (type/name/qty/unit/total)", "Subtotal", "Discount", "Total", "Payment Method", "Status", "Notes"];
  const rows = result.rows.map((s) => [
    csvField(s.id),
    csvField(s.created_at ? new Date(s.created_at as string).toISOString() : ""),
    csvField(s.fulfilment_date ?? ""),
    csvField(s.location_id),
    csvField(lineItemsCsv(s.line_items)),
    csvField(s.subtotal),
    csvField(s.discount_amount),
    csvField(s.total),
    csvField(s.payment_method),
    csvField(s.status),
    csvField(s.notes),
  ]);

  const csvLines = [header.join(","), ...rows.map((r) => r.join(","))];
  const csv = csvLines.join("\r\n");

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="cmc-sales-${dateStr}.csv"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Bulk reporting-date correction
// ---------------------------------------------------------------------------

type BulkDateCorrectionInput = {
  source_from: string;
  source_to: string;
  target_date: string;
};

function parseBulkDateCorrectionInput(body: unknown): BulkDateCorrectionInput | null {
  const parsed = z.object({
    source_from: z.string(),
    source_to: z.string(),
    target_date: z.string(),
  }).safeParse(body);
  if (!parsed.success) return null;
  const { source_from, source_to, target_date } = parsed.data;
  if (
    !isValidAuditRange(source_from, source_to) ||
    !isValidAuditRange(target_date, target_date)
  ) {
    return null;
  }
  const sourceYear = source_from.slice(0, 4);
  if (
    source_from !== `${sourceYear}-07-01` ||
    source_to !== `${sourceYear}-07-31` ||
    target_date !== `${sourceYear}-08-01`
  ) {
    return null;
  }
  return parsed.data;
}

const BULK_DATE_CORRECTION_SCOPE = `
  workspace_owner_id = $1
  AND status = 'paid'
  AND workflow_type IN ('shelf_sale', 'order')
  AND COALESCE(fulfilment_date, (created_at AT TIME ZONE '${CMC_REPORTING_TIMEZONE}')::date)
      BETWEEN $2 AND $3
`;

async function getBulkDateCorrectionPreview(
  workspaceOwnerId: string,
  input: BulkDateCorrectionInput,
  query: typeof db.query = db.query.bind(db),
) {
  const result = await query(
    `SELECT COUNT(*) AS matching_count, COALESCE(SUM(total), 0) AS gross_total
       FROM cmc_sales
      WHERE ${BULK_DATE_CORRECTION_SCOPE}`,
    [workspaceOwnerId, input.source_from, input.source_to],
  );
  const row = result.rows[0] ?? {};
  return {
    source_from: input.source_from,
    source_to: input.source_to,
    target_date: input.target_date,
    matching_count: Number(row.matching_count ?? 0),
    gross_total: String(row.gross_total ?? "0"),
  };
}

function requireCmcSaleEdit(req: Request, res: Response): WorkspaceRequest | null {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return null;
  if (!hasSub(wreq, "cmc_pos.edit")) {
    res.status(403).json({ error: "Requires cmc_pos.edit permission" });
    return null;
  }
  return wreq;
}

router.post("/cmc-pos/sales/bulk-date-correction/preview", async (req, res) => {
  const wreq = requireCmcSaleEdit(req, res);
  if (!wreq) return;
  const input = parseBulkDateCorrectionInput(req.body);
  if (!input) {
    res.status(400).json({
      error: "The correction must move July 1–31 to August 1 within the same year",
    });
    return;
  }

  try {
    res.json(await getBulkDateCorrectionPreview(wreq.workspaceOwnerId, input));
  } catch (err) {
    req.log.error({ err }, "CMC bulk date correction preview failed");
    res.status(500).json({ error: "Failed to preview the date correction" });
  }
});

router.post("/cmc-pos/sales/bulk-date-correction/apply", async (req, res) => {
  const wreq = requireCmcSaleEdit(req, res);
  if (!wreq) return;
  const input = parseBulkDateCorrectionInput(req.body);
  if (!input) {
    res.status(400).json({
      error: "The correction must move July 1–31 to August 1 within the same year",
    });
    return;
  }

  const client = await db.connect();
  try {
    const result = await withTransaction(client, async () => {
      // Lock the exact source set before changing it. The same scope is
      // repeated on UPDATE so concurrent changes cannot broaden this operation.
      const locked = await client.query<{ id: string; total: string }>(
        `SELECT id, total
           FROM cmc_sales
          WHERE ${BULK_DATE_CORRECTION_SCOPE}
          FOR UPDATE`,
        [wreq.workspaceOwnerId, input.source_from, input.source_to],
      );
      const beforeGross = locked.rows.reduce(
        (sum, row) => sum + Number(row.total ?? 0),
        0,
      );

      let updatedRows: Array<{ id: string; total: string }> = [];
      if (locked.rows.length > 0) {
        const updated = await client.query<{ id: string; total: string }>(
          `UPDATE cmc_sales
              SET fulfilment_date = $4
            WHERE ${BULK_DATE_CORRECTION_SCOPE}
              AND id = ANY($5::uuid[])
          RETURNING id, total`,
          [
            wreq.workspaceOwnerId,
            input.source_from,
            input.source_to,
            input.target_date,
            locked.rows.map((row) => row.id),
          ],
        );
        updatedRows = updated.rows;
      }

      const movedGross = updatedRows.reduce(
        (sum, row) => sum + Number(row.total ?? 0),
        0,
      );
      return {
        source_from: input.source_from,
        source_to: input.source_to,
        target_date: input.target_date,
        before_count: locked.rows.length,
        before_gross_total: beforeGross.toFixed(2),
        moved_count: updatedRows.length,
        moved_gross_total: movedGross.toFixed(2),
        after_count: updatedRows.length,
        after_gross_total: movedGross.toFixed(2),
      };
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "CMC bulk date correction apply failed");
    res.status(500).json({ error: "Failed to apply the date correction" });
  } finally {
    client.release();
  }
});

const updateLineItemSchema = z.object({
  product_id: z.number().int().nullable().optional(),
  name: z.string().min(1),
  qty: z.number().int().min(1).optional().default(1),
  unit_price: z.number().min(0),
  discount: z.number().min(0).optional(),
  image_url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  item_type: z.enum(["shelf", "custom"]).optional(),
});

const updateSaleSchema = z.object({
  notes: z.string().nullable().optional(),
  payment_method: z.string().nullable().optional(),
  payment_reference: z.string().nullable().optional(),
  fulfilment_date: z.string().date().nullable().optional(),
  discount_amount: z.number().min(0).optional(),
  // Total-level discount metadata. Pass discount_type: null to clear it and
  // fall back to the legacy shelf-subtotal discount_amount behaviour.
  discount_type: z.enum(["percent", "amount"]).nullable().optional(),
  discount_value: z.number().min(0).nullable().optional(),
  discount_description: z.string().max(500).nullable().optional(),
  line_items: z.array(lineItemSchema).min(1).optional(),
});

router.patch("/cmc-pos/sales/:id", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!hasSub(wreq, "cmc_pos.edit")) {
    res.status(403).json({ error: "Requires cmc_pos.edit permission" });
    return;
  }
  const parsed = updateSaleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update data", details: parsed.error.issues });
    return;
  }
  const { notes, payment_method, payment_reference, fulfilment_date, discount_amount, discount_type, discount_value, discount_description, line_items } = parsed.data;

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [req.params.id, wreq.workspaceOwnerId];

  if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`); }
  if (payment_method !== undefined) { params.push(payment_method); sets.push(`payment_method = $${params.length}`); }
  if (payment_reference !== undefined) { params.push(payment_reference); sets.push(`payment_reference = $${params.length}`); }
  if (fulfilment_date !== undefined) { params.push(fulfilment_date); sets.push(`fulfilment_date = $${params.length}`); }
  if (discount_description !== undefined) { params.push(discount_description?.trim() || null); sets.push(`discount_description = $${params.length}`); }

  const touchesTotals =
    line_items !== undefined ||
    discount_amount !== undefined ||
    discount_type !== undefined ||
    discount_value !== undefined;

  if (touchesTotals) {
    type LineItemRow = z.infer<typeof lineItemSchema>;
    // Always load the current row: we need existing line items when only the
    // discount changes, and existing discount metadata when only items change.
    const cur = await db.query(
      `SELECT line_items, discount_type, discount_value
         FROM cmc_sales WHERE id = $1 AND workspace_owner_id = $2`,
      [req.params.id, wreq.workspaceOwnerId],
    );
    if (cur.rows.length === 0) {
      res.status(404).json({ error: "Sale not found" });
      return;
    }
    const itemsToUse: LineItemRow[] = line_items ?? (cur.rows[0].line_items as LineItemRow[]);
    const shelfSubtotal = itemsToUse
      .filter((li) => li.item_type === "shelf")
      .reduce((s, li) => s + li.unit_price * li.qty, 0);
    const customSubtotal = itemsToUse
      .filter((li) => li.item_type === "custom")
      .reduce((s, li) => s + li.unit_price * li.qty, 0);
    const subtotal = shelfSubtotal + customSubtotal;

    // Resolve effective discount metadata: request overrides stored values;
    // discount_type: null explicitly clears the total-level discount.
    const storedType = cur.rows[0].discount_type as "percent" | "amount" | null;
    const storedValue = cur.rows[0].discount_value !== null ? parseFloat(cur.rows[0].discount_value as string) : null;
    const effType = discount_type !== undefined ? discount_type : storedType;
    const effValue = discount_value !== undefined ? discount_value : storedValue;

    let discAmt: number;
    let total: number;
    if (effType) {
      // Total-level discount: recompute against the COMBINED subtotal.
      if (effValue === null || effValue === undefined) {
        res.status(422).json({ error: "discount_value is required when discount_type is set" });
        return;
      }
      if (effType === "percent") {
        if (effValue > 100) {
          res.status(422).json({ error: "Percentage discount cannot exceed 100%" });
          return;
        }
        discAmt = Math.round(subtotal * effValue) / 100;
      } else {
        if (effValue > subtotal) {
          res.status(422).json({ error: "Discount cannot exceed the sale subtotal", subtotal });
          return;
        }
        discAmt = effValue;
      }
      total = Math.max(0, subtotal - discAmt);
      params.push(effType); sets.push(`discount_type = $${params.length}`);
      params.push(effValue.toFixed(4)); sets.push(`discount_value = $${params.length}`);
    } else {
      // Legacy path: amount-only discount against the shelf subtotal.
      const discToUse = discount_amount !== undefined ? discount_amount : 0;
      if (discToUse > shelfSubtotal) {
        res.status(422).json({ error: "Discount cannot exceed the shelf items subtotal", shelf_subtotal: shelfSubtotal });
        return;
      }
      discAmt = discToUse;
      total = Math.max(0, shelfSubtotal - discAmt) + customSubtotal;
      if (discount_type === null) {
        sets.push(`discount_type = NULL`, `discount_value = NULL`);
      }
    }

    if (line_items !== undefined) {
      params.push(JSON.stringify(itemsToUse)); sets.push(`line_items = $${params.length}`);
      params.push(subtotal.toFixed(4)); sets.push(`subtotal = $${params.length}`);
    }
    params.push(discAmt.toFixed(4)); sets.push(`discount_amount = $${params.length}`);
    params.push(total.toFixed(4)); sets.push(`total = $${params.length}`);
  }

  const result = await db.query(
    `UPDATE cmc_sales SET ${sets.join(", ")}
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING *`,
    params,
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }
  res.json({ sale: result.rows[0] });
});

router.delete("/cmc-pos/sales/:id", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!hasSub(wreq, "cmc_pos.edit")) {
    res.status(403).json({ error: "Requires cmc_pos.edit permission" });
    return;
  }
  const result = await db.query(
    `DELETE FROM cmc_sales WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Sale not found" });
    return;
  }
  res.json({ ok: true });
});

router.post("/cmc-pos/sales/:id/void", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!hasSub(wreq, "cmc_pos.refund")) {
    res.status(403).json({ error: "Requires cmc_pos.refund permission" });
    return;
  }
  const result = await db.query(
    `UPDATE cmc_sales SET status = 'voided', updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND status = 'paid'
      RETURNING *`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Sale not found or cannot be voided" });
    return;
  }
  res.json({ sale: result.rows[0] });
});

router.post("/cmc-pos/sales/:id/refund", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!hasSub(wreq, "cmc_pos.refund")) {
    res.status(403).json({ error: "Requires cmc_pos.refund permission" });
    return;
  }
  const result = await db.query(
    `UPDATE cmc_sales SET status = 'refunded', updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND status = 'paid'
      RETURNING *`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Sale not found or cannot be refunded" });
    return;
  }
  res.json({ sale: result.rows[0] });
});

// ---------------------------------------------------------------------------
// Requests — Workflow 2
// ---------------------------------------------------------------------------

const REQUEST_TRANSITIONS: Record<string, { allowed: string[]; sub: string }> = {
  submit: { allowed: ["draft"], sub: "cmc_pos.create_request" },
  accept: { allowed: ["submitted"], sub: "cmc_pos.accept_request" },
  dispatch: { allowed: ["submitted", "accepted"], sub: "cmc_pos.dispatch_request" },
  receive: { allowed: ["dispatched"], sub: "cmc_pos.receive_request" },
  cancel: { allowed: ["draft", "submitted", "accepted"], sub: "cmc_pos.create_request" },
};

const createRequestSchema = z.object({
  destination_location_id: z.number().int().optional().nullable(),
  source_location_id: z.number().int().optional().nullable(),
  purpose: z.string().optional().default("for_customer"),
  priority: z.string().optional().default("standard"),
  needed_by: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  customer_contact_id: z.string().optional().nullable(),
  line_items: z.array(
    z.object({
      product_id: z.number().int().optional().nullable(),
      name: z.string().optional().nullable(),
      source_location_id: z.number().int().optional().nullable(),
      requested_qty: z.number().int().min(1).default(1),
      unit_price: z.number().min(0).optional().nullable(),
      notes: z.string().optional().nullable(),
      image_url: z.string().optional().nullable(),
      description: z.string().optional().nullable(),
    }),
  ).min(1),
});

router.post("/cmc-pos/requests", async (req, res) => {
  // Request creation matches the /cmc-pos/request route guard: any base CMC
  // access may create a request (cmc_pos.create_request stays sufficient but
  // is no longer required).
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const parsed = createRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request data", details: parsed.error.issues });
    return;
  }
  const { destination_location_id, source_location_id, purpose, priority, needed_by, notes, customer_contact_id, line_items } = parsed.data;
  const uid = actorId(req);

  const reqResult = await db.query(
    `INSERT INTO cmc_requests
       (workspace_owner_id, destination_location_id, source_location_id, purpose, priority, needed_by, notes, customer_contact_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [wreq.workspaceOwnerId, destination_location_id ?? null, source_location_id ?? null, purpose, priority, needed_by ?? null, notes ?? null, customer_contact_id ?? null, uid],
  );
  const requestId = reqResult.rows[0].id;

  // Inherit request-level source_location_id onto each line item when not set per-item
  for (const li of line_items) {
    const liSourceId = li.source_location_id ?? source_location_id ?? null;
    await db.query(
      `INSERT INTO cmc_request_line_items
         (request_id, product_id, name, source_location_id, requested_qty, unit_price, notes, image_url, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [requestId, li.product_id ?? null, li.name ?? null, liSourceId, li.requested_qty, li.unit_price ?? null, li.notes ?? null, li.image_url ?? null, li.description ?? null],
    );
  }

  await db.query(
    `INSERT INTO cmc_request_events (request_id, actor_user_id, from_status, to_status) VALUES ($1, $2, $3, $4)`,
    [requestId, uid, null, "draft"],
  );

  res.status(201).json({ request: reqResult.rows[0] });
});

// Metrics — counts for the summary cards on the list page
router.get("/cmc-pos/requests/metrics", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status NOT IN ('cancelled','received')) AS open,
       COUNT(*) FILTER (WHERE priority = 'urgent' AND status NOT IN ('cancelled','received')) AS urgent,
       COUNT(*) FILTER (WHERE status = 'submitted') AS awaiting_approval,
       COUNT(*) FILTER (WHERE status = 'dispatched' AND updated_at::date = CURRENT_DATE) AS dispatched_today
     FROM cmc_requests
     WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  const row = result.rows[0];
  res.json({
    open: Number(row.open),
    urgent: Number(row.urgent),
    awaiting_approval: Number(row.awaiting_approval),
    dispatched_today: Number(row.dispatched_today),
  });
});

router.get("/cmc-pos/requests", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const status = req.query.status as string | undefined;
  const tab = req.query.tab as string | undefined; // all | needs_attention | drafts | completed
  const locationId = req.query.location_id ? parseInt(req.query.location_id as string) : null;
  const sourceLocationId = req.query.source_location_id ? parseInt(req.query.source_location_id as string) : null;
  const priority = req.query.priority as string | undefined;
  const q = req.query.q as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const conditions: string[] = ["r.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (status) { params.push(status); conditions.push(`r.status = $${params.length}`); }
  if (priority) { params.push(priority); conditions.push(`r.priority = $${params.length}`); }
  if (locationId) { params.push(locationId); conditions.push(`r.destination_location_id = $${params.length}`); }
  if (sourceLocationId) { params.push(sourceLocationId); conditions.push(`r.source_location_id = $${params.length}`); }
  if (q) { params.push(`%${q}%`); conditions.push(`(dl.name ILIKE $${params.length} OR sl.name ILIKE $${params.length})`); }

  // Tab-based status filters
  if (tab === "needs_attention") {
    conditions.push(`(r.status = 'submitted' OR (r.priority = 'urgent' AND r.status NOT IN ('cancelled','received')))`);
  } else if (tab === "drafts") {
    conditions.push(`r.status = 'draft'`);
  } else if (tab === "completed") {
    conditions.push(`r.status IN ('received', 'cancelled')`);
  } else if (!status) {
    // "all" tab: exclude nothing
  }

  const where = conditions.join(" AND ");

  // Count query for pagination and tab badges
  const countResult = await db.query(
    `SELECT COUNT(*) AS total
       FROM cmc_requests r
       LEFT JOIN locations dl ON dl.id = r.destination_location_id
       LEFT JOIN locations sl ON sl.id = r.source_location_id
      WHERE ${where}`,
    params,
  );

  params.push(limit);
  params.push(offset);
  const result = await db.query(
    `SELECT r.*,
            dl.name AS destination_location_name,
            sl.name AS source_location_name,
            wm.member_email AS requested_by_email,
            (SELECT COUNT(*) FROM cmc_request_line_items li WHERE li.request_id = r.id) AS item_count,
            (SELECT COALESCE(SUM(li.requested_qty), 0) FROM cmc_request_line_items li WHERE li.request_id = r.id) AS total_units,
            (SELECT json_agg(li ORDER BY li.id) FROM cmc_request_line_items li WHERE li.request_id = r.id) AS line_items
       FROM cmc_requests r
       LEFT JOIN locations dl ON dl.id = r.destination_location_id
       LEFT JOIN locations sl ON sl.id = r.source_location_id
       LEFT JOIN workspace_members wm ON wm.member_user_id = r.created_by_user_id AND wm.workspace_owner_id = r.workspace_owner_id
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ requests: result.rows, total: Number(countResult.rows[0].total), limit, offset });
});

router.get("/cmc-pos/requests/:id", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const result = await db.query(
    `SELECT r.*, l.name AS destination_location_name,
            wm.member_email AS requested_by_email,
            r.tookan_job_id, r.tookan_task_id,
            (SELECT json_agg(li ORDER BY li.id) FROM cmc_request_line_items li WHERE li.request_id = r.id) AS line_items,
            (SELECT json_agg(e ORDER BY e.id) FROM cmc_request_events e WHERE e.request_id = r.id) AS events
       FROM cmc_requests r
       LEFT JOIN locations l ON l.id = r.destination_location_id
       LEFT JOIN workspace_members wm ON wm.member_user_id = r.created_by_user_id AND wm.workspace_owner_id = r.workspace_owner_id
      WHERE r.id = $1 AND r.workspace_owner_id = $2`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  res.json({ request: result.rows[0] });
});

async function transitionRequest(
  req: Request,
  res: Response,
  action: keyof typeof REQUEST_TRANSITIONS,
): Promise<void> {
  // Transitions match the request/location-request page guards: any base CMC
  // access may transition (the per-action cmc_pos.* keys stay sufficient but
  // are no longer required).
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const { allowed } = REQUEST_TRANSITIONS[action];
  const existing = await db.query(
    `SELECT id, status, source_location_id, destination_location_id FROM cmc_requests WHERE id = $1 AND workspace_owner_id = $2`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const current = existing.rows[0].status as string;
  if (!allowed.includes(current)) {
    res.status(409).json({ error: `Cannot ${action} a request in '${current}' status` });
    return;
  }

  // Branch requests dispatch as a source → destination Tookan route, so a
  // submission must carry both branches. Enforce this at the server boundary —
  // drafts saved without a source can still be submitted from the detail page
  // or the API directly, not just the New Request form.
  if (action === "submit") {
    if (!existing.rows[0].source_location_id) {
      res.status(400).json({
        error: "A source branch is required before submitting — edit the request and choose where the items should come from",
      });
      return;
    }
    if (!existing.rows[0].destination_location_id) {
      res.status(400).json({
        error: "A destination branch is required before submitting — edit the request and choose where the items should be delivered",
      });
      return;
    }
  }
  const toStatus = action === "cancel" ? "cancelled" : action === "submit" ? "submitted" : action === "accept" ? "accepted" : action === "dispatch" ? "dispatched" : "received";
  const uid = actorId(req);
  const notes = req.body?.notes ?? null;
  const requestId = req.params.id;
  const wsId = wreq.workspaceOwnerId;

  // ── Receive: run atomically with a compare-and-set transaction ──────────────
  // This prevents a concurrent receive from double-adding stock. The conditional
  // UPDATE (AND status = $4) fails if another request already advanced the status;
  // idempotency keys on stock rows guard against any remaining replay risk.
  if (action === "receive") {
    const client = await db.connect();
    let updatedRequest: Record<string, unknown>;
    try {
      updatedRequest = await withTransaction(client, async () => {
        // Compare-and-set: only advance if the row is still in the expected status.
        const updateResult = await client.query(
          `UPDATE cmc_requests SET status = $1, updated_at = now()
            WHERE id = $2 AND workspace_owner_id = $3 AND status = $4
            RETURNING *`,
          [toStatus, requestId, wsId, current],
        );
        if ((updateResult.rowCount ?? 0) === 0) {
          throw Object.assign(
            new Error(`Cannot receive a request that is no longer in '${current}' status`),
            { code: "STATUS_CONFLICT" },
          );
        }
        const updatedRow = updateResult.rows[0] as Record<string, unknown>;

        await client.query(
          `INSERT INTO cmc_request_events (request_id, actor_user_id, from_status, to_status, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [requestId, uid, current, toStatus, notes],
        );

        // ── Stock additions (atomic with status change) ─────────────────────
        // Idempotency key (cmc_receive:{requestId}:li:{id}) ensures each line is
        // counted exactly once even if the transaction is replayed.
        const destLocationId = updatedRow.destination_location_id as number | null;
        if (destLocationId) {
          const lineItems = await client.query<{ id: number; product_id: number | null; requested_qty: number }>(
            `SELECT id, product_id, requested_qty FROM cmc_request_line_items WHERE request_id = $1`,
            [requestId],
          );
          for (const li of lineItems.rows) {
            if (!li.product_id) continue;
            await client.query(
              `INSERT INTO base_item_stock_adjustments
                 (workspace_owner_id, base_item_id, location_id, quantity_change, reason,
                   movement_type, note, stock_after, created_by_user_id, product_id,
                   idempotency_key, ledger_scope)
                VALUES ($1, NULL, $2, $3, 'cmc_request_received', 'cmc_request_received', $4, 0, $5, $6, $7,
                        'cmc_product_compat')
                ON CONFLICT (workspace_owner_id, idempotency_key)
                  WHERE idempotency_key IS NOT NULL DO NOTHING`,
              [wsId, destLocationId, li.requested_qty, `cmc_request:${requestId}`,
               uid, li.product_id, `cmc_receive:${requestId}:li:${li.id}`],
            );
          }
        }

        return updatedRow;
      });
    } catch (err) {
      client.release();
      const e = err as { code?: string; message?: string };
      if (e.code === "STATUS_CONFLICT") {
        res.status(409).json({ error: e.message });
        return;
      }
      throw err;
    }
    client.release();
    res.json({ request: updatedRequest });
    return;
  }

  // ── All other transitions: compare-and-set to avoid TOCTOU races ───────────
  const result = await db.query(
    `UPDATE cmc_requests SET status = $1, updated_at = now()
      WHERE id = $2 AND workspace_owner_id = $3 AND status = $4
      RETURNING *`,
    [toStatus, requestId, wsId, current],
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(409).json({ error: `Cannot ${action} a request that is no longer in '${current}' status` });
    return;
  }
  await db.query(
    `INSERT INTO cmc_request_events (request_id, actor_user_id, from_status, to_status, notes) VALUES ($1, $2, $3, $4, $5)`,
    [requestId, uid, current, toStatus, notes],
  );

  // Dispatch a Tookan delivery task when the request is submitted. Await the
  // result so pre-flight validation errors (e.g. a branch missing an address)
  // reach the dashboard as an actionable message instead of being lost to a
  // fire-and-forget call. The request still transitions to 'submitted' and
  // stays retryable — createTookanStockRequestTask releases its sentinel on
  // failure, so the Retry button on the detail page can re-attempt.
  if (toStatus === "submitted" && isTookanEnabled()) {
    const tookanResult = await createTookanStockRequestTask(String(requestId), wsId);
    if (tookanResult && tookanResult.ok === false) {
      res.json({ request: result.rows[0], tookan_error: tookanResult.error });
      return;
    }
  }
  res.json({ request: result.rows[0] });
}

router.post("/cmc-pos/requests/:id/submit", (req, res) => transitionRequest(req, res, "submit"));
router.post("/cmc-pos/requests/:id/accept", (req, res) => transitionRequest(req, res, "accept"));
router.post("/cmc-pos/requests/:id/dispatch", (req, res) => transitionRequest(req, res, "dispatch"));
router.post("/cmc-pos/requests/:id/receive", (req, res) => transitionRequest(req, res, "receive"));
router.post("/cmc-pos/requests/:id/cancel", (req, res) => transitionRequest(req, res, "cancel"));

// DELETE /api/cmc-pos/requests/:id — permanently remove a draft or cancelled request
router.delete("/cmc-pos/requests/:id", async (req, res) => {
  // Deletion is shown on pages gated only by base CMC access (e.g. the
  // location-requests page), so base access suffices; cmc_pos.delete_request
  // stays sufficient but is no longer required.
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const { id } = req.params;
  const wsId = wreq.workspaceOwnerId;

  // Verify the request exists and belongs to this workspace (ownership check)
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM cmc_requests WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wsId],
  );
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Request not found" });
    return;
  }

  // Atomically delete only if status is still draft, submitted, accepted, cancelled, or received.
  // Dispatched requests are in-transit and cannot be deleted.
  // A single DELETE ... WHERE ... AND status IN (...) RETURNING id avoids the
  // TOCTOU race where a concurrent status change could occur between
  // our read and the delete.
  const deleted = await db.query<{ id: string }>(
    `DELETE FROM cmc_requests
      WHERE id = $1 AND workspace_owner_id = $2 AND status IN ('draft','submitted','accepted','cancelled','received')
      RETURNING id`,
    [id, wsId],
  );
  if (deleted.rows.length === 0) {
    res.status(409).json({ error: "Only draft, submitted, accepted, cancelled, or delivered requests can be deleted" });
    return;
  }
  res.json({ ok: true });
});

// Active statuses that may receive a Tookan retry (must mirror UI visibility logic)
export const TOOKAN_RETRY_ELIGIBLE_STATUSES = ["submitted", "accepted", "dispatched"];

/** Pure helper — exported for unit tests. */
export function classifyRetryRequest(row: {
  status: string;
  tookan_job_id: string | null;
}): "ineligible_status" | "job_exists" | "pending" | "retryable" {
  if (!TOOKAN_RETRY_ELIGIBLE_STATUSES.includes(row.status)) return "ineligible_status";
  if (row.tookan_job_id !== null && row.tookan_job_id !== "pending") return "job_exists";
  if (row.tookan_job_id === "pending") return "pending";
  return "retryable"; // tookan_job_id IS NULL
}

router.post("/cmc-pos/requests/:id/retry-tookan", async (req, res) => {
  // Retry is offered on the request detail page (base-CMC gated), so base
  // access suffices; cmc_pos.accept_request stays sufficient but not required.
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;

  if (!isTookanEnabled()) {
    res.status(400).json({ ok: false, error: "Tookan integration is not enabled" });
    return;
  }

  const existing = await db.query<{ id: string; status: string; tookan_job_id: string | null }>(
    `SELECT id, status, tookan_job_id FROM cmc_requests WHERE id = $1 AND workspace_owner_id = $2`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (existing.rows.length === 0) {
    res.status(404).json({ ok: false, error: "Request not found" });
    return;
  }
  const row = existing.rows[0];

  const classification = classifyRetryRequest(row);

  if (classification === "ineligible_status") {
    res.status(409).json({
      ok: false,
      error: `Tookan retry is not allowed for a request in '${row.status}' status`,
    });
    return;
  }

  if (classification === "job_exists") {
    res.status(409).json({ ok: false, error: "Tookan task already created for this request" });
    return;
  }

  if (classification === "pending") {
    // 'pending' means the slot is (or was) actively claimed — either the original call
    // is still in flight, or it crashed after calling Tookan but before persisting the
    // job ID (in which case a Tookan task may already exist).  Clearing the sentinel
    // and retrying risks creating a duplicate courier task.  Return an actionable error
    // so the operator knows to wait or escalate; safe recovery for stuck claims is a
    // separate maintenance concern (see follow-up task).
    res.status(409).json({
      ok: false,
      tookan_pending: true,
      error: "Tookan task creation is in progress or requires manual resolution — refresh to check, or contact support if this persists",
    });
    return;
  }

  // tookan_job_id IS NULL — the original call definitively failed and released the sentinel.
  // createTookanStockRequestTask atomically claims the slot with WHERE tookan_job_id IS NULL,
  // serializing concurrent callers at the DB level — only one wins the claim.
  const result = await createTookanStockRequestTask(req.params.id as string, wreq.workspaceOwnerId);

  if (!result.ok) {
    res.status(502).json({ ok: false, error: result.error });
    return;
  }

  res.json({ ok: true, tookan_job_id: result.jobId, tookan_task_id: result.taskId });
});
// ---------------------------------------------------------------------------
// Delivery Orders — Workflow 3 (thin wrapper over createManualOrder)
// ---------------------------------------------------------------------------

const deliveryLineItemSchema = z.object({
  product_id: z.number().int().optional().nullable(),
  name: z.string().min(1),
  quantity: z.number().int().min(1).default(1),
  unit_price: z.number().min(0).optional().nullable(),
  image_url: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

const deliveryOrderSchema = z.object({
  recipient_name: z.string().min(1),
  recipient_phone: z.string().min(1),
  recipient_contact_id: z.string().nullish(),
  recipient_address: z.string().nullish(),
  recipient_email: z.email().nullish().or(z.literal("").transform(() => null)),
  currency: z.string().default("USD"),
  payment_method: z.string().default("cash"),
  notes: z.string().nullish(),
  line_items: z.array(deliveryLineItemSchema).min(1),
  customer_name: z.string().nullish(),
  customer_email: z.email().nullish().or(z.literal("").transform(() => null)),
  card_message: z.string().nullish(),
  card_from: z.string().nullish(),
  card_to: z.string().nullish(),
});

router.post("/cmc-pos/delivery-orders", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const uid = actorId(req);

  const parsed = deliveryOrderSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  try {
    const cmcOrderNumber = await generateCmcOrderNumber(wreq.workspaceOwnerId);

    const recipientContactId: string | null =
      typeof body.recipient_contact_id === "string" && body.recipient_contact_id.trim()
        ? body.recipient_contact_id.trim()
        : null;

    const totalAmount = body.line_items.reduce(
      (sum, li) => sum + (li.unit_price ?? 0) * li.quantity,
      0,
    );

    const result = await createManualOrder({
      workspaceOwnerId: wreq.workspaceOwnerId,
      actorUserId: uid,
      displayOrderNumber: cmcOrderNumber,
      data: {
        source: "cmc-pos",
        totals: { total: totalAmount, currency: body.currency },
        payment: { method: body.payment_method, status: "pending", currency: body.currency },
        delivery_address: body.recipient_address ? { address: body.recipient_address } : null,
        notes: body.notes ? { internal_note: body.notes } : null,
        line_items: body.line_items.map((li) => ({
          product_id: li.product_id ?? undefined,
          name: li.name,
          quantity: li.quantity,
          unit_price: li.unit_price ?? undefined,
          image_url: li.image_url ?? undefined,
          custom_input: li.description ?? undefined,
          is_custom_item: !li.product_id ? true : undefined,
        })),
        card_message: body.card_message ?? null,
        card_from: body.card_from ?? null,
        card_to: body.card_to ?? null,
        customer:
          body.customer_name || body.customer_email
            ? { first_name: body.customer_name ?? null, email: body.customer_email ?? null }
            : null,
        recipient: {
          contact_id: recipientContactId,
          first_name: body.recipient_name,
          phone: body.recipient_phone,
          email: body.recipient_email ?? null,
        },
      },
    });
    res.status(201).json({ order: result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// ---------------------------------------------------------------------------
// Location Requests — incoming requests from the perspective of source location
// ---------------------------------------------------------------------------

router.get("/cmc-pos/location-requests", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;

  const locationId = req.query.locationId ? parseInt(req.query.locationId as string) : null;
  if (!locationId || isNaN(locationId)) {
    res.status(400).json({ error: "locationId is required" });
    return;
  }

  const statusBucket = req.query.status as string | undefined;
  let statusList: string[];
  if (statusBucket === "completed") {
    statusList = ["dispatched", "received", "cancelled"];
  } else if (statusBucket === "accepted") {
    statusList = ["accepted"];
  } else {
    statusList = ["submitted"];
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const params: unknown[] = [wreq.workspaceOwnerId, locationId];
  const statusPlaceholders = statusList.map((_, i) => `$${i + 3}`).join(", ");
  statusList.forEach((s) => params.push(s));
  params.push(limit);
  params.push(offset);

  const result = await db.query(
    `SELECT DISTINCT ON (r.id, r.created_at)
            r.id,
            r.status,
            r.priority,
            r.purpose,
            r.needed_by,
            r.notes,
            r.created_at,
            r.updated_at,
            dl.name AS destination_location_name,
            (
              SELECT json_agg(
                json_build_object(
                  'id', li.id,
                  'product_id', li.product_id,
                  'name', li.name,
                  'product_name', p.name,
                  'source_location_id', li.source_location_id,
                  'requested_qty', li.requested_qty,
                  'accepted_qty', li.accepted_qty,
                  'unit_price', li.unit_price,
                  'notes', li.notes
                ) ORDER BY li.id
              )
              FROM cmc_request_line_items li
              LEFT JOIN products p ON p.id = li.product_id
              WHERE li.request_id = r.id
            ) AS line_items,
            (
              SELECT MAX(e.created_at)
              FROM cmc_request_events e
              WHERE e.request_id = r.id
            ) AS last_event_at
       FROM cmc_requests r
       JOIN cmc_request_line_items rli ON rli.request_id = r.id
                                      AND rli.source_location_id = $2
       LEFT JOIN locations dl ON dl.id = r.destination_location_id
      WHERE r.workspace_owner_id = $1
        AND r.status IN (${statusPlaceholders})
      ORDER BY r.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const countParams: unknown[] = [wreq.workspaceOwnerId, locationId];
  statusList.forEach((s) => countParams.push(s));
  const cStatusPlaceholders = statusList.map((_, i) => `$${i + 3}`).join(", ");
  const countResult = await db.query(
    `SELECT COUNT(DISTINCT r.id) AS total
       FROM cmc_requests r
       JOIN cmc_request_line_items rli ON rli.request_id = r.id
                                      AND rli.source_location_id = $2
      WHERE r.workspace_owner_id = $1
        AND r.status IN (${cStatusPlaceholders})`,
    countParams,
  );

  res.json({
    requests: result.rows,
    total: parseInt(countResult.rows[0]?.total ?? "0"),
    limit,
    offset,
  });
});

// ---------------------------------------------------------------------------
// Metrics / Summary
// ---------------------------------------------------------------------------

router.get("/cmc-pos/metrics", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const locationId = req.query.location_id ? parseInt(req.query.location_id as string) : null;

  const conditions: string[] = ["workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];
  if (from) { params.push(from); conditions.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`created_at <= $${params.length}`); }
  if (locationId) { params.push(locationId); conditions.push(`location_id = $${params.length}`); }
  const where = conditions.join(" AND ");

  // Delivery orders: filter by workspace + source only (no location — CMC delivery
  // orders in the orders table do not carry a location_id at creation time).
  const deliveryConditions: string[] = [
    "workspace_owner_id = $1",
    "source = 'cmc-pos'",
    "status IN ('completed', 'accepted', 'dispatched', 'delivered')",
  ];
  const deliveryParams: unknown[] = [wreq.workspaceOwnerId];
  if (from) { deliveryParams.push(from); deliveryConditions.push(`created_at >= $${deliveryParams.length}`); }
  if (to) { deliveryParams.push(to); deliveryConditions.push(`created_at <= $${deliveryParams.length}`); }
  const deliveryWhere = deliveryConditions.join(" AND ");

  const [salesMetrics, requestMetrics, deliveryMetrics] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'paid') AS paid_count,
         COUNT(*) FILTER (WHERE status = 'refunded') AS refunded_count,
         COUNT(*) FILTER (WHERE status = 'voided') AS voided_count,
         SUM(total) FILTER (WHERE status = 'paid') AS gross_total,
         SUM(discount_amount) FILTER (WHERE status = 'paid') AS total_discounts,
         SUM(total) FILTER (WHERE status = 'paid' AND payment_method = 'cash') AS cash_total,
         COUNT(*) FILTER (WHERE status = 'paid' AND payment_method = 'cash') AS cash_count,
         COUNT(*) FILTER (WHERE status = 'paid' AND payment_method IS NULL) AS payment_issues,
         SUM(total) FILTER (WHERE status = 'refunded' AND payment_method = 'cash') AS cash_refunds_total,
         COUNT(*) FILTER (WHERE status = 'refunded' AND payment_method = 'cash') AS cash_refunds_count
       FROM cmc_sales WHERE ${where}`,
      params,
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'draft') AS draft_count,
         COUNT(*) FILTER (WHERE status = 'submitted') AS submitted_count,
         COUNT(*) FILTER (WHERE status = 'accepted') AS accepted_count,
         COUNT(*) FILTER (WHERE status = 'dispatched') AS dispatched_count,
         COUNT(*) FILTER (WHERE status = 'received') AS received_count,
         COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count
       FROM cmc_requests WHERE ${where.replace(/location_id/g, "destination_location_id")}`,
      params,
    ),
    db.query(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM((totals->>'total')::numeric), 0) AS revenue
       FROM orders WHERE ${deliveryWhere}`,
      deliveryParams,
    ),
  ]);

  res.json({
    sales: salesMetrics.rows[0],
    requests: requestMetrics.rows[0],
    delivery_orders: deliveryMetrics.rows[0],
  });
});

// ---------------------------------------------------------------------------
// Monthly Sales — aggregated monthly view with settlement status
// ---------------------------------------------------------------------------

const MONTH_RE = /^\d{4}-\d{2}$/;

function requireMonthlySalesAccess(req: Request, res: Response): WorkspaceRequest | null {
  const wreq = workspace(req);
  if (!hasSub(wreq, "cmc_pos.monthly_sales")) {
    res.status(403).json({ error: "Requires cmc_pos.monthly_sales permission" });
    return null;
  }
  return wreq;
}

router.get("/cmc-pos/monthly-sales", async (req, res) => {
  const wreq = requireMonthlySalesAccess(req, res);
  if (!wreq) return;

  const mode = (req.query.mode as string | undefined) ?? "single";
  if (!["single", "range", "all_time"].includes(mode)) {
    res.status(400).json({ error: "mode must be single|range|all_time" });
    return;
  }

  const month = req.query.month as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  try {
    resolveMonthBounds(mode as MonthlySalesMode, month, from, to);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid params" });
    return;
  }

  try {
    const result = await computeMonthlySales(wreq.workspaceOwnerId, mode as MonthlySalesMode, month, from, to);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "CMC monthly-sales query failed");
    res.status(500).json({ error: "Failed to compute monthly sales" });
  }
});

router.get("/cmc-pos/monthly-sales/pdf", async (req, res) => {
  const wreq = requireMonthlySalesAccess(req, res);
  if (!wreq) return;

  const mode = (req.query.mode as string | undefined) ?? "single";
  if (!["single", "range", "all_time"].includes(mode)) {
    res.status(400).json({ error: "mode must be single|range|all_time" });
    return;
  }

  const month = req.query.month as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  let bounds: { fromMonth: string | null; toMonth: string | null };
  try {
    bounds = resolveMonthBounds(mode as MonthlySalesMode, month, from, to);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid params" });
    return;
  }

  try {
    const result = await computeMonthlySales(wreq.workspaceOwnerId, mode as MonthlySalesMode, month, from, to);

    let pdfBuffer: Buffer;
    let filename: string;

    if (mode === "single" && month) {
      // Monthly commission statement — A4 portrait
      pdfBuffer = await generateCmcCommissionStatementPdf(month, result);
      filename = `cmc-commission-statement-${month}.pdf`;
    } else {
      // All-time / range reconciliation summary — A4 landscape
      const todayStr = new Date().toISOString().slice(0, 10);
      pdfBuffer = await generateCmcCommissionSummaryPdf(result);
      filename = `cmc-commission-summary-through-${todayStr}.pdf`;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    req.log.error({ err }, "CMC monthly-sales PDF generation failed");
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// POST /cmc-pos/monthly-sales/:month/payment — record a payment with full details
const recordPaymentSchema = z.object({
  paidAt: z.string().optional(),
  amount: z.number().positive(),
  paymentMethod: z.enum(["bank_transfer", "cash", "cheque", "other"]),
  referenceNumber: z.string().optional(),
  note: z.string().optional(),
});

router.post("/cmc-pos/monthly-sales/:month/payment", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only workspace owners can record payments" });
    return;
  }
  const monthParam = req.params.month;
  if (!MONTH_RE.test(monthParam)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  const body = recordPaymentSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid payment data", details: body.error.issues });
    return;
  }
  const { paidAt, amount, paymentMethod, referenceNumber, note } = body.data;
  const uid = actorId(req);
  const paidAtDate = paidAt ? new Date(paidAt) : new Date();

  const existing = await db.query(
    `SELECT status FROM cmc_monthly_settlements WHERE workspace_owner_id = $1 AND settlement_month = $2`,
    [wreq.workspaceOwnerId, monthParam],
  );
  const fromStatus = existing.rows.length > 0 ? (existing.rows[0].status as string) : "unpaid";

  const result = await db.query(
    `INSERT INTO cmc_monthly_settlements
       (workspace_owner_id, settlement_month, status, paid_at, paid_by_user_id,
        payment_method, reference_number, payment_note, payment_amount,
        updated_at, updated_by_user_id)
     VALUES ($1, $2, 'paid', $3, $4, $5, $6, $7, $8, now(), $4)
     ON CONFLICT (workspace_owner_id, settlement_month)
     DO UPDATE SET
       status = 'paid',
       paid_at = EXCLUDED.paid_at,
       paid_by_user_id = EXCLUDED.paid_by_user_id,
       payment_method = EXCLUDED.payment_method,
       reference_number = EXCLUDED.reference_number,
       payment_note = EXCLUDED.payment_note,
       payment_amount = EXCLUDED.payment_amount,
       updated_at = now(),
       updated_by_user_id = EXCLUDED.updated_by_user_id
     RETURNING *`,
    [
      wreq.workspaceOwnerId,
      monthParam,
      paidAtDate,
      uid,
      paymentMethod,
      referenceNumber ?? null,
      note ?? null,
      amount,
    ],
  );

  await db.query(
    `INSERT INTO cmc_monthly_settlement_audit
       (workspace_owner_id, settlement_month, from_status, to_status, actor_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [wreq.workspaceOwnerId, monthParam, fromStatus, "paid", uid],
  );

  res.json({ settlement: result.rows[0] });
});

router.patch("/cmc-pos/monthly-sales/:month/status", async (req, res) => {
  const wreq = workspace(req);

  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only workspace owners can update payment status" });
    return;
  }

  const monthParam = req.params.month;
  if (!MONTH_RE.test(monthParam)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }

  const body = z.object({ status: z.enum(["paid", "unpaid"]) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "status must be 'paid' or 'unpaid'" });
    return;
  }

  const newStatus = body.data.status;
  const uid = actorId(req);

  const existing = await db.query(
    `SELECT status FROM cmc_monthly_settlements WHERE workspace_owner_id = $1 AND settlement_month = $2`,
    [wreq.workspaceOwnerId, monthParam],
  );
  const fromStatus = existing.rows.length > 0 ? (existing.rows[0].status as string) : "unpaid";

  const result = await db.query(
    `INSERT INTO cmc_monthly_settlements
       (workspace_owner_id, settlement_month, status, paid_at, paid_by_user_id, updated_at, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (workspace_owner_id, settlement_month)
     DO UPDATE SET
       status = EXCLUDED.status,
       paid_at = CASE WHEN EXCLUDED.status = 'paid' THEN now() ELSE NULL END,
       paid_by_user_id = CASE WHEN EXCLUDED.status = 'paid' THEN $5 ELSE NULL END,
       updated_at = now(),
       updated_by_user_id = $6
     RETURNING *`,
    [
      wreq.workspaceOwnerId,
      monthParam,
      newStatus,
      newStatus === "paid" ? new Date() : null,
      newStatus === "paid" ? uid : null,
      uid,
    ],
  );

  await db.query(
    `INSERT INTO cmc_monthly_settlement_audit
       (workspace_owner_id, settlement_month, from_status, to_status, actor_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [wreq.workspaceOwnerId, monthParam, fromStatus, newStatus, uid],
  );

  res.json({ settlement: result.rows[0] });
});

// ---------------------------------------------------------------------------
// Audit — read-only fulfilment-date view
// ---------------------------------------------------------------------------

const AUDIT_PAGE_SIZE = 20;
const AUDIT_MAX_EXPORT = 10000;
const CMC_VAT_DIVISOR = 1.11;

function auditComputeNet(gross: number): number {
  return gross / CMC_VAT_DIVISOR;
}

function auditComputeVat(gross: number): number {
  return gross - auditComputeNet(gross);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidAuditRange(from: string | undefined, to: string | undefined): boolean {
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return false;
  const isRealDate = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.toISOString().slice(0, 10) === value;
  };
  return isRealDate(from) && isRealDate(to);
}

function formatAuditTime(value: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CMC_REPORTING_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

router.get("/cmc-pos/audit", async (req, res) => {
  const wreq = requireCmcAudit(req, res);
  if (!wreq) return;

  const fromParam = req.query.from as string | undefined;
  const toParam = req.query.to as string | undefined;
  if (!isValidAuditRange(fromParam, toParam)) {
    res.status(400).json({ error: "from and to must be a valid chronological range (YYYY-MM-DD)" });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || AUDIT_PAGE_SIZE, 200);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  const paymentMethodParam = (req.query.payment_method as string | undefined) || null;
  const searchParam = (req.query.search as string | undefined) || null;

  // Build optional extra clauses
  const extraParams: unknown[] = [wreq.workspaceOwnerId, fromParam, toParam];
  let extraWhere = "";
  if (paymentMethodParam) {
    extraParams.push(paymentMethodParam);
    extraWhere += ` AND payment_method = $${extraParams.length}`;
  }
  if (searchParam) {
    extraParams.push(`%${searchParam.replace(/-/g, "").toUpperCase()}%`);
    extraWhere += ` AND UPPER(REPLACE(id::text, '-', '')) LIKE $${extraParams.length}`;
  }

  const [rowsResult, totalsResult] = await Promise.all([
    db.query(
      `SELECT id, fulfilment_date, created_at, line_items, total, payment_method,
              COALESCE(fulfilment_date, (created_at AT TIME ZONE '${CMC_REPORTING_TIMEZONE}')::date)::text AS reporting_date
         FROM cmc_sales
        WHERE workspace_owner_id = $1
          AND status = 'paid'
          AND workflow_type IN ('shelf_sale', 'order')
          AND COALESCE(fulfilment_date, (created_at AT TIME ZONE '${CMC_REPORTING_TIMEZONE}')::date) BETWEEN $2 AND $3
          ${extraWhere}
        ORDER BY created_at ASC
        LIMIT $${extraParams.length + 1} OFFSET $${extraParams.length + 2}`,
      [...extraParams, limit, offset],
    ),
    db.query(
      `SELECT COUNT(*) AS total_count, COALESCE(SUM(total), 0) AS gross_sum
         FROM cmc_sales
        WHERE workspace_owner_id = $1
          AND status = 'paid'
          AND workflow_type IN ('shelf_sale', 'order')
          AND COALESCE(fulfilment_date, (created_at AT TIME ZONE '${CMC_REPORTING_TIMEZONE}')::date) BETWEEN $2 AND $3
          ${extraWhere}`,
      extraParams,
    ),
  ]);

  const grossSum = parseFloat(totalsResult.rows[0].gross_sum ?? "0");
  const netSum = auditComputeNet(grossSum);
  const vatSum = auditComputeVat(grossSum);
  const totalCount = parseInt(totalsResult.rows[0].total_count ?? "0");

  res.json({
    sales: rowsResult.rows,
    totals: {
      gross: grossSum.toFixed(2),
      net: netSum.toFixed(2),
      vat: vatSum.toFixed(2),
    },
    total: totalCount,
    limit,
    offset,
  });
});

router.get("/cmc-pos/audit/export", async (req, res) => {
  const wreq = requireCmcAudit(req, res);
  if (!wreq) return;

  const fromParam = req.query.from as string | undefined;
  const toParam = req.query.to as string | undefined;
  if (!isValidAuditRange(fromParam, toParam)) {
    res.status(400).json({ error: "from and to must be a valid chronological range (YYYY-MM-DD)" });
    return;
  }

  const paymentMethodParam = (req.query.payment_method as string | undefined) || null;
  const searchParam = (req.query.search as string | undefined) || null;

  const exportParams: unknown[] = [wreq.workspaceOwnerId, fromParam, toParam];
  let exportWhere = "";
  if (paymentMethodParam) {
    exportParams.push(paymentMethodParam);
    exportWhere += ` AND payment_method = $${exportParams.length}`;
  }
  if (searchParam) {
    exportParams.push(`%${searchParam.replace(/-/g, "").toUpperCase()}%`);
    exportWhere += ` AND UPPER(REPLACE(id::text, '-', '')) LIKE $${exportParams.length}`;
  }

  const result = await db.query(
    `SELECT id, fulfilment_date, created_at, line_items, total, payment_method,
            COALESCE(fulfilment_date, (created_at AT TIME ZONE '${CMC_REPORTING_TIMEZONE}')::date)::text AS reporting_date
       FROM cmc_sales
      WHERE workspace_owner_id = $1
        AND status = 'paid'
        AND workflow_type IN ('shelf_sale', 'order')
        AND COALESCE(fulfilment_date, (created_at AT TIME ZONE '${CMC_REPORTING_TIMEZONE}')::date) BETWEEN $2 AND $3
        ${exportWhere}
      ORDER BY created_at ASC
      LIMIT $${exportParams.length + 1}`,
    [...exportParams, AUDIT_MAX_EXPORT],
  );

  function csvField(val: unknown): string {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  type AuditLineItem = { name?: string; image_url?: string | null };

  const header = [
    "Sale ID", "Reporting Date", `Reporting Time (${CMC_REPORTING_TIMEZONE})`,
    "Product Names", "Product Image URLs",
    "Net Amount", "VAT Amount", "Gross Amount",
    "Payment Method", "Currency",
  ];

  const rows = result.rows.map((s) => {
    const items: AuditLineItem[] = Array.isArray(s.line_items) ? (s.line_items as AuditLineItem[]) : [];
    const productNames = items.map((li) => li.name ?? "").filter(Boolean).join("; ");
    const productImages = items.map((li) => li.image_url ?? "").filter(Boolean).join("; ");
    const gross = parseFloat(s.total ?? "0");
    const net = auditComputeNet(gross);
    const vat = auditComputeVat(gross);
    const fulfilTime = s.created_at ? formatAuditTime(s.created_at as string) : "";
    return [
      csvField(s.id),
      csvField(s.reporting_date ?? ""),
      csvField(fulfilTime),
      csvField(productNames),
      csvField(productImages),
      csvField(net.toFixed(2)),
      csvField(vat.toFixed(2)),
      csvField(gross.toFixed(2)),
      csvField(s.payment_method ? s.payment_method.charAt(0).toUpperCase() + s.payment_method.slice(1).toLowerCase() : ""),
      csvField("USD"),
    ];
  });

  const csvLines = [header.join(","), ...rows.map((r) => r.join(","))];
  const csv = csvLines.join("\r\n");

  const rangeLabel = fromParam === toParam ? fromParam : `${fromParam}_${toParam}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="cmc-audit-${rangeLabel}.csv"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// CMC Cash Drawer — single-endpoint summary for the POS dashboard panel.
// Requires only cmc-pos permission (not the full cash-sessions scope).
// ---------------------------------------------------------------------------

import {
  sessionCurrencies,
  computeSessionCurrencySummary,
  type CashTransactionLite,
} from "../lib/cashDesk";

router.get("/cmc-pos/cash-drawer", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  // Read access is open to all CMC POS users — any workspace member with the
  // "cmc-pos" page key can see the current session status.
  // Write operations (transactions, adjustments, open/close) retain the
  // cmc_pos.cash_drawer sub-permission gate on their respective routes.

  const locationId = req.query.location_id ? parseInt(req.query.location_id as string) : null;
  const wsId = wreq.workspaceOwnerId;

  // Prefer the active CMC shift's linked session, even when a supervisor has
  // already finalized it. That lets the POS complete the shift-recovery flow
  // while keeping the prior session reconciliation read-only.
  const sessionParams: unknown[] = [wsId];
  let locationClause = "";
  if (locationId) {
    sessionParams.push(locationId);
    locationClause = `AND COALESCE(s.location_id, cs.location_id) = $${sessionParams.length}`;
  }

  const sessionResult = await db.query<{
    id: number;
    status: string;
    currency: string;
    secondary_currency: string | null;
    opening_cash: string;
    opening_cash_secondary: string | null;
    opened_at: string;
    closed_at: string | null;
    reconciliation: unknown;
    location_name: string | null;
    drawer_id: number;
    drawer_currency: string;
    drawer_secondary_currency: string | null;
    shift_currency: string | null;
  }>(
    `SELECT cs.id, cs.status, cs.currency, cs.secondary_currency,
            cs.opening_cash, cs.opening_cash_secondary, cs.opened_at, cs.closed_at,
            cs.reconciliation, cs.drawer_id,
            l.name AS location_name,
            d.currency AS drawer_currency,
            d.secondary_currency AS drawer_secondary_currency,
            s.currency AS shift_currency
       FROM cash_sessions cs
       JOIN cash_drawers d ON d.id = cs.drawer_id
        LEFT JOIN cmc_shifts s
          ON s.cash_session_id = cs.id
         AND s.workspace_owner_id = cs.workspace_owner_id
         AND s.status = 'open'
       LEFT JOIN locations l ON l.id = cs.location_id
       WHERE cs.workspace_owner_id = $1
         AND (cs.status = 'open' OR s.id IS NOT NULL)
         ${locationClause}
       ORDER BY (s.id IS NOT NULL) DESC, cs.opened_at DESC
      LIMIT 1`,
    sessionParams,
  );

  if (sessionResult.rowCount === 0) {
    // Return the most recent closed CMC session's closing_cash_kept so the
    // Start Shift panel can display the previous carry-forward balance.
    const drawerResult = locationId
      ? await db.query<{ currency: string; secondary_currency: string | null }>(
          `SELECT currency, secondary_currency
             FROM cash_drawers
            WHERE workspace_owner_id = $1 AND location_id = $2 AND is_active = true
            ORDER BY id ASC
            LIMIT 1`,
          [wsId, locationId],
        )
      : { rows: [] as { currency: string; secondary_currency: string | null }[] };
    const prevResult = await db.query<{ closing_cash_kept: string | null; location_name: string | null }>(
      `SELECT s.closing_cash_kept,
              l.name AS location_name
         FROM cash_sessions cs
         JOIN cmc_shifts s ON s.cash_session_id = cs.id
         LEFT JOIN locations l ON l.id = cs.location_id
        WHERE cs.workspace_owner_id = $1 AND cs.status = 'closed'
        ORDER BY cs.closed_at DESC
        LIMIT 1`,
      [wsId],
    );
    const prev = prevResult.rows[0] ?? null;
    return res.json({
      session: null,
      currency_summary: [],
      cash_sales_total: 0,
      expected_balance: 0,
      cash_refunds_total: 0,
      cash_refunds_count: 0,
      previous_closing_balance: prev ? Number(prev.closing_cash_kept ?? 0) : null,
      previous_location_name: prev?.location_name ?? null,
      drawer_currency: drawerResult.rows[0]?.currency ?? null,
      drawer_secondary_currency: drawerResult.rows[0]?.secondary_currency ?? null,
    });
  }

  const session = sessionResult.rows[0];

  // Fetch transactions for the session to compute live currency summary
  const txResult = await db.query<CashTransactionLite & { reference_type: string | null }>(
    `SELECT currency, type, direction, amount, reference_type
       FROM cash_transactions
      WHERE cash_session_id = $1 AND workspace_owner_id = $2`,
    [session.id, wsId],
  );

  const currencies = sessionCurrencies(
    session.currency,
    session.drawer_currency,
    session.drawer_secondary_currency,
    session.secondary_currency,
  );

  const currencySummary = computeSessionCurrencySummary(
    {
      currency: session.currency,
      opening_cash: session.opening_cash,
      secondary_currency: session.secondary_currency,
      opening_cash_secondary: session.opening_cash_secondary,
    },
    currencies,
    txResult.rows,
  );

  // Compute cash_sales_total from ledger entries
  const cashSalesTotalResult = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM cash_transactions
      WHERE cash_session_id = $1 AND workspace_owner_id = $2 AND type = 'cash_sale'`,
    [session.id, wsId],
  );
  const cashSalesTotal = Number(cashSalesTotalResult.rows[0]?.total ?? 0);
  // Use primary-currency expected_cash only — summing across currencies is nonsensical
  // (e.g. AED + USD would produce a meaningless number for dual-currency drawers).
  const primarySummary =
    currencySummary.find((cs) => cs.currency === session.currency) ?? currencySummary[0];
  const expectedBalance = primarySummary?.expected_cash ?? 0;

  return res.json({
    session: {
      id: session.id,
      status: session.status,
      currency: session.currency,
      secondary_currency: session.secondary_currency,
      opening_cash: session.opening_cash,
      opened_at: session.opened_at,
      closed_at: session.closed_at,
      reconciliation: session.reconciliation ?? null,
      location_name: session.location_name,
    },
    drawer_currency: session.drawer_currency,
    drawer_secondary_currency: session.drawer_secondary_currency,
    shift_currency: session.shift_currency,
    currency_summary: currencySummary,
    cash_sales_total: cashSalesTotal,
    expected_balance: expectedBalance,
    cash_refunds_total: 0,
    cash_refunds_count: 0,
  });
});

// ---------------------------------------------------------------------------
// CMC Cash Drawer Transactions — paginated ledger for the full subpage
// ---------------------------------------------------------------------------

router.get("/cmc-pos/cash-drawer/transactions", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!hasSub(wreq, "cmc_pos.cash_drawer")) {
    res.status(403).json({ error: "Requires cmc_pos.cash_drawer permission" });
    return;
  }

  const sessionId = req.query.session_id ? parseInt(req.query.session_id as string) : null;
  const locationId = req.query.location_id ? parseInt(req.query.location_id as string) : null;
  const wsId = wreq.workspaceOwnerId;
  const page = Math.max(1, parseInt((req.query.page as string) || "1") || 1);
  const limit = Math.min(50, Math.max(1, parseInt((req.query.limit as string) || "50") || 50));
  const offset = (page - 1) * limit;

  // Resolve session: prefer explicit session_id, else find the open session at location
  let resolvedSessionId: number | null = sessionId;
  if (!resolvedSessionId && locationId) {
    const openSession = await db.query<{ id: number }>(
      `SELECT cs.id FROM cash_sessions cs
         JOIN cash_drawers d ON d.id = cs.drawer_id
        WHERE cs.workspace_owner_id = $1 AND d.location_id = $2 AND cs.status = 'open'
        ORDER BY cs.opened_at DESC LIMIT 1`,
      [wsId, locationId],
    );
    resolvedSessionId = openSession.rows[0]?.id ?? null;
  }

  if (!resolvedSessionId) {
    return res.json({ transactions: [], total: 0, page, pages: 0 });
  }

  // Verify session belongs to this workspace
  const sessionCheck = await db.query<{ id: number }>(
    `SELECT id FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [resolvedSessionId, wsId],
  );
  if (sessionCheck.rows.length === 0) {
    return res.status(404).json({ error: "Session not found" });
  }

  const countResult = await db.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM cash_transactions
      WHERE cash_session_id = $1 AND workspace_owner_id = $2`,
    [resolvedSessionId, wsId],
  );
  const total = parseInt(countResult.rows[0]?.total ?? "0", 10);
  const pages = Math.ceil(total / limit);

  const txResult = await db.query<{
    id: number;
    type: string;
    direction: string;
    amount: string;
    currency: string;
    description: string | null;
    reference_type: string | null;
    reference_id: string | null;
    is_reversed: boolean;
    reversal_of_id: number | null;
    entered_by_name: string | null;
    created_by_clerk_id: string | null;
    transaction_date: string;
    status: string | null;
    note: string | null;
    sale_channel: string | null;
  }>(
    `SELECT ct.id, ct.type, ct.direction, ct.amount::text, ct.currency,
            ct.description, ct.reference_type, ct.reference_id,
            ct.is_reversed, ct.reversal_of_id,
            u.name AS entered_by_name,
            ct.created_by_clerk_id,
            COALESCE(ct.transaction_date::text, ct.created_at::text) AS transaction_date,
            ct.status,
            ct.description AS note,
            ct.sale_channel
       FROM cash_transactions ct
       LEFT JOIN (
         SELECT clerk_id, COALESCE(display_name, first_name || ' ' || last_name) AS name
           FROM workspace_members
          WHERE workspace_owner_id = $2
       ) u ON u.clerk_id = ct.created_by_clerk_id
      WHERE ct.cash_session_id = $1 AND ct.workspace_owner_id = $2
      ORDER BY ct.created_at ASC
      LIMIT $3 OFFSET $4`,
    [resolvedSessionId, wsId, limit, offset],
  );

  return res.json({
    transactions: txResult.rows,
    total,
    page,
    pages,
  });
});

// ---------------------------------------------------------------------------
// CMC Cash Drawer Adjustment — enforces cmc_pos.cash_drawer permission.
// Callers do NOT need cash_sessions.adjust; permission is inferred from the
// caller's active CMC shift.
// ---------------------------------------------------------------------------

router.post("/cmc-pos/cash-drawer/adjustment", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!hasSub(wreq, "cmc_pos.cash_drawer")) {
    res.status(403).json({ error: "Requires cmc_pos.cash_drawer permission" });
    return;
  }

  const wsId = wreq.workspaceOwnerId;
  const uid = actorId(req);

  // Resolve caller's active CMC shift → cash session
  const shiftRow = await db.query<{ cash_session_id: number | null }>(
    `SELECT cash_session_id FROM cmc_shifts
      WHERE workspace_owner_id = $1 AND opened_by_user_id = $2 AND status = 'open'
      LIMIT 1`,
    [wsId, uid],
  );
  if (!shiftRow.rows.length) {
    res.status(422).json({ error: "No active CMC shift — start a shift before recording cash" });
    return;
  }
  const cashSessionId = shiftRow.rows[0].cash_session_id;
  if (!cashSessionId) {
    res.status(422).json({ error: "Your active shift has no linked cash session" });
    return;
  }

  const sessionRow = await db.query<{
    status: string; currency: string; drawer_id: number; location_id: number;
  }>(
    `SELECT status, currency, drawer_id, location_id FROM cash_sessions
      WHERE id = $1 AND workspace_owner_id = $2`,
    [cashSessionId, wsId],
  );
  if (!sessionRow.rows.length) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  const sess = sessionRow.rows[0];
  if (sess.status !== "open") {
    res.status(409).json({ error: "Adjustments can only be added to an open session" });
    return;
  }

  const { amount, direction, description, currency } = req.body ?? {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  const dir = direction === "out" ? "out" : "in";
  const note = String(description ?? "").trim() || "Manual cash in";

  const result = await recordCashTransaction({
    workspaceOwnerId: wsId,
    amount: amt,
    type: "adjustment",
    direction: dir,
    currency: String(currency || sess.currency).toUpperCase(),
    drawerId: sess.drawer_id,
    locationId: sess.location_id,
    description: note,
    referenceType: "manual_adjustment",
    createdByClerkId: uid,
    cashSessionId,
  });

  res.status(201).json({ transaction_id: result.transactionId });
});

// ---------------------------------------------------------------------------
// CMC Cash Drawer Transfer — accepts destination_location_id (resolves to
// drawer internally), enforces cmc_pos.cash_drawer. Callers do NOT need the
// separate cash_sessions.transfer permission.
// ---------------------------------------------------------------------------

router.post("/cmc-pos/cash-drawer/transfer", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  if (!hasSub(wreq, "cmc_pos.cash_drawer")) {
    res.status(403).json({ error: "Requires cmc_pos.cash_drawer permission" });
    return;
  }

  const wsId = wreq.workspaceOwnerId;
  const uid = actorId(req);

  const { amount, destination_location_id, source_location_id, note } = req.body ?? {};

  // Optional: the location whose drawer the client is viewing. When provided,
  // the transfer acts on exactly that location's open shift/session.
  let srcLocId: number | null = null;
  if (source_location_id !== undefined && source_location_id !== null) {
    srcLocId = Number(source_location_id);
    if (!Number.isFinite(srcLocId) || srcLocId <= 0) {
      res.status(400).json({ error: "source_location_id must be a valid number" });
      return;
    }
  }

  // Resolve the active CMC shift the same way the dashboard displays it:
  // workspace-scoped (optionally location-scoped), regardless of who opened
  // it — a shared open shift belongs to the whole team. The caller is already
  // verified as an authorized workspace member with cmc_pos.cash_drawer.
  const shiftParams: unknown[] = [wsId];
  let shiftLocationFilter = "";
  if (srcLocId !== null) {
    shiftParams.push(srcLocId);
    shiftLocationFilter = `AND location_id = $${shiftParams.length}`;
  }
  const shiftRow = await db.query<{ cash_session_id: number | null }>(
    `SELECT cash_session_id FROM cmc_shifts
      WHERE workspace_owner_id = $1 AND status = 'open'
      ${shiftLocationFilter}
      ORDER BY opened_at DESC
      LIMIT 1`,
    shiftParams,
  );
  if (!shiftRow.rows.length) {
    res.status(422).json({
      error: srcLocId !== null
        ? "No open CMC shift at this location — start a shift before sending cash"
        : "No open CMC shift — start a shift before sending cash",
    });
    return;
  }
  const cashSessionId = shiftRow.rows[0].cash_session_id;
  if (!cashSessionId) {
    res.status(422).json({ error: "The open shift has no linked cash session — close and reopen the shift" });
    return;
  }

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  if (!destination_location_id) {
    res.status(400).json({ error: "destination_location_id is required" });
    return;
  }
  const destLocId = Number(destination_location_id);
  if (!Number.isFinite(destLocId) || destLocId <= 0) {
    res.status(400).json({ error: "destination_location_id must be a valid number" });
    return;
  }

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // Lock source session
      const srcResult = await client.query<{
        id: number; drawer_id: number; location_id: number; currency: string; status: string;
        expected_cash: string;
      }>(
        `SELECT cs.id, cs.drawer_id, cs.location_id, cs.currency, cs.status,
                (COALESCE(cs.opening_cash, 0)
                 + COALESCE(cs.cash_in_total, 0)
                 - COALESCE(cs.cash_out_total, 0)
                 + COALESCE(cs.transfers_in_total, 0)
                 - COALESCE(cs.transfers_out_total, 0))::text AS expected_cash
           FROM cash_sessions cs
          WHERE cs.id = $1 AND cs.workspace_owner_id = $2
          FOR UPDATE`,
        [cashSessionId, wsId],
      );
      if (!srcResult.rows.length) throw Object.assign(new Error("Source session not found"), { statusCode: 404 });
      const src = srcResult.rows[0];
      if (src.status !== "open") {
        throw Object.assign(
          new Error("The cash session has just been closed — refresh the page"),
          { statusCode: 409 },
        );
      }

      const balance = Number(src.expected_cash);
      if (amt > balance + 0.005) {
        throw Object.assign(new Error("Transfer amount exceeds available balance"), { statusCode: 422 });
      }
      if (amt <= 0) throw Object.assign(new Error("Amount must be positive"), { statusCode: 400 });

      // Resolve destination drawer from location
      const destDrawerResult = await client.query<{ id: number }>(
        `SELECT id FROM cash_drawers
          WHERE workspace_owner_id = $1 AND location_id = $2 AND is_active = true
          ORDER BY id ASC LIMIT 1`,
        [wsId, destLocId],
      );
      if (!destDrawerResult.rows.length) {
        throw Object.assign(
          new Error("No active cash drawer at the destination location"),
          { statusCode: 404 },
        );
      }
      const destDrawerId = destDrawerResult.rows[0].id;

      // Lock destination session — must be open
      const destSessResult = await client.query<{ id: number; status: string }>(
        `SELECT id, status FROM cash_sessions
          WHERE workspace_owner_id = $1 AND drawer_id = $2 AND status = 'open'
          ORDER BY opened_at DESC LIMIT 1
          FOR UPDATE`,
        [wsId, destDrawerId],
      );
      if (!destSessResult.rows.length) {
        throw Object.assign(
          new Error("Destination location has no open cash session — ask them to open a shift first"),
          { statusCode: 409 },
        );
      }
      const destSessId = destSessResult.rows[0].id;

      const txNote = String(note ?? "").trim();

      // transfer_out on source
      await client.query(
        `INSERT INTO cash_transactions
           (workspace_owner_id, cash_session_id, cash_drawer_id, location_id,
            currency, type, direction, amount, description, reference_type, created_by_clerk_id)
         VALUES ($1, $2, $3, $4, $5, 'transfer_out', 'out', $6, $7, 'cmc_cash_transfer', $8)`,
        [wsId, src.id, src.drawer_id, src.location_id, src.currency,
          amt.toFixed(2), txNote || "CMC cash transfer out", uid],
      );
      await recomputeSessionTotals(src.id, wsId, client);

      // transfer_in on destination
      await client.query(
        `INSERT INTO cash_transactions
           (workspace_owner_id, cash_session_id, cash_drawer_id, location_id,
            currency, type, direction, amount, description, reference_type, created_by_clerk_id)
         VALUES ($1, $2, $3, $4, $5, 'transfer_in', 'in', $6, $7, 'cmc_cash_transfer', $8)`,
        [wsId, destSessId, destDrawerId, destLocId, src.currency,
          amt.toFixed(2), txNote || "CMC cash transfer in", uid],
      );
      await recomputeSessionTotals(destSessId, wsId, client);
    });
    client.release();
    res.status(201).json({ ok: true });
  } catch (err: unknown) {
    client.release();
    const errObj = err as { statusCode?: number; code?: string; message?: string };
    if (errObj.code === "OVERDUE_SESSION_BLOCKS_SALES") {
      res.status(403).json({ code: errObj.code, error: errObj.message });
      return;
    }
    const statusCode = errObj.statusCode ?? 500;
    const message = err instanceof Error ? err.message : "Failed to initiate transfer";
    res.status(statusCode).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Recent Activity — last N events (sales + requests) for the dashboard
// ---------------------------------------------------------------------------

router.get("/cmc-pos/recent-activity", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;

  const locationId = req.query.location_id ? parseInt(req.query.location_id as string) : null;
  const limit = Math.min(parseInt((req.query.limit as string) || "10") || 10, 50);

  // Optional ISO timestamp lower bound (today's midnight in location timezone, sent by the client)
  const fromParam = req.query.from as string | undefined;
  const fromDate: string | null = (() => {
    if (!fromParam) return null;
    const d = new Date(fromParam);
    return isNaN(d.getTime()) ? null : d.toISOString();
  })();

  const wsId = wreq.workspaceOwnerId;

  // Sales at this location
  const salesParams: unknown[] = [wsId];
  let salesLocationClause = "";
  if (locationId) {
    salesParams.push(locationId);
    salesLocationClause = `AND location_id = $${salesParams.length}`;
  }
  let salesFromClause = "";
  if (fromDate) {
    salesParams.push(fromDate);
    salesFromClause = `AND created_at >= $${salesParams.length}`;
  }
  salesParams.push(limit);

  // Requests submitted/accepted/dispatched/received
  const reqParams: unknown[] = [wsId];
  let reqLocationClause = "";
  if (locationId) {
    reqParams.push(locationId);
    reqLocationClause = `AND destination_location_id = $${reqParams.length}`;
  }
  let reqFromClause = "";
  if (fromDate) {
    reqParams.push(fromDate);
    reqFromClause = `AND r.created_at >= $${reqParams.length}`;
  }
  reqParams.push(limit);

  // Delivery orders — not location-scoped (CMC deliveries have no location_id)
  const delivParams: unknown[] = [wsId, "cmc_delivery"];
  let delivFromClause = "";
  if (fromDate) {
    delivParams.push(fromDate);
    delivFromClause = `AND created_at >= $${delivParams.length}`;
  }
  delivParams.push(limit);

  const [salesRows, reqRows, delivRows] = await Promise.all([
    db.query<{
      id: string;
      created_at: string;
      payment_method: string | null;
      total: string;
      status: string;
      line_items: unknown;
    }>(
      `SELECT id::text, created_at, payment_method, total, status, line_items
         FROM cmc_sales
        WHERE workspace_owner_id = $1 ${salesLocationClause} ${salesFromClause}
        ORDER BY created_at DESC
        LIMIT $${salesParams.length}`,
      salesParams,
    ),
    db.query<{
      id: string;
      created_at: string;
      status: string;
      purpose: string;
      destination_location_name: string | null;
    }>(
      `SELECT r.id::text, r.created_at, r.status, r.purpose, l.name AS destination_location_name
         FROM cmc_requests r
         LEFT JOIN locations l ON l.id = r.destination_location_id
        WHERE r.workspace_owner_id = $1 ${reqLocationClause} ${reqFromClause}
        ORDER BY r.created_at DESC
        LIMIT $${reqParams.length}`,
      reqParams,
    ),
    db.query<{
      id: string;
      created_at: string;
      status: string;
      grand_total: string | null;
      currency: string | null;
      recipient_name: string | null;
      customer_name: string | null;
      payment_status: string | null;
    }>(
      `SELECT id::text, created_at, status, grand_total, currency,
              recipient_name, customer_name, payment_status
         FROM orders
        WHERE workspace_owner_id = $1 AND source = $2 ${delivFromClause}
        ORDER BY created_at DESC
        LIMIT $${delivParams.length}`,
      delivParams,
    ),
  ]);

  type ActivityItem = {
    id: string;
    type: "sale" | "request" | "delivery";
    created_at: string;
    payment_method: string | null;
    amount: string | null;
    currency: string | null;
    status: string;
    summary: string;
  };

  const items: ActivityItem[] = [];

  for (const s of salesRows.rows) {
    const lineItems = Array.isArray(s.line_items)
      ? (s.line_items as Array<{ name?: string }>)
      : [];
    const summary =
      lineItems.length === 1
        ? (lineItems[0].name ?? "1 item")
        : `${lineItems.length} items`;
    items.push({
      id: s.id,
      type: "sale",
      created_at: s.created_at,
      payment_method: s.payment_method,
      amount: s.total,
      currency: "USD",
      status: s.status,
      summary,
    });
  }

  for (const r of reqRows.rows) {
    items.push({
      id: r.id,
      type: "request",
      created_at: r.created_at,
      payment_method: null,
      amount: null,
      currency: null,
      status: r.status,
      summary: r.destination_location_name ?? r.purpose ?? "Branch request",
    });
  }

  for (const d of delivRows.rows) {
    items.push({
      id: d.id,
      type: "delivery",
      created_at: d.created_at,
      payment_method: d.payment_status === "paid" ? "card" : d.payment_status === "cash_on_delivery" ? "cash" : null,
      amount: d.grand_total,
      currency: d.currency ?? "USD",
      status: d.status,
      summary: d.recipient_name ?? d.customer_name ?? "Delivery order",
    });
  }

  // Sort combined list by created_at desc, take top `limit`
  items.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  res.json({ items: items.slice(0, limit) });
});

// ---------------------------------------------------------------------------
// CMC Returns — Workflow 4: return of poor-condition CMC stock
// ---------------------------------------------------------------------------

// Photo upload for return items
router.post("/cmc-pos/returns/upload-photo", cmcUpload.single("photo"), async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "A photo file is required" });
    return;
  }
  const mime = file.mimetype as string;
  const ALLOWED = ["image/jpeg", "image/png"];
  if (!ALLOWED.includes(mime)) {
    res.status(400).json({ error: "File must be a JPG or PNG image" });
    return;
  }
  try {
    const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
    if (!privateObjectDir) throw new Error("PRIVATE_OBJECT_DIR not set");
    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/${wreq.workspaceOwnerId}/cmc-returns/${objectId}`;
    const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
    if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
    const bucketName = parts[0];
    const objectName = parts.slice(1).join("/");
    const bucket = objectStorageClient.bucket(bucketName);
    const fileObj = bucket.file(objectName);
    await fileObj.save(file.buffer, { contentType: mime, resumable: false });
    const url = `/objects/${wreq.workspaceOwnerId}/cmc-returns/${objectId}`;
    res.json({ url });
  } catch (err) {
    req.log.error({ err }, "cmc-returns: photo upload failed");
    res.status(500).json({ error: "Failed to upload photo" });
  }
});

const returnLineItemSchema = z.object({
  product_id: z.number().int().nullable().optional(),
  sku_snapshot: z.string().optional().nullable(),
  name_snapshot: z.string().min(1),
  image_url: z.string().optional().nullable(),
  quantity: z.number().int().min(1),
  reason: z.string().default("poor_condition"),
  is_custom: z.boolean().default(false),
});

const createReturnSchema = z.object({
  branch_location_id: z.number().int(),
  return_to_location_id: z.number().int(),
  collection_method: z.string().default("pickup"),
  collection_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "collection_date must be YYYY-MM-DD"),
  notes: z.string().optional().nullable(),
  line_items: z.array(returnLineItemSchema).min(1),
});

// POST /cmc-pos/returns — create a return in draft status
router.post("/cmc-pos/returns", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const parsed = createReturnSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid return data", details: parsed.error.issues });
    return;
  }
  const { branch_location_id, return_to_location_id, collection_method, collection_date, notes, line_items } = parsed.data;
  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;

  // Verify both locations belong to this workspace
  const locCheck = await db.query<{ id: number }>(
    `SELECT id FROM locations WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
    [wsId, [branch_location_id, return_to_location_id]],
  );
  const foundIds = new Set(locCheck.rows.map((r) => r.id));
  if (!foundIds.has(branch_location_id)) {
    res.status(422).json({ error: "branch_location_id not found in this workspace" });
    return;
  }
  if (!foundIds.has(return_to_location_id)) {
    res.status(422).json({ error: "return_to_location_id not found in this workspace" });
    return;
  }

  // Validate catalogue product_ids are valid CMC products at the branch
  const catalogueItems = line_items.filter((li) => !li.is_custom && li.product_id != null);
  if (catalogueItems.length > 0) {
    const productIds = catalogueItems.map((li) => li.product_id as number);
    const productCheck = await db.query<{ id: number }>(
      `SELECT id FROM products WHERE workspace_owner_id = $1 AND id = ANY($2::int[]) AND is_cmc = true AND is_archived = false`,
      [wsId, productIds],
    );
    const validProductIds = new Set(productCheck.rows.map((r) => r.id));
    for (const li of catalogueItems) {
      if (!validProductIds.has(li.product_id as number)) {
        res.status(422).json({ error: `Product id ${li.product_id} is not a valid active CMC product` });
        return;
      }
    }
  }

  const client = await db.connect();
  let returnRow: Record<string, unknown>;
  try {
    returnRow = await withTransaction(client, async () => {
      const reference = await generateReturnReference(wsId);
      const insertResult = await client.query(
        `INSERT INTO cmc_returns
           (workspace_owner_id, branch_location_id, return_to_location_id, operator_user_id,
            reference, status, collection_method, collection_date, notes)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8)
         RETURNING *`,
        [wsId, branch_location_id, return_to_location_id, uid, reference,
         collection_method, collection_date, notes ?? null],
      );
      const ret = insertResult.rows[0] as Record<string, unknown>;
      const returnId = ret.id as string;

      // Insert line items
      const insertedLineItems: unknown[] = [];
      for (const li of line_items) {
        // Snapshot current stock for catalogue items at branch
        let stockSnapshot: number | null = null;
        if (!li.is_custom && li.product_id != null) {
          const stockResult = await client.query<{ stock: string }>(
            `SELECT COALESCE(SUM(CASE WHEN movement_type = 'in' THEN quantity ELSE -quantity END), 0)::text AS stock
               FROM base_item_stock_adjustments
              WHERE product_id = $1
                AND location_id = $2
                AND ledger_scope = 'cmc_product_compat'`,
            [li.product_id, branch_location_id],
          );
          stockSnapshot = Math.round(Number(stockResult.rows[0]?.stock ?? 0));
        }
        const liResult = await client.query(
          `INSERT INTO cmc_return_line_items
             (return_id, product_id, sku_snapshot, name_snapshot, image_url, quantity, reason, stock_snapshot, is_custom)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [returnId, li.product_id ?? null, li.sku_snapshot ?? null, li.name_snapshot,
           li.image_url ?? null, li.quantity, li.reason, stockSnapshot, li.is_custom],
        );
        insertedLineItems.push(liResult.rows[0]);
      }

      // Audit event
      await client.query(
        `INSERT INTO cmc_return_events (return_id, actor_user_id, from_status, to_status) VALUES ($1, $2, NULL, 'draft')`,
        [returnId, uid],
      );

      req.log.info({ returnId, reference, wsId }, "cmc-returns: draft created");
      return { ...ret, line_items: insertedLineItems };
    });
  } finally {
    client.release();
  }

  res.status(201).json({ return: returnRow });
});

// POST /cmc-pos/returns/:id/submit — transition to awaiting_pickup with stock deduction
router.post("/cmc-pos/returns/:id/submit", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const returnId = req.params.id;
  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;
  const idempotencyKey = (req.body?.idempotency_key as string | undefined) ?? null;

  // Load the return
  const retResult = await db.query(
    `SELECT * FROM cmc_returns WHERE id = $1 AND workspace_owner_id = $2`,
    [returnId, wsId],
  );
  if (retResult.rows.length === 0) {
    res.status(404).json({ error: "Return not found" });
    return;
  }
  const ret = retResult.rows[0] as Record<string, unknown>;

  // Idempotency: already submitted
  if (ret.status === "awaiting_pickup") {
    req.log.info({ returnId, idempotencyKey }, "cmc-returns: submit idempotent hit");
    const detail = await db.query(
      `SELECT r.*,
              (SELECT json_agg(li ORDER BY li.id) FROM cmc_return_line_items li WHERE li.return_id = r.id) AS line_items,
              (SELECT json_agg(e ORDER BY e.id) FROM cmc_return_events e WHERE e.return_id = r.id) AS events
         FROM cmc_returns r WHERE r.id = $1`,
      [returnId],
    );
    res.json({ return: detail.rows[0] });
    return;
  }

  if (ret.status !== "draft") {
    res.status(409).json({ error: `Cannot submit a return in '${ret.status}' status` });
    return;
  }

  // Load catalogue line items for stock validation
  const lineItemsResult = await db.query(
    `SELECT * FROM cmc_return_line_items WHERE return_id = $1 ORDER BY id`,
    [returnId],
  );
  const lineItems = lineItemsResult.rows as Array<{
    id: number;
    product_id: number | null;
    name_snapshot: string;
    quantity: number;
    is_custom: boolean;
    adjustment_id: number | null;
  }>;

  const branchLocationId = ret.branch_location_id as number;

  // Re-validate catalogue stock availability server-side
  for (const li of lineItems) {
    if (li.is_custom || li.product_id == null) continue;
    const stockResult = await db.query<{ stock: string }>(
      `SELECT COALESCE(SUM(CASE WHEN movement_type = 'in' THEN quantity ELSE -quantity END), 0)::text AS stock
         FROM base_item_stock_adjustments
        WHERE product_id = $1
          AND location_id = $2
          AND ledger_scope = 'cmc_product_compat'`,
      [li.product_id, branchLocationId],
    );
    const currentStock = Number(stockResult.rows[0]?.stock ?? 0);
    if (li.quantity > currentStock) {
      res.status(409).json({
        code: "STOCK_EXCEEDED",
        error: `Insufficient stock for "${li.name_snapshot}": ${li.quantity} requested but only ${currentStock} available`,
        product_id: li.product_id,
        available: currentStock,
        requested: li.quantity,
      });
      return;
    }
  }

  const client = await db.connect();
  let submittedReturn: Record<string, unknown>;
  try {
    submittedReturn = await withTransaction(client, async () => {
      // Update status
      const updateResult = await client.query(
        `UPDATE cmc_returns SET status = 'awaiting_pickup', updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2 AND status = 'draft'
          RETURNING *`,
        [returnId, wsId],
      );
      if (updateResult.rowCount === 0) {
        throw Object.assign(new Error("Return was already submitted concurrently"), { code: "CONCURRENT_SUBMIT" });
      }

      // Write stock adjustment for each catalogue line
      for (const li of lineItems) {
        if (li.is_custom || li.product_id == null) continue;

        // Resolve the base_item_id linked to this product
        const baseItemResult = await client.query<{ base_item_id: number | null }>(
          `SELECT bi.id AS base_item_id
             FROM base_items bi
             JOIN products p ON p.base_item_id = bi.id
            WHERE p.id = $1 AND bi.workspace_owner_id = $2
            LIMIT 1`,
          [li.product_id, wsId],
        );
        const baseItemId = baseItemResult.rows[0]?.base_item_id ?? null;

        if (baseItemId != null) {
          // Use postMovement to correctly deduct from base_item_location_statuses
          const movResult = await postMovement(client, {
            workspaceOwnerId: wsId,
            baseItemId,
            locationId: branchLocationId,
            quantityChange: -li.quantity,
            reason: "cmc_return",
            movementType: "cmc_return",
            note: `CMC return ${ret.reference as string}`,
            createdByUserId: uid,
            productId: li.product_id,
            inventoryAllowNegativeStock: true,
          });
          if (movResult.movementId != null) {
            await client.query(
              `UPDATE cmc_return_line_items SET adjustment_id = $1 WHERE id = $2`,
              [movResult.movementId, li.id],
            );
          }
        } else {
          // Fallback: raw stock adjustment when no base_item link exists
          const stockResult = await client.query<{ stock: string }>(
            `SELECT COALESCE(SUM(CASE WHEN movement_type = 'in' THEN quantity ELSE -quantity END), 0)::text AS stock
               FROM base_item_stock_adjustments
              WHERE product_id = $1
                AND location_id = $2
                AND ledger_scope = 'cmc_product_compat'`,
            [li.product_id, branchLocationId],
          );
          const currentStock = Number(stockResult.rows[0]?.stock ?? 0);
          const stockAfter = currentStock - li.quantity;
          const adjResult = await client.query<{ id: number }>(
            `INSERT INTO base_item_stock_adjustments
               (workspace_owner_id, base_item_id, location_id, quantity_change, reason,
                 movement_type, note, stock_after, created_by_user_id, product_id,
                 ledger_scope)
              VALUES ($1, NULL, $2, $3, 'cmc_return', 'cmc_return', $4, $5, $6, $7,
                      'cmc_product_compat')
             RETURNING id`,
            [wsId, branchLocationId, -li.quantity,
             `CMC return ${ret.reference as string}`, stockAfter, uid, li.product_id],
          );
          if (adjResult.rows[0]?.id) {
            await client.query(
              `UPDATE cmc_return_line_items SET adjustment_id = $1 WHERE id = $2`,
              [adjResult.rows[0].id, li.id],
            );
          }
          req.log.info({ returnId, productId: li.product_id }, "cmc-returns: no base_item link — used raw stock adjustment");
        }
      }

      // Audit event
      await client.query(
        `INSERT INTO cmc_return_events (return_id, actor_user_id, from_status, to_status) VALUES ($1, $2, 'draft', 'awaiting_pickup')`,
        [returnId, uid],
      );

      req.log.info({ returnId, wsId }, "cmc-returns: submitted to awaiting_pickup");
      return updateResult.rows[0] as Record<string, unknown>;
    });
  } catch (err) {
    client.release();
    const e = err as { code?: string; message?: string };
    if (e.code === "CONCURRENT_SUBMIT") {
      res.status(409).json({ code: "CONCURRENT_SUBMIT", error: e.message });
      return;
    }
    throw err;
  }
  client.release();

  // Fire-and-forget Tookan task creation
  if (isTookanEnabled()) {
    void createTookanReturnTask(returnId, wsId);
  }

  // Return full detail with line items
  const detailResult = await db.query(
    `SELECT r.*,
            (SELECT json_agg(li ORDER BY li.id) FROM cmc_return_line_items li WHERE li.return_id = r.id) AS line_items,
            (SELECT json_agg(e ORDER BY e.id) FROM cmc_return_events e WHERE e.return_id = r.id) AS events
       FROM cmc_returns r WHERE r.id = $1`,
    [returnId],
  );
  res.json({ return: detailResult.rows[0] ?? submittedReturn });
});

// POST /cmc-pos/returns/:id/cancel — cancel a draft or awaiting_pickup return
router.post("/cmc-pos/returns/:id/cancel", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const returnId = req.params.id;
  const uid = actorId(req);
  const wsId = wreq.workspaceOwnerId;

  const retResult = await db.query(
    `SELECT * FROM cmc_returns WHERE id = $1 AND workspace_owner_id = $2`,
    [returnId, wsId],
  );
  if (retResult.rows.length === 0) {
    res.status(404).json({ error: "Return not found" });
    return;
  }
  const ret = retResult.rows[0] as Record<string, unknown>;
  if (!["draft", "awaiting_pickup"].includes(ret.status as string)) {
    res.status(409).json({ error: `Cannot cancel a return in '${ret.status}' status` });
    return;
  }

  const lineItemsResult = await db.query(
    `SELECT * FROM cmc_return_line_items WHERE return_id = $1 ORDER BY id`,
    [returnId],
  );
  const lineItems = lineItemsResult.rows as Array<{
    id: number;
    product_id: number | null;
    name_snapshot: string;
    quantity: number;
    is_custom: boolean;
    adjustment_id: number | null;
  }>;

  const branchLocationId = ret.branch_location_id as number;
  const fromStatus = ret.status as string;

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // Reverse stock adjustments for catalogue lines that were deducted
      for (const li of lineItems) {
        if (li.is_custom || li.product_id == null || li.adjustment_id == null) continue;

        // Look up the original adjustment to get base_item_id
        const origAdj = await client.query<{ base_item_id: number; stock_after: string }>(
          `SELECT base_item_id, stock_after FROM base_item_stock_adjustments WHERE id = $1`,
          [li.adjustment_id],
        );
        const orig = origAdj.rows[0];

        if (orig && orig.base_item_id && orig.base_item_id !== 0) {
          await postMovement(client, {
            workspaceOwnerId: wsId,
            baseItemId: orig.base_item_id,
            locationId: branchLocationId,
            quantityChange: li.quantity,
            reason: "cmc_return_cancelled",
            movementType: "cmc_return_reversal",
            note: `Reversal for cancelled CMC return ${ret.reference as string}`,
            createdByUserId: uid,
            productId: li.product_id,
            reversalOfId: li.adjustment_id,
          });
        } else {
          // Fallback raw reversal
          const stockResult = await client.query<{ stock: string }>(
            `SELECT COALESCE(SUM(CASE WHEN movement_type = 'in' THEN quantity ELSE -quantity END), 0)::text AS stock
               FROM base_item_stock_adjustments
              WHERE product_id = $1
                AND location_id = $2
                AND ledger_scope = 'cmc_product_compat'`,
            [li.product_id, branchLocationId],
          );
          const currentStock = Number(stockResult.rows[0]?.stock ?? 0);
          await client.query(
            `INSERT INTO base_item_stock_adjustments
               (workspace_owner_id, base_item_id, location_id, quantity_change, reason,
                 movement_type, note, stock_after, created_by_user_id, product_id,
                 reversal_of_id, ledger_scope)
              VALUES ($1, NULL, $2, $3, 'cmc_return_cancelled', 'cmc_return_reversal', $4, $5, $6, $7, $8,
                      'cmc_product_compat')`,
            [wsId, branchLocationId, li.quantity,
             `Reversal for cancelled CMC return ${ret.reference as string}`,
             currentStock + li.quantity, uid, li.product_id, li.adjustment_id],
          );
        }
      }

      await client.query(
        `UPDATE cmc_returns SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2`,
        [returnId, wsId],
      );
      await client.query(
        `INSERT INTO cmc_return_events (return_id, actor_user_id, from_status, to_status) VALUES ($1, $2, $3, 'cancelled')`,
        [returnId, uid, fromStatus],
      );
      req.log.info({ returnId, wsId, fromStatus }, "cmc-returns: cancelled");
    });
  } finally {
    client.release();
  }

  const detailResult = await db.query(
    `SELECT r.*,
            (SELECT json_agg(li ORDER BY li.id) FROM cmc_return_line_items li WHERE li.return_id = r.id) AS line_items,
            (SELECT json_agg(e ORDER BY e.id) FROM cmc_return_events e WHERE e.return_id = r.id) AS events
       FROM cmc_returns r WHERE r.id = $1`,
    [returnId],
  );
  res.json({ return: detailResult.rows[0] });
});

// GET /cmc-pos/returns — paginated list
router.get("/cmc-pos/returns", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const wsId = wreq.workspaceOwnerId;
  const branchLocationId = req.query.branch_location_id ? parseInt(req.query.branch_location_id as string) : null;
  const statusFilter = req.query.status as string | undefined;
  const q = req.query.q as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const conditions: string[] = ["r.workspace_owner_id = $1"];
  const params: unknown[] = [wsId];

  if (branchLocationId) { params.push(branchLocationId); conditions.push(`r.branch_location_id = $${params.length}`); }
  if (statusFilter) { params.push(statusFilter); conditions.push(`r.status = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(r.reference ILIKE $${params.length} OR EXISTS (
      SELECT 1 FROM cmc_return_line_items li WHERE li.return_id = r.id AND li.name_snapshot ILIKE $${params.length}
    ))`);
  }
  const where = conditions.join(" AND ");

  const [countResult, rowsResult] = await Promise.all([
    db.query(`SELECT COUNT(*) AS total FROM cmc_returns r WHERE ${where}`, params),
    db.query(
      `SELECT r.*,
              bl.name AS branch_location_name,
              rtl.name AS return_to_location_name,
              wm.member_email AS operator_email,
              (SELECT COUNT(*) FROM cmc_return_line_items li WHERE li.return_id = r.id) AS item_count,
              (SELECT COALESCE(SUM(li.quantity), 0) FROM cmc_return_line_items li WHERE li.return_id = r.id) AS total_units
         FROM cmc_returns r
         LEFT JOIN locations bl  ON bl.id  = r.branch_location_id
         LEFT JOIN locations rtl ON rtl.id = r.return_to_location_id
         LEFT JOIN workspace_members wm ON wm.member_user_id = r.operator_user_id AND wm.workspace_owner_id = r.workspace_owner_id
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
  ]);

  res.json({
    returns: rowsResult.rows,
    total: Number(countResult.rows[0].total),
    limit,
    offset,
  });
});

// GET /cmc-pos/returns/:id — full detail
router.get("/cmc-pos/returns/:id", async (req, res) => {
  const wreq = requireCmcPos(req, res);
  if (!wreq) return;
  const result = await db.query(
    `SELECT r.*,
            bl.name  AS branch_location_name,
            rtl.name AS return_to_location_name,
            wm.member_email AS operator_email,
            (SELECT json_agg(li ORDER BY li.id) FROM cmc_return_line_items li WHERE li.return_id = r.id) AS line_items,
            (SELECT json_agg(e  ORDER BY e.id)  FROM cmc_return_events e   WHERE e.return_id = r.id)  AS events
       FROM cmc_returns r
       LEFT JOIN locations bl  ON bl.id  = r.branch_location_id
       LEFT JOIN locations rtl ON rtl.id = r.return_to_location_id
       LEFT JOIN workspace_members wm ON wm.member_user_id = r.operator_user_id AND wm.workspace_owner_id = r.workspace_owner_id
      WHERE r.id = $1 AND r.workspace_owner_id = $2`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Return not found" });
    return;
  }
  res.json({ return: result.rows[0] });
});

export default router;

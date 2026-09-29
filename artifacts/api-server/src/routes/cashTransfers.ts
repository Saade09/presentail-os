import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { db, withTransaction } from "../lib/db";
import { requireAuth, authed } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { broadcastEvent } from "../lib/eventsSse";
import {
  generateTransferNumber,
  recomputeSessionTotals,
  logSessionActivity,
} from "../lib/cashDesk";

const router = Router();
router.use(requireAuth, resolveWorkspace);

function hasPermission(wreq: ReturnType<typeof workspace>, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

async function fetchClerkName(userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const user = await clerkClient.users.getUser(userId);
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
    return name || (user.primaryEmailAddress?.emailAddress ?? null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POST /api/cash-sessions/:id/transfer/validate
// Validate a transfer initiation without creating anything.
// ---------------------------------------------------------------------------
router.post("/cash-sessions/:id/transfer/validate", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.transfer")) {
    res.status(403).json({ error: "Insufficient permissions to initiate cash transfers" });
    return;
  }

  const sessionId = parseInt(req.params.id, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }

  const {
    destination_drawer_id,
    amount,
    currency_code,
    intended_receiver_user_id,
  } = req.body ?? {};

  const errors: string[] = [];

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    errors.push("amount must be a positive number");
  }

  const destDrawerId = Number(destination_drawer_id);
  if (!Number.isFinite(destDrawerId) || destDrawerId <= 0) {
    errors.push("destination_drawer_id is required");
  }

  if (errors.length > 0) {
    res.status(400).json({ errors });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;

  const sessionResult = await db.query<{
    id: number;
    drawer_id: number;
    location_id: number | null;
    currency: string;
    secondary_currency: string | null;
    status: string;
    expected_cash: string | null;
    expected_cash_secondary: string | null;
    opening_cash: string;
  }>(
    `SELECT id, drawer_id, location_id, currency, secondary_currency, status,
            expected_cash, expected_cash_secondary, opening_cash
       FROM cash_sessions
      WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, ownerId],
  );
  if (sessionResult.rowCount === 0) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  const session = sessionResult.rows[0];

  if (session.status !== "open") {
    errors.push("Source session must be open");
  }

  const currency = (currency_code ?? session.currency).toUpperCase();
  if (currency !== session.currency && currency !== (session.secondary_currency ?? "")) {
    errors.push("currency_code must match the session's primary or secondary currency");
  }

  const isPrimary = currency === session.currency;
  const availableCash = isPrimary
    ? Number(session.expected_cash ?? session.opening_cash ?? 0)
    : Number(session.expected_cash_secondary ?? 0);
  if (Number.isFinite(amt) && amt > availableCash) {
    errors.push(
      `Insufficient expected cash: ${availableCash.toFixed(2)} ${currency} available`,
    );
  }

  if (Number.isFinite(destDrawerId)) {
    if (destDrawerId === session.drawer_id) {
      errors.push("Destination drawer must differ from the source drawer");
    } else {
      const destResult = await db.query<{
        id: number;
        currency: string;
        secondary_currency: string | null;
        is_active: boolean;
      }>(
        `SELECT id, currency, secondary_currency, is_active
           FROM cash_drawers
          WHERE id = $1 AND workspace_owner_id = $2`,
        [destDrawerId, ownerId],
      );
      if (destResult.rowCount === 0) {
        errors.push("Destination drawer not found");
      } else {
        const dest = destResult.rows[0];
        if (!dest.is_active) errors.push("Destination drawer is inactive");
        const destCurrencies = [dest.currency, dest.secondary_currency].filter(Boolean);
        if (!destCurrencies.includes(currency)) {
          errors.push(`Destination drawer does not support ${currency}`);
        }
      }
    }
  }

  if (intended_receiver_user_id) {
    const memberResult = await db.query(
      `SELECT id FROM workspace_members
        WHERE workspace_owner_id = $1 AND member_user_id = $2`,
      [ownerId, intended_receiver_user_id],
    );
    if (memberResult.rowCount === 0) {
      errors.push("intended_receiver_user_id is not an active workspace member");
    }
  }

  if (errors.length > 0) {
    res.status(422).json({ valid: false, errors });
    return;
  }

  res.json({ valid: true, currency, amount: amt });
});

// ---------------------------------------------------------------------------
// POST /api/cash-sessions/:id/transfer
// Atomically create a transfer, deduct from source session, notify receiver.
// ---------------------------------------------------------------------------
router.post("/cash-sessions/:id/transfer", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.transfer")) {
    res.status(403).json({ error: "Insufficient permissions to initiate cash transfers" });
    return;
  }

  const sessionId = parseInt(req.params.id, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }

  const {
    destination_drawer_id,
    amount,
    currency_code,
    intended_receiver_user_id,
    transfer_method = "internal",
    carrier_type,
    carrier_user_id,
    external_carrier_name,
    note,
    idempotency_key,
  } = req.body ?? {};

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  const destDrawerId = Number(destination_drawer_id);
  if (!Number.isFinite(destDrawerId) || destDrawerId <= 0) {
    res.status(400).json({ error: "destination_drawer_id is required" });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;
  const userId = authed(req).userId;

  // Idempotency check (outside transaction — read-only)
  if (idempotency_key) {
    const existing = await db.query<{ id: number }>(
      `SELECT id FROM cash_transfers
        WHERE workspace_owner_id = $1 AND idempotency_key = $2`,
      [ownerId, idempotency_key],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      const full = await db.query(
        `SELECT * FROM cash_transfers WHERE id = $1`,
        [existing.rows[0].id],
      );
      res.json({ transfer: full.rows[0], idempotent: true });
      return;
    }
  }

  // Validate destination drawer (outside transaction — no mutation)
  const destResult = await db.query<{
    id: number;
    currency: string;
    secondary_currency: string | null;
    is_active: boolean;
    location_id: number | null;
    name: string;
  }>(
    `SELECT id, currency, secondary_currency, is_active, location_id, name
       FROM cash_drawers WHERE id = $1 AND workspace_owner_id = $2`,
    [destDrawerId, ownerId],
  );
  if (destResult.rowCount === 0) {
    res.status(404).json({ error: "Destination drawer not found" });
    return;
  }
  const destDrawer = destResult.rows[0];
  if (!destDrawer.is_active) {
    res.status(400).json({ error: "Destination drawer is inactive" });
    return;
  }

  const year = new Date().getFullYear();
  const actorName = await fetchClerkName(userId);

  let newTransfer: Record<string, unknown> = {};
  let intendedReceiverUserId: string | null = intended_receiver_user_id ?? null;

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // ── 1. Lock the source session to prevent concurrent over-transfer ──────
      const sessionResult = await client.query<{
        id: number;
        drawer_id: number;
        location_id: number | null;
        currency: string;
        secondary_currency: string | null;
        status: string;
        expected_cash: string | null;
        expected_cash_secondary: string | null;
        opening_cash: string;
      }>(
        `SELECT id, drawer_id, location_id, currency, secondary_currency, status,
                expected_cash, expected_cash_secondary, opening_cash
           FROM cash_sessions
          WHERE id = $1 AND workspace_owner_id = $2
          FOR UPDATE`,
        [sessionId, ownerId],
      );
      if (sessionResult.rowCount === 0) {
        throw Object.assign(new Error("Cash session not found"), { statusCode: 404 });
      }
      const session = sessionResult.rows[0];

      if (session.status !== "open") {
        throw Object.assign(new Error("Source session must be open"), { statusCode: 400 });
      }
      if (session.drawer_id === destDrawerId) {
        throw Object.assign(
          new Error("Destination drawer must differ from the source drawer"),
          { statusCode: 400 },
        );
      }

      const currency = (currency_code ?? session.currency).toUpperCase();
      if (currency !== session.currency && currency !== (session.secondary_currency ?? "")) {
        throw Object.assign(
          new Error("currency_code must match the session's currency"),
          { statusCode: 400 },
        );
      }

      const destCurrencies = [destDrawer.currency, destDrawer.secondary_currency].filter(Boolean);
      if (!destCurrencies.includes(currency)) {
        throw Object.assign(
          new Error(`Destination drawer does not support ${currency}`),
          { statusCode: 422 },
        );
      }

      // ── 2. Revalidate available balance inside the locked transaction ────────
      const isPrimary = currency === session.currency;
      const availableCash = isPrimary
        ? Number(session.expected_cash ?? session.opening_cash ?? 0)
        : Number(session.expected_cash_secondary ?? 0);
      if (amt > availableCash) {
        throw Object.assign(
          new Error(`Insufficient expected cash: ${availableCash.toFixed(2)} ${currency} available`),
          { statusCode: 422 },
        );
      }

      // ── 3. Generate transfer number (transaction-scoped COUNT) ───────────────
      const transferNumber = await generateTransferNumber(ownerId, year, client);

      // ── 4. Insert cash_transfers record ─────────────────────────────────────
      const transferResult = await client.query<{ id: number }>(
        `INSERT INTO cash_transfers (
           workspace_owner_id, transfer_number,
           source_location_id, source_drawer_id, source_session_id,
           destination_location_id, destination_drawer_id,
           currency_code, sent_amount,
           transfer_method, status,
           initiated_by_user_id, handed_over_by_user_id,
           intended_receiver_user_id,
           carrier_type, carrier_user_id, external_carrier_name,
           note, idempotency_key,
           handed_over_at, created_at, updated_at
         ) VALUES (
           $1, $2,
           $3, $4, $5,
           $6, $7,
           $8, $9,
           $10, 'IN_TRANSIT',
           $11, $11,
           $12,
           $13, $14, $15,
           $16, $17,
           now(), now(), now()
         ) RETURNING id`,
        [
          ownerId,
          transferNumber,
          session.location_id,
          session.drawer_id,
          session.id,
          destDrawer.location_id,
          destDrawerId,
          currency,
          amt.toFixed(2),
          transfer_method ?? "internal",
          userId,
          intendedReceiverUserId,
          carrier_type ?? null,
          carrier_user_id ?? null,
          external_carrier_name ?? null,
          note ?? null,
          idempotency_key ?? null,
        ],
      );
      const transferId = transferResult.rows[0].id;

      // ── 5. Insert source transfer_out cash_transaction ───────────────────────
      await client.query(
        `INSERT INTO cash_transactions (
           workspace_owner_id, cash_session_id, cash_drawer_id, location_id,
           currency, type, direction, amount,
           description, reference_type, reference_id, created_by_clerk_id
         ) VALUES ($1, $2, $3, $4, $5, 'transfer_out', 'out', $6, $7, 'cash_transfer', $8, $9)`,
        [
          ownerId,
          session.id,
          session.drawer_id,
          session.location_id,
          currency,
          amt.toFixed(2),
          `Cash transfer out — ${transferNumber}`,
          transferNumber,
          userId,
        ],
      );

      // ── 6. Recompute source session totals (using same transaction client) ───
      await recomputeSessionTotals(session.id, ownerId, client);

      // ── 7. Activity log ──────────────────────────────────────────────────────
      await logSessionActivity(
        ownerId,
        session.id,
        "transfer_initiated",
        userId,
        actorName,
        JSON.stringify({ transferNumber, amount: amt.toFixed(2), currency, destDrawerId }),
        client,
      );

      // ── 8. Audit event ───────────────────────────────────────────────────────
      await client.query(
        `INSERT INTO cash_transfer_audit_events
           (workspace_owner_id, cash_transfer_id, event_type, actor_user_id, actor_name, payload)
         VALUES ($1, $2, 'initiated', $3, $4, $5)`,
        [
          ownerId,
          transferId,
          userId,
          actorName,
          JSON.stringify({ amount: amt.toFixed(2), currency, destDrawerId, transferNumber }),
        ],
      );

      const fullResult = await client.query(
        `SELECT * FROM cash_transfers WHERE id = $1`,
        [transferId],
      );
      newTransfer = fullResult.rows[0] as Record<string, unknown>;
    });
  } catch (err: unknown) {
    client.release();
    const statusCode =
      err !== null && typeof err === "object" && "statusCode" in err
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message =
      err instanceof Error ? err.message : "Failed to initiate transfer";
    res.status(statusCode).json({ error: message });
    return;
  }
  client.release();

  // Notify intended receiver via SSE (post-commit)
  if (intendedReceiverUserId) {
    broadcastEvent(ownerId, {
      event: "cash_transfer.pending",
      workspaceId: ownerId,
      data: {
        transferNumber: newTransfer.transfer_number,
        currency: newTransfer.currency_code,
        sentAmount: amt,
        destinationDrawerId: destDrawerId,
        intendedReceiverUserId,
      },
    });
  }

  res.status(201).json({ transfer: newTransfer });
});

// ---------------------------------------------------------------------------
// GET /api/cash-transfers
// Paginated list with filters.
// ---------------------------------------------------------------------------
router.get("/cash-transfers", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash-sessions")) {
    res.status(403).json({ error: "Insufficient permissions to view cash transfers" });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;
  const PAGE_SIZE = 20;
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions: string[] = ["ct.workspace_owner_id = $1"];
  const params: unknown[] = [ownerId];

  const addParam = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (req.query.status) conditions.push(`ct.status = ${addParam(req.query.status)}`);
  if (req.query.currency) conditions.push(`ct.currency_code = ${addParam(String(req.query.currency).toUpperCase())}`);
  if (req.query.source_drawer_id) conditions.push(`ct.source_drawer_id = ${addParam(Number(req.query.source_drawer_id))}`);
  if (req.query.destination_drawer_id) conditions.push(`ct.destination_drawer_id = ${addParam(Number(req.query.destination_drawer_id))}`);
  if (req.query.sender_user_id) conditions.push(`ct.handed_over_by_user_id = ${addParam(req.query.sender_user_id)}`);
  if (req.query.receiver_user_id) conditions.push(`ct.received_by_user_id = ${addParam(req.query.receiver_user_id)}`);
  if (req.query.carrier_user_id) conditions.push(`ct.carrier_user_id = ${addParam(req.query.carrier_user_id)}`);
  if (req.query.q) conditions.push(`ct.transfer_number ILIKE ${addParam(`%${req.query.q}%`)}`);
  if (req.query.from) conditions.push(`ct.handed_over_at >= ${addParam(req.query.from)}`);
  if (req.query.to) conditions.push(`ct.handed_over_at < (${addParam(req.query.to)}::date + INTERVAL '1 day')`);

  const where = conditions.join(" AND ");

  const [countResult, rowsResult] = await Promise.all([
    db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM cash_transfers ct WHERE ${where}`,
      params,
    ),
    db.query(
      `SELECT ct.*,
              sd.name AS source_drawer_name,
              dd.name AS destination_drawer_name,
              sl.name AS source_location_name,
              dl.name AS destination_location_name
         FROM cash_transfers ct
         LEFT JOIN cash_drawers sd ON sd.id = ct.source_drawer_id
         LEFT JOIN cash_drawers dd ON dd.id = ct.destination_drawer_id
         LEFT JOIN locations sl ON sl.id = ct.source_location_id
         LEFT JOIN locations dl ON dl.id = ct.destination_location_id
        WHERE ${where}
        ORDER BY ct.created_at DESC
        LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params,
    ),
  ]);

  const total = parseInt(countResult.rows[0]?.total ?? "0", 10);
  res.json({
    transfers: rowsResult.rows,
    total,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.ceil(total / PAGE_SIZE),
  });
});

// ---------------------------------------------------------------------------
// GET /api/cash-transfers/:transferId
// Full transfer detail with audit events.
// ---------------------------------------------------------------------------
router.get("/cash-transfers/:transferId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash-sessions")) {
    res.status(403).json({ error: "Insufficient permissions to view cash transfers" });
    return;
  }

  const transferId = parseInt(req.params.transferId, 10);
  if (isNaN(transferId)) {
    res.status(400).json({ error: "Invalid transfer id" });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;

  const [transferResult, auditResult] = await Promise.all([
    db.query(
      `SELECT ct.*,
              sd.name AS source_drawer_name,
              dd.name AS destination_drawer_name,
              sl.name AS source_location_name,
              dl.name AS destination_location_name
         FROM cash_transfers ct
         LEFT JOIN cash_drawers sd ON sd.id = ct.source_drawer_id
         LEFT JOIN cash_drawers dd ON dd.id = ct.destination_drawer_id
         LEFT JOIN locations sl ON sl.id = ct.source_location_id
         LEFT JOIN locations dl ON dl.id = ct.destination_location_id
        WHERE ct.id = $1 AND ct.workspace_owner_id = $2`,
      [transferId, ownerId],
    ),
    db.query(
      `SELECT * FROM cash_transfer_audit_events
        WHERE cash_transfer_id = $1
        ORDER BY created_at ASC`,
      [transferId],
    ),
  ]);

  if (transferResult.rowCount === 0) {
    res.status(404).json({ error: "Transfer not found" });
    return;
  }

  res.json({
    transfer: transferResult.rows[0],
    auditEvents: auditResult.rows,
  });
});

// ---------------------------------------------------------------------------
// GET /api/cash-sessions/:id/pending-transfers
// Incoming IN_TRANSIT or DISPUTED transfers for a session's drawer.
// ---------------------------------------------------------------------------
router.get("/cash-sessions/:id/pending-transfers", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash-sessions")) {
    res.status(403).json({ error: "Insufficient permissions to view cash transfers" });
    return;
  }

  const sessionId = parseInt(req.params.id, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid session id" });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;

  const sessionResult = await db.query<{ drawer_id: number }>(
    `SELECT drawer_id FROM cash_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, ownerId],
  );
  if (sessionResult.rowCount === 0) {
    res.status(404).json({ error: "Cash session not found" });
    return;
  }
  const { drawer_id } = sessionResult.rows[0];

  const result = await db.query(
    `SELECT ct.*,
            sd.name AS source_drawer_name,
            sl.name AS source_location_name
       FROM cash_transfers ct
       LEFT JOIN cash_drawers sd ON sd.id = ct.source_drawer_id
       LEFT JOIN locations sl ON sl.id = ct.source_location_id
      WHERE ct.workspace_owner_id = $1
        AND ct.destination_drawer_id = $2
        AND ct.status IN ('IN_TRANSIT', 'DISPUTED')
      ORDER BY ct.created_at DESC`,
    [ownerId, drawer_id],
  );

  res.json({ transfers: result.rows });
});

// ---------------------------------------------------------------------------
// POST /api/cash-transfers/:transferId/confirm-receipt
// Atomically receive the transfer into the destination session.
// ---------------------------------------------------------------------------
router.post("/cash-transfers/:transferId/confirm-receipt", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.receive_transfer")) {
    res.status(403).json({ error: "Insufficient permissions to receive cash transfers" });
    return;
  }

  const transferId = parseInt(req.params.transferId, 10);
  if (isNaN(transferId)) {
    res.status(400).json({ error: "Invalid transfer id" });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;
  const userId = authed(req).userId;
  const actorName = await fetchClerkName(userId);

  // Idempotency: check for existing transfer_in before acquiring a connection
  const transferCheck = await db.query<{
    id: number;
    transfer_number: string;
    status: string;
    destination_drawer_id: number;
    currency_code: string;
    sent_amount: string;
    source_session_id: number | null;
    initiated_by_user_id: string | null;
    version: number;
  }>(
    `SELECT id, transfer_number, status, destination_drawer_id, currency_code,
            sent_amount, source_session_id, initiated_by_user_id, version
       FROM cash_transfers WHERE id = $1 AND workspace_owner_id = $2`,
    [transferId, ownerId],
  );
  if (transferCheck.rowCount === 0) {
    res.status(404).json({ error: "Transfer not found" });
    return;
  }
  const transfer = transferCheck.rows[0];

  if (transfer.status === "COMPLETED") {
    // Already completed — idempotent success
    const full = await db.query(`SELECT * FROM cash_transfers WHERE id = $1`, [transferId]);
    res.json({ transfer: full.rows[0], idempotent: true });
    return;
  }
  if (transfer.status !== "IN_TRANSIT") {
    res.status(409).json({ error: `Transfer is ${transfer.status}, not IN_TRANSIT` });
    return;
  }

  // Check idempotency via existing transfer_in transaction
  const existingTxn = await db.query(
    `SELECT id FROM cash_transactions
      WHERE workspace_owner_id = $1
        AND reference_type = 'cash_transfer'
        AND reference_id = $2
        AND type = 'transfer_in'`,
    [ownerId, transfer.transfer_number],
  );
  if (existingTxn.rowCount && existingTxn.rowCount > 0) {
    const full = await db.query(`SELECT * FROM cash_transfers WHERE id = $1`, [transferId]);
    res.json({ transfer: full.rows[0], idempotent: true });
    return;
  }

  let updatedTransfer: Record<string, unknown> = {};

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // Lock transfer row for update (optimistic-lock version check)
      const lockCheck = await client.query<{ version: number }>(
        `SELECT version FROM cash_transfers
          WHERE id = $1 AND workspace_owner_id = $2 AND status = 'IN_TRANSIT'
          FOR UPDATE`,
        [transferId, ownerId],
      );
      if (lockCheck.rowCount === 0) {
        throw Object.assign(new Error("Transfer is no longer IN_TRANSIT"), { statusCode: 409 });
      }

      // Find and lock the open destination session
      const destSessionResult = await client.query<{ id: number; location_id: number | null }>(
        `SELECT id, location_id FROM cash_sessions
          WHERE drawer_id = $1 AND workspace_owner_id = $2 AND status = 'open'
          ORDER BY opened_at DESC LIMIT 1
          FOR UPDATE`,
        [transfer.destination_drawer_id, ownerId],
      );
      if (destSessionResult.rowCount === 0) {
        throw Object.assign(
          new Error("No open session found for the destination drawer. Please open a session first."),
          { statusCode: 422 },
        );
      }
      const destSession = destSessionResult.rows[0];

      // Insert destination transfer_in transaction
      await client.query(
        `INSERT INTO cash_transactions (
           workspace_owner_id, cash_session_id, cash_drawer_id, location_id,
           currency, type, direction, amount,
           description, reference_type, reference_id, created_by_clerk_id
         ) VALUES ($1, $2, $3, $4, $5, 'transfer_in', 'in', $6, $7, 'cash_transfer', $8, $9)`,
        [
          ownerId,
          destSession.id,
          transfer.destination_drawer_id,
          destSession.location_id,
          transfer.currency_code,
          transfer.sent_amount,
          `Cash transfer in — ${transfer.transfer_number}`,
          transfer.transfer_number,
          userId,
        ],
      );

      // Recompute destination session totals (same transaction client sees the new row)
      await recomputeSessionTotals(destSession.id, ownerId, client);

      // Mark transfer COMPLETED
      const updated = await client.query(
        `UPDATE cash_transfers
            SET status               = 'COMPLETED',
                destination_session_id = $3,
                received_amount      = sent_amount,
                difference_amount    = 0,
                received_by_user_id  = $4,
                received_at          = now(),
                version              = version + 1,
                updated_at           = now()
          WHERE id = $1 AND workspace_owner_id = $2
          RETURNING *`,
        [transferId, ownerId, destSession.id, userId],
      );
      updatedTransfer = updated.rows[0] as Record<string, unknown>;

      await client.query(
        `INSERT INTO cash_transfer_audit_events
           (workspace_owner_id, cash_transfer_id, event_type, actor_user_id, actor_name, payload)
         VALUES ($1, $2, 'received', $3, $4, $5)`,
        [
          ownerId,
          transferId,
          userId,
          actorName,
          JSON.stringify({
            destinationSessionId: destSession.id,
            receivedAmount: transfer.sent_amount,
          }),
        ],
      );
    });
  } catch (err: unknown) {
    client.release();
    const statusCode =
      err !== null && typeof err === "object" && "statusCode" in err
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message = err instanceof Error ? err.message : "Failed to confirm receipt";
    res.status(statusCode).json({ error: message });
    return;
  }
  client.release();

  // Notify source agent (post-commit)
  if (transfer.initiated_by_user_id) {
    broadcastEvent(ownerId, {
      event: "cash_transfer.completed",
      workspaceId: ownerId,
      data: { transferNumber: transfer.transfer_number, receivedByUserId: userId },
    });
  }

  res.json({ transfer: updatedTransfer });
});

// ---------------------------------------------------------------------------
// POST /api/cash-transfers/:transferId/report-difference
// Receiver reports a discrepancy; sets status to DISPUTED.
// ---------------------------------------------------------------------------
router.post("/cash-transfers/:transferId/report-difference", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.receive_transfer")) {
    res.status(403).json({ error: "Insufficient permissions to report a transfer difference" });
    return;
  }

  const transferId = parseInt(req.params.transferId, 10);
  if (isNaN(transferId)) {
    res.status(400).json({ error: "Invalid transfer id" });
    return;
  }

  const { actual_received_amount, explanation } = req.body ?? {};
  const actualAmt = Number(actual_received_amount);
  if (!Number.isFinite(actualAmt) || actualAmt < 0) {
    res.status(400).json({ error: "actual_received_amount must be a non-negative number" });
    return;
  }
  if (!explanation || !String(explanation).trim()) {
    res.status(400).json({ error: "explanation is required when reporting a difference" });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;
  const userId = authed(req).userId;
  const actorName = await fetchClerkName(userId);

  const transferResult = await db.query<{
    id: number;
    status: string;
    sent_amount: string;
    transfer_number: string;
    version: number;
  }>(
    `SELECT id, status, sent_amount, transfer_number, version
       FROM cash_transfers WHERE id = $1 AND workspace_owner_id = $2`,
    [transferId, ownerId],
  );
  if (transferResult.rowCount === 0) {
    res.status(404).json({ error: "Transfer not found" });
    return;
  }
  const transfer = transferResult.rows[0];

  if (transfer.status !== "IN_TRANSIT") {
    res.status(409).json({ error: `Cannot report a difference on a ${transfer.status} transfer` });
    return;
  }

  const differenceAmt = actualAmt - Number(transfer.sent_amount);

  let updatedTransfer: Record<string, unknown> = {};

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const lockCheck = await client.query(
        `SELECT version FROM cash_transfers
          WHERE id = $1 AND workspace_owner_id = $2 AND version = $3
          FOR UPDATE`,
        [transferId, ownerId, transfer.version],
      );
      if (lockCheck.rowCount === 0) {
        throw Object.assign(new Error("Transfer was concurrently modified"), { code: "40001" });
      }

      const updated = await client.query(
        `UPDATE cash_transfers
            SET status                 = 'DISPUTED',
                actual_received_amount = $3,
                difference_amount      = $4,
                dispute_explanation    = $5,
                disputed_at            = now(),
                version                = version + 1,
                updated_at             = now()
          WHERE id = $1 AND workspace_owner_id = $2
          RETURNING *`,
        [
          transferId,
          ownerId,
          actualAmt.toFixed(2),
          differenceAmt.toFixed(2),
          String(explanation).trim(),
        ],
      );
      updatedTransfer = updated.rows[0] as Record<string, unknown>;

      await client.query(
        `INSERT INTO cash_transfer_audit_events
           (workspace_owner_id, cash_transfer_id, event_type, actor_user_id, actor_name, payload)
         VALUES ($1, $2, 'disputed', $3, $4, $5)`,
        [
          ownerId,
          transferId,
          userId,
          actorName,
          JSON.stringify({
            actualReceivedAmount: actualAmt,
            differenceAmount: differenceAmt,
            explanation: String(explanation).trim(),
          }),
        ],
      );
    });
  } catch (err: unknown) {
    client.release();
    const code =
      err !== null && typeof err === "object" && "code" in err
        ? (err as { code: string }).code
        : null;
    const statusCode =
      code === "40001" || code === "40P01"
        ? 409
        : err !== null && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : 500;
    const message =
      err instanceof Error ? err.message : "Failed to report difference";
    res.status(statusCode).json({ error: message });
    return;
  }
  client.release();

  broadcastEvent(ownerId, {
    event: "cash_transfer.disputed",
    workspaceId: ownerId,
    data: {
      transferNumber: transfer.transfer_number,
      differenceAmount: differenceAmt,
      reportedByUserId: userId,
    },
  });

  res.json({ transfer: updatedTransfer });
});

// ---------------------------------------------------------------------------
// POST /api/cash-transfers/:transferId/resolve-dispute
// Supervisor resolves a DISPUTED transfer.
// ---------------------------------------------------------------------------
router.post("/cash-transfers/:transferId/resolve-dispute", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "cash_sessions.resolve_transfer_dispute")) {
    res.status(403).json({ error: "Insufficient permissions to resolve transfer disputes" });
    return;
  }

  const transferId = parseInt(req.params.transferId, 10);
  if (isNaN(transferId)) {
    res.status(400).json({ error: "Invalid transfer id" });
    return;
  }

  const { resolution_reason, resolution_note, received_amount } = req.body ?? {};
  if (!resolution_reason || !String(resolution_reason).trim()) {
    res.status(400).json({ error: "resolution_reason is required" });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;
  const userId = authed(req).userId;
  const actorName = await fetchClerkName(userId);

  const transferResult = await db.query<{
    id: number;
    status: string;
    transfer_number: string;
    currency_code: string;
    sent_amount: string;
    actual_received_amount: string | null;
    destination_drawer_id: number;
    version: number;
    initiated_by_user_id: string | null;
  }>(
    `SELECT id, status, transfer_number, currency_code, sent_amount,
            actual_received_amount, destination_drawer_id, version, initiated_by_user_id
       FROM cash_transfers WHERE id = $1 AND workspace_owner_id = $2`,
    [transferId, ownerId],
  );
  if (transferResult.rowCount === 0) {
    res.status(404).json({ error: "Transfer not found" });
    return;
  }
  const transfer = transferResult.rows[0];

  if (transfer.status !== "DISPUTED") {
    res.status(409).json({ error: `Transfer is ${transfer.status}, not DISPUTED` });
    return;
  }

  const physicalAmount =
    received_amount != null
      ? Number(received_amount)
      : Number(transfer.actual_received_amount ?? transfer.sent_amount);
  if (!Number.isFinite(physicalAmount) || physicalAmount < 0) {
    res.status(400).json({ error: "received_amount must be a non-negative number" });
    return;
  }

  let updatedTransfer: Record<string, unknown> = {};

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // Lock transfer row
      const lockCheck = await client.query(
        `SELECT version FROM cash_transfers
          WHERE id = $1 AND workspace_owner_id = $2 AND status = 'DISPUTED'
          FOR UPDATE`,
        [transferId, ownerId],
      );
      if (lockCheck.rowCount === 0) {
        throw Object.assign(new Error("Transfer is no longer DISPUTED"), { statusCode: 409 });
      }

      // Find and lock the open destination session (if available)
      const destSessionResult = await client.query<{ id: number; location_id: number | null }>(
        `SELECT id, location_id FROM cash_sessions
          WHERE drawer_id = $1 AND workspace_owner_id = $2 AND status = 'open'
          ORDER BY opened_at DESC LIMIT 1
          FOR UPDATE`,
        [transfer.destination_drawer_id, ownerId],
      );

      if (!destSessionResult.rowCount || destSessionResult.rowCount === 0) {
        throw Object.assign(
          new Error(
            "No open session found for the destination drawer. Please ensure the destination drawer has an open session before resolving the dispute.",
          ),
          { statusCode: 422 },
        );
      }

      const destSession = destSessionResult.rows[0];
      const destSessionId: number = destSession.id;

      {
        // Only post transfer_in if not already posted
        const existingTxn = await client.query(
          `SELECT id FROM cash_transactions
            WHERE workspace_owner_id = $1
              AND reference_type = 'cash_transfer'
              AND reference_id = $2
              AND type = 'transfer_in'`,
          [ownerId, transfer.transfer_number],
        );
        if (!existingTxn.rowCount || existingTxn.rowCount === 0) {
          await client.query(
            `INSERT INTO cash_transactions (
               workspace_owner_id, cash_session_id, cash_drawer_id, location_id,
               currency, type, direction, amount,
               description, reference_type, reference_id, created_by_clerk_id
             ) VALUES ($1, $2, $3, $4, $5, 'transfer_in', 'in', $6, $7, 'cash_transfer', $8, $9)`,
            [
              ownerId,
              destSession.id,
              transfer.destination_drawer_id,
              destSession.location_id,
              transfer.currency_code,
              physicalAmount.toFixed(2),
              `Cash transfer in (resolved) — ${transfer.transfer_number}`,
              transfer.transfer_number,
              userId,
            ],
          );
          // Recompute destination session totals (same transaction client sees the new row)
          await recomputeSessionTotals(destSession.id, ownerId, client);
        }
      }

      const updated = await client.query(
        `UPDATE cash_transfers
            SET status                 = 'COMPLETED',
                received_amount        = $3,
                difference_amount      = $3::numeric - sent_amount::numeric,
                destination_session_id = COALESCE(destination_session_id, $4),
                resolved_by_user_id    = $5,
                resolution_reason      = $6,
                resolution_note        = $7,
                resolved_at            = now(),
                received_at            = COALESCE(received_at, now()),
                version                = version + 1,
                updated_at             = now()
          WHERE id = $1 AND workspace_owner_id = $2
          RETURNING *`,
        [
          transferId,
          ownerId,
          physicalAmount.toFixed(2),
          destSessionId,
          userId,
          String(resolution_reason).trim(),
          resolution_note ? String(resolution_note).trim() : null,
        ],
      );
      updatedTransfer = updated.rows[0] as Record<string, unknown>;

      await client.query(
        `INSERT INTO cash_transfer_audit_events
           (workspace_owner_id, cash_transfer_id, event_type, actor_user_id, actor_name, payload)
         VALUES ($1, $2, 'dispute_resolved', $3, $4, $5)`,
        [
          ownerId,
          transferId,
          userId,
          actorName,
          JSON.stringify({
            receivedAmount: physicalAmount,
            resolutionReason: String(resolution_reason).trim(),
          }),
        ],
      );
    });
  } catch (err: unknown) {
    client.release();
    const statusCode =
      err !== null && typeof err === "object" && "statusCode" in err
        ? (err as { statusCode: number }).statusCode
        : 500;
    const message = err instanceof Error ? err.message : "Failed to resolve dispute";
    res.status(statusCode).json({ error: message });
    return;
  }
  client.release();

  if (transfer.initiated_by_user_id) {
    broadcastEvent(ownerId, {
      event: "cash_transfer.dispute_resolved",
      workspaceId: ownerId,
      data: {
        transferNumber: transfer.transfer_number,
        resolvedByUserId: userId,
      },
    });
  }

  res.json({ transfer: updatedTransfer });
});

export default router;

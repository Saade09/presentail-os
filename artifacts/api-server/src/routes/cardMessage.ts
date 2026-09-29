import { Router } from "express";
import { z } from "zod/v4";
import { clerkClient } from "@clerk/express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, hasPageAccess, type WorkspaceRequest } from "../lib/workspace";
import { logger } from "../lib/logger";
import { normalizePrintableQrLink } from "../lib/giftCardPdf";

const router = Router();

router.use(requireAuth, resolveWorkspace);

type BranchPrintConfigRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  machine_id: string;
  printer_id: string;
  created_at: string;
  updated_at: string;
};

function isOwner(wreq: WorkspaceRequest): boolean {
  return wreq.workspaceActualRole === "owner";
}

/**
 * Subset of shops for which the To/From (sender/receiver) fields should be shown.
 * Populated from the CARD_PRINT_PRESENTAIL_SHOPS env var (comma-separated).
 * For Presentail-owned shops, staff typically fill in sender/receiver names.
 * Example: "Presentail"
 */
const PRESENTAIL_SHOPS: Set<string> = new Set(
  (process.env.CARD_PRINT_PRESENTAIL_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/**
 * Make.com webhook URL for card printing.
 * Never sent to the frontend.
 */
const MAKE_WEBHOOK_URL = process.env.CARD_PRINT_MAKE_WEBHOOK_URL ?? "";

// Cake printing is separate from card printing: no branch printer configuration
// or card-print audit/unlock is involved.
const CAKE_WEBHOOK_URL = process.env.CAKE_PRINT_MAKE_WEBHOOK_URL ?? "";
const cakePrintSchema = z.object({
  location: z.enum(["Achrafieh", "Jdeideh"]),
  cakeMessage: z.string().trim().min(1, "Cake message is required"),
  floristOrderId: z.string().uuid().optional(),
  realOrderId: z.string().uuid().optional(),
}).refine((value) => !(value.realOrderId && value.floristOrderId), {
  message: "Select one order source",
});

router.post("/card-message/print-cake", async (req, res) => {
  const wreq = workspace(req);
  const parsed = cakePrintSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_cake_print", message: "Select Achrafieh or Jdeideh and enter a cake message.", details: parsed.error.issues });
    return;
  }
  let { location, cakeMessage } = parsed.data;
  if (!parsed.data.realOrderId && !parsed.data.floristOrderId && !hasPageAccess(wreq, "card-message")) {
    res.status(403).json({ error: "forbidden", message: "You do not have access to print cake messages manually." });
    return;
  }
  if (parsed.data.realOrderId) {
    if (!hasPageAccess(wreq, "orders")) {
      res.status(403).json({ error: "forbidden", message: "You do not have access to this order." });
      return;
    }
    const result = await db.query<{ cake_message: string | null }>(
      `SELECT (SELECT btrim(oli.custom_input) FROM order_line_items oli
                 WHERE oli.order_id = o.id AND oli.name ILIKE '%cake%'
                   AND NULLIF(btrim(oli.custom_input), '') IS NOT NULL
                 ORDER BY oli.id LIMIT 1) AS cake_message
         FROM orders o
        WHERE o.id = $1 AND o.workspace_owner_id = $2`,
      [parsed.data.realOrderId, wreq.workspaceOwnerId],
    );
    if (!result.rows[0]?.cake_message) {
      res.status(400).json({ error: "no_cake_message", message: "This order has no printable cake message." });
      return;
    }
    cakeMessage = result.rows[0].cake_message;
  }
  if (parsed.data.floristOrderId) {
    if (!hasPageAccess(wreq, "florist_orders")) {
      res.status(403).json({ error: "forbidden", message: "You do not have access to florist orders." });
      return;
    }
    const assignment = await db.query<{ location_name: string; cake_message: string | null }>(
      `SELECT l.name AS location_name,
              (SELECT btrim(oli.custom_input) FROM order_line_items oli
                WHERE oli.order_id = ofa.order_id AND oli.name ILIKE '%cake%'
                  AND NULLIF(btrim(oli.custom_input), '') IS NOT NULL
                ORDER BY oli.id LIMIT 1) AS cake_message
         FROM order_florist_assignments ofa
         JOIN locations l ON l.id = ofa.location_id AND l.workspace_owner_id = ofa.workspace_owner_id
        WHERE ofa.order_id = $1 AND ofa.workspace_owner_id = $2
          AND ($3::int IS NULL OR ofa.location_id = $3)
        LIMIT 1`,
      [parsed.data.floristOrderId, wreq.workspaceOwnerId,
        wreq.workspaceRole === "owner" ? null : wreq.memberDbId == null ? -1 : (
          await db.query<{ florist_location_id: number | null }>(
            `SELECT florist_location_id FROM workspace_members WHERE id = $1 AND workspace_owner_id = $2`,
            [wreq.memberDbId, wreq.workspaceOwnerId],
          )
        ).rows[0]?.florist_location_id ?? -1],
    );
    const row = assignment.rows[0];
    if (!row) {
      res.status(404).json({ error: "not_found", message: "Florist order not found." });
      return;
    }
    if (row.location_name !== "Achrafieh" && row.location_name !== "Jdeideh") {
      res.status(400).json({ error: "invalid_location", message: "Cake printing is only available in Achrafieh or Jdeideh." });
      return;
    }
    if (!row.cake_message) {
      res.status(400).json({ error: "no_cake_message", message: "This order has no cake message to print." });
      return;
    }
    location = row.location_name;
    cakeMessage = row.cake_message;
  }
  if (!CAKE_WEBHOOK_URL) {
    logger.warn("card-message/print-cake: CAKE_PRINT_MAKE_WEBHOOK_URL is not set");
    res.status(502).json({ error: "webhook_not_configured", message: "Cake print webhook is not configured." });
    return;
  }
  try {
    const response = await fetch(CAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Cake_Message: cakeMessage, Location: location }),
    });
    if (!response.ok) {
      logger.error({ status: response.status }, "card-message/print-cake: webhook rejected request");
      res.status(502).json({ error: "webhook_error", message: "Failed to send cake message to printer." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "card-message/print-cake: webhook request failed");
    res.status(502).json({ error: "webhook_error", message: "Failed to send cake message to printer." });
  }
});

// ---------------------------------------------------------------------------
// GET /card-message/config
// Returns form configuration (available shops and per-shop feature flags).
// Shops are the workspace's brands (standalone brands table), alphabetical.
// ---------------------------------------------------------------------------
router.get("/card-message/config", async (req, res) => {
  const wreq = workspace(req);
  const result = await db.query<{ name: string }>(
    `SELECT name FROM brands WHERE workspace_owner_id = $1 ORDER BY name ASC`,
    [wreq.workspaceOwnerId],
  );
  res.json({
    shops: result.rows.map((r) => r.name),
    presentailShops: [...PRESENTAIL_SHOPS],
  });
});

// ---------------------------------------------------------------------------
// Branch print config CRUD (owner only).
// Maps a branch/shop name to the Make.com machineId + printerId pair.
// ---------------------------------------------------------------------------

// GET /card-message/branch-configs — list workspace branch print configs.
// Any workspace member can read the list (needed by the Order Detail print dialog).
// Write operations (POST/PATCH/DELETE) remain owner-only.
router.get("/card-message/branch-configs", async (req, res) => {
  const wreq = workspace(req);
  const result = await db.query<BranchPrintConfigRow>(
    `SELECT * FROM branch_print_configs WHERE workspace_owner_id = $1 ORDER BY name ASC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ configs: result.rows });
});

const branchConfigBodySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  machineId: z.string().trim().min(1, "Machine ID is required").max(200),
  printerId: z.string().trim().min(1, "Printer ID is required").max(200),
});

// POST /card-message/branch-configs — create a branch print config.
router.post("/card-message/branch-configs", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Only the workspace owner can manage branch printers" });
    return;
  }
  const parsed = branchConfigBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const { name, machineId, printerId } = parsed.data;

  try {
    const result = await db.query<BranchPrintConfigRow>(
      `INSERT INTO branch_print_configs (workspace_owner_id, name, machine_id, printer_id)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [wreq.workspaceOwnerId, name, machineId, printerId],
    );
    res.status(201).json({ config: result.rows[0] });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A branch with this name already exists." });
      return;
    }
    throw err;
  }
});

// PATCH /card-message/branch-configs/:id — update a branch print config.
router.patch("/card-message/branch-configs/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Only the workspace owner can manage branch printers" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid config id" });
    return;
  }
  const parsed = branchConfigBodySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const { name, machineId, printerId } = parsed.data;
  if (name === undefined && machineId === undefined && printerId === undefined) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id, wreq.workspaceOwnerId];
  if (name !== undefined) {
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (machineId !== undefined) {
    params.push(machineId);
    sets.push(`machine_id = $${params.length}`);
  }
  if (printerId !== undefined) {
    params.push(printerId);
    sets.push(`printer_id = $${params.length}`);
  }

  try {
    const result = await db.query<BranchPrintConfigRow>(
      `UPDATE branch_print_configs
          SET ${sets.join(", ")}
        WHERE id = $1 AND workspace_owner_id = $2
        RETURNING *`,
      params,
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Branch print config not found" });
      return;
    }
    res.json({ config: result.rows[0] });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A branch with this name already exists." });
      return;
    }
    throw err;
  }
});

// DELETE /card-message/branch-configs/:id — remove a branch print config.
router.delete("/card-message/branch-configs/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Only the workspace owner can manage branch printers" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid config id" });
    return;
  }
  const result = await db.query(
    `DELETE FROM branch_print_configs WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Branch print config not found" });
    return;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /card-message/print
// Validates the body, resolves the printer config by location from the
// database, and proxies to Make.com.
// ---------------------------------------------------------------------------
const printBodySchema = z.object({
  location: z.string().min(1, "Location is required"),
  shopName: z.string().min(1, "Shop name is required"),
  orderId: z.string().min(1, "Order ID is required"),
  cardMessage: z.string().min(1, "Card message is required"),
  toName: z.string().optional(),
  fromName: z.string().optional(),
  realOrderId: z.string().uuid().optional(),
  additionalCardMessageId: z.string().uuid().optional(),
  qrLink: z.string().optional(),
}).refine(
  (value) => !value.additionalCardMessageId || !!value.realOrderId,
  { message: "Additional card message requires an order ID", path: ["realOrderId"] },
);

router.post("/card-message/print", async (req, res) => {
  const wreq = workspace(req);
  const parsed = printBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { location, shopName, realOrderId, additionalCardMessageId } = parsed.data;
  let { orderId, cardMessage, toName, fromName, qrLink } = parsed.data;

  // When the print unlocks the florist verification gate (realOrderId given),
  // the printed payload is NOT trusted from the client: it is rebuilt from the
  // persisted order card fields, and the caller must be authorized for the
  // assignment's florist location. Otherwise any workspace member could forge
  // a print payload for another order and falsify its card-printed audit state.
  let gateLocationId: number | null = null;
  if (additionalCardMessageId && realOrderId) {
    if (!hasPageAccess(wreq, "orders")) {
      res.status(403).json({ error: "forbidden", message: "You do not have access to print this order's card." });
      return;
    }
    const extra = await db.query<{
      card_message: string;
      card_to: string | null;
      card_from: string | null;
      qr_link: string | null;
      order_number: string;
    }>(
      `SELECT cm.card_message, cm.card_to, cm.card_from, cm.qr_link,
              COALESCE(o.display_order_number, o.external_order_id, o.id::text) AS order_number
         FROM order_card_messages cm
         JOIN orders o ON o.id = cm.order_id
        WHERE cm.id = $1 AND cm.order_id = $2
          AND cm.workspace_owner_id = $3 AND o.workspace_owner_id = $3
        LIMIT 1`,
      [additionalCardMessageId, realOrderId, wreq.workspaceOwnerId],
    );
    const row = extra.rows[0];
    if (!row) {
      res.status(404).json({ error: "not_found", message: "Card message not found" });
      return;
    }
    orderId = row.order_number;
    cardMessage = row.card_message;
    toName = row.card_to ?? undefined;
    fromName = row.card_from ?? undefined;
    qrLink = row.qr_link ?? undefined;
  }
  else if (realOrderId) {
    if (!hasPageAccess(wreq, "florist_orders") && !hasPageAccess(wreq, "orders")) {
      res.status(403).json({ error: "forbidden", message: "You do not have access to print this order's card." });
      return;
    }
    const gate = await db.query<{
      location_id: number;
      card_message: string | null;
      card_to: string | null;
      card_from: string | null;
      qr_link: string | null;
      order_number: string;
    }>(
      `SELECT ofa.location_id, o.card_message, o.card_to, o.card_from, o.qr_link,
              COALESCE(o.display_order_number, o.external_order_id, o.id::text) AS order_number
         FROM order_florist_assignments ofa
         JOIN orders o ON o.id = ofa.order_id
        WHERE ofa.order_id = $1 AND ofa.workspace_owner_id = $2
        LIMIT 1`,
      [realOrderId, wreq.workspaceOwnerId],
    );
    const row = gate.rows[0];
    if (!row) {
      res.status(404).json({ error: "not_found", message: "Florist order not found" });
      return;
    }
    // Members restricted to a florist location may only unlock assignments at
    // that location (owners and unrestricted members may print for any).
    if (wreq.workspaceRole !== "owner" && wreq.memberDbId != null) {
      const member = await db.query<{ florist_location_id: number | null }>(
        `SELECT florist_location_id FROM workspace_members
          WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
        [wreq.memberDbId, wreq.workspaceOwnerId],
      );
      const memberLocationId = member.rows[0]?.florist_location_id ?? null;
      if (memberLocationId != null && memberLocationId !== row.location_id) {
        res.status(404).json({ error: "not_found", message: "Florist order not found" });
        return;
      }
    }
    // Shared printable-card predicate: a card is printable only when the
    // message is non-null and trimmed non-empty — the same definition the
    // florist queue's has_card flag and the completion gate use.
    if (!row.card_message || !row.card_message.trim()) {
      res.status(400).json({
        error: "no_card_message",
        message: "This order has no card message to print.",
      });
      return;
    }
    // Server-derived payload — client-sent card fields are ignored.
    gateLocationId = row.location_id;
    orderId = row.order_number;
    cardMessage = row.card_message;
    toName = row.card_to ?? undefined;
    fromName = row.card_from ?? undefined;
    qrLink = row.qr_link ?? undefined;
  }

  // Config is keyed by branch name. Machine/printer IDs are never exposed to
  // the frontend from this route.
  const configResult = await db.query<Pick<BranchPrintConfigRow, "machine_id" | "printer_id">>(
    `SELECT machine_id, printer_id FROM branch_print_configs
      WHERE workspace_owner_id = $1 AND name = $2`,
    [wreq.workspaceOwnerId, location],
  );
  const printerConfig = configResult.rows[0];
  if (!printerConfig) {
    res.status(400).json({
      error: "no_printer_configured",
      message: "No printer configured for this branch.",
    });
    return;
  }

  if (!MAKE_WEBHOOK_URL) {
    logger.warn(
      { workspaceOwnerId: wreq.workspaceOwnerId },
      "card-message/print: CARD_PRINT_MAKE_WEBHOOK_URL is not set",
    );
    res.status(502).json({
      error: "webhook_not_configured",
      message: "Card print webhook is not configured.",
    });
    return;
  }

  logger.info(
    {
      workspaceOwnerId: wreq.workspaceOwnerId,
      userId: wreq.userId,
      location,
      shopName,
      orderId,
      machineId: printerConfig.machine_id,
      printerId: printerConfig.printer_id,
    },
    "card-message/print: attempting card print",
  );

  const isPresentailShop = PRESENTAIL_SHOPS.has(shopName);
  const printableQrLink = normalizePrintableQrLink(qrLink);
  const payload = [
    {
      Location: location,
      "Shop Name": shopName,
      "Order ID": orderId,
      "Card Message": cardMessage,
      receiverName: toName ?? "",
      senderName: fromName ?? "",
      Source: "Presentail Dashboard",
      machineId: printerConfig.machine_id,
      printerId: printerConfig.printer_id,
      ...(printableQrLink ? { "QR code": printableQrLink } : {}),
    },
  ];

  try {
    const webhookRes = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!webhookRes.ok) {
      const body = await webhookRes.text().catch(() => "");
      logger.error(
        {
          workspaceOwnerId: wreq.workspaceOwnerId,
          orderId,
          status: webhookRes.status,
          body,
        },
        "card-message/print: Make.com webhook returned non-2xx",
      );
      res.status(502).json({ error: "webhook_error", message: "Failed to send card to printer." });
      return;
    }

    // Log the print event. Look up the user's display name from Clerk.
    let userDisplayName = wreq.userId;
    try {
      const user = await clerkClient.users.getUser(wreq.userId);
      const firstName = user.firstName ?? "";
      const lastName = user.lastName ?? "";
      userDisplayName = `${firstName} ${lastName}`.trim() || (user.emailAddresses[0]?.emailAddress ?? wreq.userId);
    } catch {
      // Non-fatal — fall back to userId
    }
    await db.query(
      `INSERT INTO card_print_logs
         (workspace_owner_id, order_id, real_order_id, user_id, user_display_name, location, shop_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        wreq.workspaceOwnerId,
        orderId,
        realOrderId ?? null,
        wreq.userId,
        userDisplayName,
        location,
        shopName,
      ],
    );

    // Record the durable card-printed unlock for the florist photo
    // verification workflow (survives page refresh; gates florist Complete).
    if (realOrderId && gateLocationId != null) {
      // Conditioned on the location that was authorized above: if the order
      // was reassigned to another location while the print webhook was in
      // flight, the replacement assignment must NOT inherit the unlock.
      await db.query(
        `UPDATE order_florist_assignments
            SET card_printed_at = now(), updated_at = now()
          WHERE order_id = $1 AND workspace_owner_id = $2 AND location_id = $3`,
        [realOrderId, wreq.workspaceOwnerId, gateLocationId],
      );
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error(
      { err, workspaceOwnerId: wreq.workspaceOwnerId, orderId },
      "card-message/print: fetch to Make.com failed",
    );
    res.status(502).json({ error: "webhook_error", message: "Failed to send card to printer." });
  }
});

// ---------------------------------------------------------------------------
// GET /card-message/order-print-logs/:orderId
// Returns card print history for an order (by real UUID), newest first.
// ---------------------------------------------------------------------------
router.get("/card-message/order-print-logs/:orderId", async (req, res) => {
  const wreq = workspace(req);
  const { orderId } = req.params;
  const result = await db.query<{
    id: string;
    order_id: string;
    real_order_id: string | null;
    user_id: string;
    user_display_name: string;
    location: string;
    shop_name: string;
    printed_at: string;
  }>(
    `SELECT id, order_id, real_order_id, user_id, user_display_name, location, shop_name, printed_at
       FROM card_print_logs
      WHERE real_order_id = $1 AND workspace_owner_id = $2
      ORDER BY printed_at DESC`,
    [orderId, wreq.workspaceOwnerId],
  );
  res.json({ logs: result.rows });
});

export default router;

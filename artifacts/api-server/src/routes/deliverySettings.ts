import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { requireApiKey } from "../lib/apiKeyAuth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { broadcastEvent } from "../lib/eventsSse";

const router = Router();

function requireAuthOrApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = (req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer pk_live_")) {
    requireApiKey(req, res, next);
    return;
  }
  requireAuth(req, res, next);
}

type DeliverySettingsRow = {
  workspace_owner_id: string;
  standard_delivery_active: boolean;
  express_delivery_active: boolean;
  same_day_express_active: boolean;
  global_standard_fee: string | null;
  global_express_fee: string | null;
  global_free_delivery_threshold: string | null;
  global_express_free_threshold: string | null;
  updated_at: string;
};

async function ensureSettingsRow(ownerId: string): Promise<DeliverySettingsRow> {
  const r = await db.query<DeliverySettingsRow>(
    `INSERT INTO delivery_settings (workspace_owner_id)
     VALUES ($1)
     ON CONFLICT (workspace_owner_id) DO NOTHING
     RETURNING *`,
    [ownerId],
  );
  if (r.rowCount && r.rowCount > 0) return r.rows[0];
  const sel = await db.query<DeliverySettingsRow>(
    `SELECT * FROM delivery_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  return sel.rows[0];
}

const PatchSchema = z.object({
  standard_delivery_active: z.boolean().optional(),
  express_delivery_active: z.boolean().optional(),
  same_day_express_active: z.boolean().optional(),
  global_standard_fee: z.number().min(0).nullable().optional(),
  global_express_fee: z.number().min(0).nullable().optional(),
  global_free_delivery_threshold: z.number().min(0).nullable().optional(),
  global_express_free_threshold: z.number().min(0).nullable().optional(),
});

/**
 * GET /api/settings/delivery
 * Returns global delivery settings. Owner or API key.
 */
router.get(
  "/settings/delivery",
  requireAuthOrApiKey,
  resolveWorkspace,
  async (req, res) => {
    const wreq = workspace(req);
    const settings = await ensureSettingsRow(wreq.workspaceOwnerId);
    res.json({ success: true, data: settings });
  },
);

/**
 * PATCH /api/settings/delivery
 * Partially updates global delivery settings. Owner only.
 */
router.patch(
  "/settings/delivery",
  requireAuth,
  resolveWorkspace,
  async (req, res) => {
    const wreq = workspace(req);
    if (wreq.workspaceRole !== "owner") {
      res.status(403).json({ success: false, error: "Only owners may update delivery settings" });
      return;
    }

    const parsed = PatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }

    const d = parsed.data;
    const setClauses: string[] = ["updated_at = now()"];
    const params: unknown[] = [];

    const addSet = (col: string, val: unknown) => {
      params.push(val);
      setClauses.push(`${col} = $${params.length}`);
    };

    if (d.standard_delivery_active !== undefined) addSet("standard_delivery_active", d.standard_delivery_active);
    if (d.express_delivery_active !== undefined) addSet("express_delivery_active", d.express_delivery_active);
    if (d.same_day_express_active !== undefined) addSet("same_day_express_active", d.same_day_express_active);
    if ("global_standard_fee" in d) addSet("global_standard_fee", d.global_standard_fee ?? null);
    if ("global_express_fee" in d) addSet("global_express_fee", d.global_express_fee ?? null);
    if ("global_free_delivery_threshold" in d) addSet("global_free_delivery_threshold", d.global_free_delivery_threshold ?? null);
    if ("global_express_free_threshold" in d) addSet("global_express_free_threshold", d.global_express_free_threshold ?? null);

    if (setClauses.length <= 1) {
      res.status(400).json({ success: false, error: "No fields to update" });
      return;
    }

    await ensureSettingsRow(wreq.workspaceOwnerId);
    params.push(wreq.workspaceOwnerId);

    const r = await db.query<DeliverySettingsRow>(
      `UPDATE delivery_settings SET ${setClauses.join(", ")} WHERE workspace_owner_id = $${params.length} RETURNING *`,
      params,
    );

    const updated = r.rows[0];
    broadcastEvent(wreq.workspaceOwnerId, { event: "delivery_settings.updated", workspaceId: wreq.workspaceOwnerId, data: updated as unknown as Record<string, unknown> });
    res.json({ success: true, data: updated });
  },
);

export default router;

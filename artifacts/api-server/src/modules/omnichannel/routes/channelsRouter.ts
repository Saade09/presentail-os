import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { encrypt, isEncrypted } from "../../../lib/credentialEncryption";
import { requireOmnichannelRole } from "../omnichannelAuth";
import { getMockAdapter, loadAdapterRegistry } from "../adapters/adapterRegistry";
import type { OmniProvider } from "../types";
import type { WorkspaceRequest } from "../../../lib/workspace";
import { randomBytes } from "crypto";

const router = Router();

const ownerAuth = requireOmnichannelRole("omnichannel:owner");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PROVIDERS: OmniProvider[] = ["whatsapp", "instagram", "messenger", "tiktok"];

const createChannelSchema = z.object({
  provider: z.enum(["whatsapp", "instagram", "messenger", "tiktok"]),
  name: z.string().min(1),
  external_account_id: z.string().nullable().optional(),
  access_token: z.string().nullable().optional(),
  refresh_token: z.string().nullable().optional(),
  webhook_verify_token: z.string().nullable().optional(),
});

const updateChannelSchema = z.object({
  name: z.string().min(1).optional(),
  external_account_id: z.string().nullable().optional(),
  access_token: z.string().nullable().optional(),
  refresh_token: z.string().nullable().optional(),
  webhook_verify_token: z.string().nullable().optional(),
  status: z.enum(["disconnected", "pending", "connected", "error"]).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ChannelAccountRow {
  id: number;
  workspace_owner_id: string;
  provider: string;
  name: string;
  external_account_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  webhook_verify_token: string | null;
  status: string;
  last_webhook_received_at: Date | null;
  last_outbound_send_at: Date | null;
  last_error: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function maskChannel(row: ChannelAccountRow) {
  return {
    id: row.id,
    workspace_owner_id: row.workspace_owner_id,
    provider: row.provider,
    name: row.name,
    external_account_id: row.external_account_id,
    webhook_verify_token: row.webhook_verify_token,
    status: row.status,
    token_configured: !!row.access_token,
    refresh_token_configured: !!row.refresh_token,
    last_webhook_received_at: row.last_webhook_received_at?.toISOString() ?? null,
    last_outbound_send_at: row.last_outbound_send_at?.toISOString() ?? null,
    last_error: row.last_error,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function maybeEncrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isEncrypted(value)) return value;
  return encrypt(value);
}

function generateVerifyToken(): string {
  return randomBytes(24).toString("hex");
}

async function getChannelRow(id: number, workspaceOwnerId: string): Promise<ChannelAccountRow | null> {
  const result = await db.query<ChannelAccountRow>(
    `SELECT id, workspace_owner_id, provider, name, external_account_id,
            access_token, refresh_token, webhook_verify_token, status,
            last_webhook_received_at, last_outbound_send_at, last_error,
            is_active, created_at, updated_at
     FROM omni_channel_accounts
     WHERE id = $1 AND workspace_owner_id = $2 AND is_active = true`,
    [id, workspaceOwnerId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /omnichannel/channels
router.get("/omnichannel/channels", ...ownerAuth, async (req: Request, res: Response): Promise<void> => {
  const wreq = req as WorkspaceRequest;
  try {
    const result = await db.query<ChannelAccountRow>(
      `SELECT id, workspace_owner_id, provider, name, external_account_id,
              access_token, refresh_token, webhook_verify_token, status,
              last_webhook_received_at, last_outbound_send_at, last_error,
              is_active, created_at, updated_at
       FROM omni_channel_accounts
       WHERE workspace_owner_id = $1 AND is_active = true
       ORDER BY created_at ASC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ channels: result.rows.map(maskChannel) });
  } catch (err) {
    req.log.error({ err }, "omnichannel: failed to list channel accounts");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /omnichannel/channels
router.post("/omnichannel/channels", ...ownerAuth, async (req: Request, res: Response): Promise<void> => {
  const wreq = req as WorkspaceRequest;
  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
    return;
  }
  const { provider, name, external_account_id, access_token, refresh_token, webhook_verify_token } = parsed.data;

  try {
    const verifyToken = webhook_verify_token ?? generateVerifyToken();
    const encryptedToken = maybeEncrypt(access_token ?? null);
    const encryptedRefresh = maybeEncrypt(refresh_token ?? null);

    const result = await db.query<ChannelAccountRow>(
      `INSERT INTO omni_channel_accounts
         (workspace_owner_id, provider, name, external_account_id,
          access_token, refresh_token, webhook_verify_token,
          status, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'disconnected', true, NOW(), NOW())
       RETURNING id, workspace_owner_id, provider, name, external_account_id,
                 access_token, refresh_token, webhook_verify_token, status,
                 last_webhook_received_at, last_outbound_send_at, last_error,
                 is_active, created_at, updated_at`,
      [
        wreq.workspaceOwnerId,
        provider,
        name,
        external_account_id ?? null,
        encryptedToken,
        encryptedRefresh,
        verifyToken,
      ],
    );
    const row = result.rows[0];
    res.status(201).json({ channel: maskChannel(row) });

    const shouldReload = !!access_token || row.status === "connected";
    if (shouldReload) {
      loadAdapterRegistry().catch((err) => {
        req.log.error({ err }, "omnichannel: failed to reload adapter registry after channel create");
      });
    }
  } catch (err) {
    req.log.error({ err }, "omnichannel: failed to create channel account");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /omnichannel/channels/:id
router.get("/omnichannel/channels/:id", ...ownerAuth, async (req: Request, res: Response): Promise<void> => {
  const wreq = req as WorkspaceRequest;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid channel ID" });
    return;
  }
  try {
    const row = await getChannelRow(id, wreq.workspaceOwnerId);
    if (!row) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    res.json({ channel: maskChannel(row) });
  } catch (err) {
    req.log.error({ err }, "omnichannel: failed to get channel account");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /omnichannel/channels/:id
router.patch("/omnichannel/channels/:id", ...ownerAuth, async (req: Request, res: Response): Promise<void> => {
  const wreq = req as WorkspaceRequest;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid channel ID" });
    return;
  }
  const parsed = updateChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Validation error" });
    return;
  }

  try {
    const row = await getChannelRow(id, wreq.workspaceOwnerId);
    if (!row) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    const { name, external_account_id, access_token, refresh_token, webhook_verify_token, status } = parsed.data;

    if (name !== undefined) {
      updates.push(`name = $${paramIdx++}`);
      values.push(name);
    }
    if ("external_account_id" in parsed.data) {
      updates.push(`external_account_id = $${paramIdx++}`);
      values.push(external_account_id ?? null);
    }
    if ("access_token" in parsed.data) {
      updates.push(`access_token = $${paramIdx++}`);
      values.push(maybeEncrypt(access_token ?? null));
    }
    if ("refresh_token" in parsed.data) {
      updates.push(`refresh_token = $${paramIdx++}`);
      values.push(maybeEncrypt(refresh_token ?? null));
    }
    if ("webhook_verify_token" in parsed.data) {
      updates.push(`webhook_verify_token = $${paramIdx++}`);
      values.push(webhook_verify_token ?? null);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramIdx++}`);
      values.push(status);
    }

    if (updates.length === 0) {
      res.json({ channel: maskChannel(row) });
      return;
    }

    updates.push(`updated_at = NOW()`);
    values.push(id, wreq.workspaceOwnerId);

    const updateResult = await db.query<ChannelAccountRow>(
      `UPDATE omni_channel_accounts
       SET ${updates.join(", ")}
       WHERE id = $${paramIdx++} AND workspace_owner_id = $${paramIdx}
       RETURNING id, workspace_owner_id, provider, name, external_account_id,
                 access_token, refresh_token, webhook_verify_token, status,
                 last_webhook_received_at, last_outbound_send_at, last_error,
                 is_active, created_at, updated_at`,
      values,
    );

    const updated = updateResult.rows[0];
    res.json({ channel: maskChannel(updated) });

    const shouldReload = status === "connected" || "access_token" in parsed.data;
    if (shouldReload) {
      loadAdapterRegistry().catch((err) => {
        req.log.error({ err }, "omnichannel: failed to reload adapter registry after channel update");
      });
    }
  } catch (err) {
    req.log.error({ err }, "omnichannel: failed to update channel account");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /omnichannel/channels/:id
router.delete("/omnichannel/channels/:id", ...ownerAuth, async (req: Request, res: Response): Promise<void> => {
  const wreq = req as WorkspaceRequest;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid channel ID" });
    return;
  }
  try {
    const row = await getChannelRow(id, wreq.workspaceOwnerId);
    if (!row) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    await db.query(
      `UPDATE omni_channel_accounts
       SET is_active = false, status = 'disconnected', updated_at = NOW()
       WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "omnichannel: failed to delete channel account");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /omnichannel/channels/:id/test
router.post("/omnichannel/channels/:id/test", ...ownerAuth, async (req: Request, res: Response): Promise<void> => {
  const wreq = req as WorkspaceRequest;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid channel ID" });
    return;
  }
  try {
    const row = await getChannelRow(id, wreq.workspaceOwnerId);
    if (!row) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const provider = PROVIDERS.includes(row.provider as OmniProvider)
      ? (row.provider as OmniProvider)
      : "whatsapp";

    const adapter = getMockAdapter(provider);
    const capabilities = adapter.getCapabilities();

    const simulatedAt = new Date().toISOString();

    logger.info({ channelAccountId: id, provider }, "omnichannel: test webhook triggered");

    res.json({
      result: {
        success: true,
        message: `Mock test successful for ${provider} channel "${row.name}". The adapter supports text=${capabilities.supportsText}, image=${capabilities.supportsImage}.`,
        provider,
        simulated_at: simulatedAt,
      },
    });
  } catch (err) {
    req.log.error({ err }, "omnichannel: failed to run channel test");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /omnichannel/channels/:id/reconnect
router.post("/omnichannel/channels/:id/reconnect", ...ownerAuth, async (req: Request, res: Response): Promise<void> => {
  const wreq = req as WorkspaceRequest;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid channel ID" });
    return;
  }
  try {
    const row = await getChannelRow(id, wreq.workspaceOwnerId);
    if (!row) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const result = await db.query<ChannelAccountRow>(
      `UPDATE omni_channel_accounts
       SET status = 'pending', last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING id, workspace_owner_id, provider, name, external_account_id,
                 access_token, refresh_token, webhook_verify_token, status,
                 last_webhook_received_at, last_outbound_send_at, last_error,
                 is_active, created_at, updated_at`,
      [id, wreq.workspaceOwnerId],
    );
    const updated = result.rows[0];
    res.json({ channel: maskChannel(updated) });
  } catch (err) {
    req.log.error({ err }, "omnichannel: failed to reconnect channel");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

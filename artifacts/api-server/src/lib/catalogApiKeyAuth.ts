import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "./db";
import { logger } from "./logger";

export interface CatalogApiKeyAuthedRequest extends Request {
  catalogWorkspaceOwnerId: string;
  catalogKeyId: number;
  catalogChannelId: number | null;
}

function extractRawKey(req: Request): string | null {
  const authHeader = req.header("authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();

  const headerKey = req.header("x-presentail-api-key");
  if (headerKey) return headerKey.trim();

  return null;
}

export async function resolveCatalogApiKey(req: Request): Promise<{
  workspaceOwnerId: string;
  keyId: number;
  channelId: number | null;
} | null> {
  const rawKey = extractRawKey(req);
  if (!rawKey) return null;

  try {
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const result = await db.query<{
      id: number;
      workspace_owner_id: string;
      channel_id: number | null;
    }>(
      `SELECT id, workspace_owner_id, channel_id
         FROM catalog_api_keys
        WHERE key_hash = $1 AND status = 'active'
        LIMIT 1`,
      [keyHash],
    );
    if (!result.rowCount || !result.rows[0]) return null;

    const row = result.rows[0];
    db.query(
      `UPDATE catalog_api_keys SET last_used_at = now() WHERE id = $1`,
      [row.id],
    ).catch(() => {});

    return {
      workspaceOwnerId: row.workspace_owner_id,
      keyId: row.id,
      channelId: row.channel_id ?? null,
    };
  } catch (err) {
    logger.error({ err }, "resolveCatalogApiKey: unexpected DB error");
    return null;
  }
}

export async function requireCatalogApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const resolved = await resolveCatalogApiKey(req);
  if (!resolved) {
    res.status(401).json({
      success: false,
      error: "Missing or invalid catalog API key. Provide Authorization: Bearer <key> or X-Presentail-Api-Key: <key>.",
    });
    return;
  }
  const r = req as CatalogApiKeyAuthedRequest;
  r.catalogWorkspaceOwnerId = resolved.workspaceOwnerId;
  r.catalogKeyId = resolved.keyId;
  r.catalogChannelId = resolved.channelId;
  next();
}

export function catalogApiKeyed(req: Request): CatalogApiKeyAuthedRequest {
  return req as CatalogApiKeyAuthedRequest;
}

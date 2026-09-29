import crypto from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import { db } from "./db";
import { logger } from "./logger";

/**
 * Bearer token authentication middleware for /api/v1/ ingest endpoints.
 *
 * Auth order:
 *  1. Look up the token hash in workspace_ingest_keys. If found, verify the
 *     request's workspace_owner_id (from body for mutations, query for reads)
 *     matches the key's workspace_owner_id. This prevents a key from
 *     workspace A authenticating reads/writes for workspace B.
 *     On success, update last_used_at and per-endpoint daily usage — both
 *     fire-and-forget.
 *  2. Fall back to PRESENTAIL_INGEST_API_KEY env var for backward compat.
 *     The env var path does not enforce workspace scoping (same as before).
 */
export async function requireIngestAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = (req.headers.authorization ?? "").trim();
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "Authorization header required (Bearer token)" });
    return;
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  // 1. DB lookup — find a workspace_ingest_key row matching this hash
  try {
    const result = await db.query<{ id: number; workspace_owner_id: string }>(
      `SELECT id, workspace_owner_id FROM workspace_ingest_keys WHERE key_hash = $1`,
      [tokenHash],
    );
    if (result.rowCount && result.rowCount > 0) {
      const row = result.rows[0];

      // Resolve workspace_owner_id from body (mutations) or query string (reads).
      // Requiring it prevents a key from workspace A from authenticating
      // requests that target workspace B.
      const requestedWorkspace =
        (req.body as Record<string, unknown>)?.workspace_owner_id ??
        (typeof req.query.workspace_owner_id === "string"
          ? req.query.workspace_owner_id
          : undefined);

      if (!requestedWorkspace) {
        res.status(400).json({ error: "workspace_owner_id is required" });
        return;
      }

      if (requestedWorkspace !== row.workspace_owner_id) {
        res.status(401).json({ error: "Invalid API key" });
        return;
      }

      // Fire-and-forget: update last_used_at
      db.query(
        `UPDATE workspace_ingest_keys SET last_used_at = now() WHERE id = $1`,
        [row.id],
      ).catch((err: unknown) => {
        logger.warn({ err }, "Failed to update ingest key last_used_at");
      });

      // Fire-and-forget: upsert per-endpoint daily usage count
      // Derive a stable endpoint label from the HTTP method + first path segment.
      // req.path within the /v1 sub-router is the remaining path e.g. "/orders".
      const firstSegment = req.path.split("/")[1] ?? "";
      const endpointLabel = `${req.method} /${firstSegment}`;
      db.query(
        `INSERT INTO ingest_key_usage (ingest_key_id, endpoint, usage_date, call_count)
         VALUES ($1, $2, CURRENT_DATE, 1)
         ON CONFLICT (ingest_key_id, endpoint, usage_date)
         DO UPDATE SET call_count = ingest_key_usage.call_count + 1`,
        [row.id, endpointLabel],
      ).catch((err: unknown) => {
        logger.warn({ err }, "Failed to upsert ingest key usage");
      });

      next();
      return;
    }
  } catch (err) {
    logger.warn({ err }, "DB lookup failed in requireIngestAuth — falling back to env var");
  }

  // 2. Env-var fallback for backward compat.
  // The env var path preserves the original behavior — no workspace scoping
  // is enforced here since single-env-var deployments have only one workspace.
  const apiKey = process.env.PRESENTAIL_INGEST_API_KEY;
  if (apiKey && token === apiKey) {
    next();
    return;
  }

  res.status(401).json({ error: "Invalid API key" });
}

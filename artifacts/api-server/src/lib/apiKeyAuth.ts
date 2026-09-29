import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "./db";
import { logger } from "./logger";

export interface ApiKeyAuthedRequest extends Request {
  userId: string;
  apiKeyId: number;
}

/**
 * Optionally resolves a workspace owner ID from an API key. Checks (in order):
 *   1. `x-api-key` request header
 *   2. `?apiKey=` query parameter
 *   3. `Authorization: Bearer pk_live_...` header
 *
 * Returns the `user_id` (workspace owner) from the `api_keys` table if the key
 * is valid, or `null` if no valid key is found. Never throws — safe to use in
 * public routes that fall back to other workspace resolution strategies.
 */
export async function resolveApiKeyWorkspace(req: Request): Promise<string | null> {
  // Collect candidate raw keys in priority order
  const candidates: string[] = [];

  const xApiKey = req.header("x-api-key") ?? "";
  if (xApiKey) candidates.push(xApiKey.trim());

  const queryApiKey = typeof req.query.apiKey === "string" ? req.query.apiKey.trim() : "";
  if (queryApiKey) candidates.push(queryApiKey);

  const authHeader = req.header("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) candidates.push(bearerMatch[1].trim());

  const rawKey = candidates.find((k) => k.startsWith("pk_live_"));
  if (!rawKey) return null;

  try {
    const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const result = await db.query<{ id: number; user_id: string }>(
      `SELECT id, user_id FROM api_keys WHERE key_hash = $1 LIMIT 1`,
      [keyHash],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    db.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
    return row.user_id;
  } catch (err) {
    logger.error({ err }, "resolveApiKeyWorkspace: unexpected DB error");
    return null;
  }
}

/**
 * Property set on a Request when {@link apiKeyReadAuth} has established a
 * read-only identity from a workspace API key. `requireAuth` honors this when
 * no Clerk session is present (see lib/auth.ts).
 */
export interface ApiKeyReadAuthedRequest extends Request {
  userId: string;
  apiKeyId: number;
  /** True when the request identity was established via a workspace API key (reads only). */
  apiKeyReadAuth: true;
}

/**
 * Upstream middleware that grants a valid workspace API key (`pk_live_…`)
 * READ access to every workspace-gated endpoint.
 *
 * For GET/HEAD requests carrying a valid key (via `x-api-key`, `?apiKey=`, or
 * `Authorization: Bearer pk_live_…`), this resolves the key to its workspace
 * owner and populates `req.userId` plus an `apiKeyReadAuth` flag so the
 * downstream `requireAuth` accepts the request and `resolveWorkspace` grants
 * that owner's (owner-level) workspace context — no Clerk session required.
 *
 * Constraints:
 *   - Only GET/HEAD requests are ever granted an identity here. Mutating
 *     methods (POST/PUT/PATCH/DELETE) fall through untouched, so an API key can
 *     never write — they still require a Clerk session.
 *   - Never rejects. When no key is present, or the request is mutating, it
 *     simply calls next() so Clerk-session auth (or public routes) proceed
 *     exactly as before.
 */
export async function apiKeyReadAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  const ownerId = await resolveApiKeyWorkspace(req);
  if (ownerId) {
    const areq = req as ApiKeyReadAuthedRequest;
    areq.userId = ownerId;
    areq.apiKeyReadAuth = true;
  }
  next();
}

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Accept the workspace API key from any of the supported locations, in the
  // same priority order as resolveApiKeyWorkspace():
  //   1. `x-api-key` request header
  //   2. `?apiKey=` query parameter
  //   3. `Authorization: Bearer pk_live_…` header
  // This keeps API-key auth consistent across endpoints (e.g. /orders matches
  // /delivery-locations-ext), so server-to-server callers can use either header.
  const candidates: string[] = [];

  const xApiKey = req.header("x-api-key") ?? "";
  if (xApiKey) candidates.push(xApiKey.trim());

  const queryApiKey = typeof req.query.apiKey === "string" ? req.query.apiKey.trim() : "";
  if (queryApiKey) candidates.push(queryApiKey);

  const authHeader = req.header("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) candidates.push(bearerMatch[1].trim());

  const rawKey = candidates.find((k) => k.startsWith("pk_live_"));
  if (!rawKey) {
    res.status(401).json({ error: "Missing or invalid API key" });
    return;
  }
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const result = await db.query(
    `SELECT id, user_id FROM api_keys WHERE key_hash = $1 LIMIT 1`,
    [keyHash],
  );
  if (result.rowCount === 0) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }
  const row = result.rows[0] as { id: number; user_id: string };
  (req as ApiKeyAuthedRequest).userId = row.user_id;
  (req as ApiKeyAuthedRequest).apiKeyId = row.id;
  // Best-effort update of last_used_at — don't await
  db.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch(() => {});
  next();
}

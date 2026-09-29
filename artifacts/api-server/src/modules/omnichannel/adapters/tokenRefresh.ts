/**
 * Shared token-refresh utility for OAuth-based channel adapters.
 *
 * Adapters that use expiring OAuth tokens (Meta long-lived tokens for
 * Instagram, TikTok) call `maybeRefreshToken` before every outbound API
 * call.  If the stored token expires within TOKEN_REFRESH_THRESHOLD_MS the
 * utility exchanges it for a fresh one, persists the new token pair to the
 * `omni_channel_accounts` DB row, and returns the new plaintext token.
 */

import { createHmac } from "crypto";
import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { encrypt } from "../../../lib/credentialEncryption";
import { ProviderAuthError } from "../errors";

/** Refresh if the token expires within the next hour. */
const TOKEN_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

export interface RefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshed: boolean;
}

/**
 * Check whether `expiresAt` is within the refresh threshold.
 */
export function isTokenExpiringSoon(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - Date.now() < TOKEN_REFRESH_THRESHOLD_MS;
}

/**
 * Refresh a Meta long-lived token (used by both Instagram and Messenger).
 *
 * Meta long-lived tokens last 60 days and are refreshed by calling:
 *   GET https://graph.facebook.com/v19.0/oauth/access_token
 *       ?grant_type=fb_exchange_token&client_id=...&client_secret=...
 *       &fb_exchange_token=<current_token>
 *
 * @see https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 */
export async function refreshMetaLongLivedToken(
  currentToken: string,
  appId: string,
  appSecret: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const url = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("fb_exchange_token", currentToken);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new ProviderAuthError(
      `Meta token refresh failed (HTTP ${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message: string; code: number };
  };

  if (data.error || !data.access_token) {
    throw new ProviderAuthError(
      `Meta token refresh error: ${data.error?.message ?? "no access_token in response"}`,
      String(data.error?.code ?? ""),
    );
  }

  const expiresIn = data.expires_in ?? 5184000; // default 60 days
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  return { accessToken: data.access_token, expiresAt };
}

/**
 * Persist an updated access token (and optional refresh token + expiry) to
 * the `omni_channel_accounts` table.  Values are encrypted before storage.
 */
export async function persistRefreshedToken(
  channelAccountId: number,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: Date | null,
): Promise<void> {
  try {
    const encryptedAccess = encrypt(accessToken);
    const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;
    await db.query(
      `UPDATE omni_channel_accounts
          SET access_token = $1,
              refresh_token = $2,
              token_expires_at = $3,
              updated_at = now()
        WHERE id = $4`,
      [encryptedAccess, encryptedRefresh, expiresAt, channelAccountId],
    );
  } catch (err) {
    logger.error({ err, channelAccountId }, "omnichannel: failed to persist refreshed token");
  }
}

/**
 * Compute an HMAC-SHA256 hex digest.
 * Used by Meta and WhatsApp webhook signature verification.
 */
export function hmacSha256Hex(secret: string, payload: Buffer | string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

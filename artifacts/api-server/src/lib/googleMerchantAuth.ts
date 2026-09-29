/**
 * Google Merchant Center service-account authentication helper.
 *
 * Decodes GOOGLE_SERVICE_ACCOUNT_JSON_B64, builds and signs an RS256 JWT, then
 * exchanges it for a short-lived OAuth access token. Caches the token in memory
 * and refreshes within 60 s of expiry.
 *
 * Never logs the private key or the returned token.
 */

import crypto from "crypto";
import { logger } from "./logger";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/content";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // unix epoch ms
}

let cachedToken: CachedToken | null = null;

interface ServiceAccountJson {
  client_email: string;
  private_key: string;
}

function loadServiceAccount(): ServiceAccountJson {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!b64) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not set. Cannot authenticate with Google Merchant Center.",
    );
  }
  const json = Buffer.from(b64, "base64").toString("utf8");
  const parsed = JSON.parse(json) as ServiceAccountJson;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON_B64 does not contain client_email or private_key.",
    );
  }
  return parsed;
}

function base64urlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildJwt(clientEmail: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64urlEncode(
    Buffer.from(
      JSON.stringify({
        iss: clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        exp: now + 3600,
        iat: now,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = base64urlEncode(sign.sign(privateKey));
  return `${signingInput}.${signature}`;
}

async function fetchAccessToken(): Promise<CachedToken> {
  const { client_email, private_key } = loadServiceAccount();
  const jwt = buildJwt(client_email, private_key);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const body = (await res.json()) as Record<string, unknown>;

  if (!res.ok || typeof body.access_token !== "string") {
    const errMsg =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
    throw new Error(`Google service-account token exchange failed: ${errMsg}`);
  }

  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  logger.info("googleMerchantAuth: access token obtained (not logged)");
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/**
 * Returns a valid Google OAuth access token for the Content API scope.
 * Caches and refreshes automatically; never logs the token value.
 */
export async function getMerchantAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.accessToken;
  }
  cachedToken = await fetchAccessToken();
  return cachedToken.accessToken;
}

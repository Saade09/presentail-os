/**
 * Google OAuth helper — exchanges the stored refresh token for a short-lived
 * access token. Never logs the returned token or the refresh token.
 */
export async function getGoogleAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google OAuth credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN.",
    );
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
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
    throw new Error(`Google token exchange failed: ${errMsg}`);
  }

  return body.access_token;
}

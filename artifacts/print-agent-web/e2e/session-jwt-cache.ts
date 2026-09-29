const DEFAULT_REFRESH_SKEW_MS = 5_000;
const sharedCache = new Map<string, { jwt: string; expiresAtMs: number }>();

export interface SessionJwtSource {
  getToken(sessionId: string): Promise<{ jwt: string }>;
}

export function getJwtExpiryMs(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof decoded.exp === "number" && Number.isFinite(decoded.exp)
      ? decoded.exp * 1000
      : null;
  } catch {
    return null;
  }
}

export function createSessionJwtCache(args: {
  source: SessionJwtSource;
  now?: () => number;
  refreshSkewMs?: number;
  onRateLimit?: (delayMs: number, attempt: number) => void;
}) {
  const {
    source,
    now = Date.now,
    refreshSkewMs = DEFAULT_REFRESH_SKEW_MS,
    onRateLimit,
  } = args;
  async function get(sessionId: string): Promise<string> {
    const cached = sharedCache.get(sessionId);
    if (cached && cached.expiresAtMs - now() > refreshSkewMs) {
      return cached.jwt;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await source.getToken(sessionId);
        const expiresAtMs = getJwtExpiryMs(response.jwt);
        if (expiresAtMs === null || expiresAtMs <= now()) {
          throw new Error("Clerk returned a session JWT without a valid future expiry");
        }
        sharedCache.set(sessionId, { jwt: response.jwt, expiresAtMs });
        return response.jwt;
      } catch (error) {
        lastError = error;
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? (error as { status?: unknown }).status
            : undefined;
        const message = error instanceof Error ? error.message : String(error);
        const rateLimited =
          status === 429 || /too.*many.*requests/i.test(message);
        if (!rateLimited) throw error;
        const delayMs = 500 * 2 ** attempt;
        onRateLimit?.(delayMs, attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  function invalidate(sessionId: string): void {
    sharedCache.delete(sessionId);
  }

  return { get, invalidate };
}
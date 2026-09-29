const TRUSTED_PRESENTAIL_ORIGINS = new Set([
  "https://print.presentail.com",
  "https://os.presentail.com",
  "https://presentail.com",
  "https://www.presentail.com",
]);

const REPLIT_DEVELOPMENT_HOST =
  /\.(replit\.dev|repl\.co|janeway\.replit\.dev)$/;

export class CorsOriginDeniedError extends Error {
  readonly code = "CORS_ORIGIN_DENIED";
  readonly statusCode = 403;

  constructor(origin: string) {
    super(`CORS: origin ${origin} not allowed`);
    this.name = "CorsOriginDeniedError";
  }
}

function configuredOrigins(value: string | undefined): Set<string> {
  return new Set(
    (value || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function isAllowedCorsOrigin(
  origin: string | undefined,
  options: {
    nodeEnv?: string;
    additionalOrigins?: string;
  } = {},
): boolean {
  // Same-origin and non-browser requests do not include an Origin header.
  if (!origin) return true;

  if (TRUSTED_PRESENTAIL_ORIGINS.has(origin)) return true;

  if (configuredOrigins(options.additionalOrigins).has(origin)) return true;

  if (options.nodeEnv !== "production") {
    try {
      return REPLIT_DEVELOPMENT_HOST.test(new URL(origin).hostname);
    } catch {
      return false;
    }
  }

  return false;
}
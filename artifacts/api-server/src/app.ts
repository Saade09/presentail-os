import path from "path";
import { fileURLToPath } from "url";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkFapi,
} from "./middlewares/clerkProxyMiddleware";
import {
  preferBearerOverClerkCookies,
  withClerkAuthBoundary,
} from "./middlewares/clerkAuthBoundary";
import router from "./routes";
import reviewRedirectRouter from "./routes/reviewRedirect";
import publicImagesRouter from "./routes/publicImages";
import { scannerPublicRouter, scannerDeviceRouter } from "./routes/scanner";
import { respondIoRawBodyErrorResponse } from "./routes/respondioIncoming";
import { logger } from "./lib/logger";
import { db } from "./lib/db";
import { startupReadinessGate } from "./lib/startupReadiness";
import {
  CorsOriginDeniedError,
  isAllowedCorsOrigin,
} from "./lib/corsOrigins";
import { expectedRequestErrorResponse } from "./lib/requestErrorResponse";
import { getEffectiveClerkPublishableKey } from "./lib/clerkPublishableKey";

const app: Express = express();

// The API runs behind Replit's reverse proxy in production; trust the
// X-Forwarded-* headers so req.protocol resolves to https (OAuth redirect
// URIs must be https or Google rejects with redirect_uri_mismatch).
app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// ── Google post uploaded images (public static assets) ───────────────────────
app.use("/uploads/google-posts", express.static(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/uploads/google-posts"),
  { maxAge: "1d" },
));

app.use(
  cors({
    credentials: true,
    origin: (origin, cb) => {
      if (
        isAllowedCorsOrigin(origin, {
          nodeEnv: process.env.NODE_ENV,
          additionalOrigins: process.env.ALLOWED_ORIGINS,
        })
      ) {
        return cb(null, true);
      }
      cb(new CorsOriginDeniedError(origin ?? "<missing>"));
    },
  }),
);

// Keep the artifact-level /api health probe independent of database startup.
// The deployment process probes the API artifact at its mounted root, while
// /api/healthz is also available for explicit readiness/liveness checks.
app.get(["/api", "/api/"], (_req, res) => {
  res.json({ status: "ok" });
});

// Public, non-secret runtime auth attestation for release verification. These
// values are already encoded in the browser's public Clerk key; exposing them
// proves which issuer/FAPI the deployed API process actually selected.
app.get("/api/auth/config-attestation", (_req, res) => {
  const publishableKey = getEffectiveClerkPublishableKey();
  const clerkIssuerDomain = publishableKey
    ? Buffer.from(publishableKey.replace(/^pk_(live|test)_/, ""), "base64")
      .toString("utf8")
      .replace(/\$$/, "")
    : null;
  res.json({
    clerk_issuer_domain: clerkIssuerDomain,
    clerk_fapi: getClerkFapi(),
    browser_proxy_mode: "disabled_direct_fapi",
  });
});

// The production process must open its port quickly for deployment health
// checks, but initDb can take several minutes. Keep every API route outside the
// application until schema initialization completes so requests can never hit
// partially-created tables or columns and surface misleading generic 500s.
app.use(startupReadinessGate);

const RAW_BODY_PATHS = [
  "/api/webhooks/stripe",
  "/api/webhooks/paypal",
  "/api/webhooks/mamo",
  "/api/webhooks/clerk",
  "/api/webhooks/resend",
  "/api/webhooks/whatsapp",
  "/api/webhooks/messenger",
  "/api/webhooks/instagram",
  "/api/webhooks/tiktok",
  "/api/respondio/incoming-message",
  "/api/respondio/outbound-template",
  "/api/respondio/workflows/order-address-change",
];
const RESPONDIO_INCOMING_PATHS = new Set([
  "/api/respondio/incoming-message",
]);

app.use((req, res, next) => {
  if (RAW_BODY_PATHS.includes(req.path)) {
    express.raw({ type: "application/json" })(req, res, (err) => {
      if (err) {
        if (RESPONDIO_INCOMING_PATHS.has(req.path)) {
          const errorType = (err as { type?: unknown }).type;
          respondIoRawBodyErrorResponse(
            req,
            res,
            errorType === "entity.too.large" ? "body_too_large" : "invalid_body",
          );
          return;
        }
        return next(err);
      }
      (req as typeof req & { rawBody: Buffer }).rawBody = req.body as Buffer;
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Clerk's @clerk/express middleware needs the publishable key to verify the
// JWT issuer.  It MUST match the key the frontend uses so the backend fetches
// JWKS from the same Clerk instance that issued the session JWT.
//
const clerkPublishableKey =
  getEffectiveClerkPublishableKey();
if (!clerkPublishableKey) {
  throw new Error(
    "VITE_CLERK_PUBLISHABLE_KEY is required but not set. " +
      "Set it in the deployment environment and restart the server.",
  );
}

// Startup diagnostics (never log the key/secret values themselves).
{
  const issuerDomain = (() => {
    try {
      return Buffer.from(
        clerkPublishableKey.replace(/^pk_(live|test)_/, ""),
        "base64",
      )
        .toString("utf8")
        .replace(/\$$/, "");
    } catch {
      return "<undecodable>";
    }
  })();
  logger.info(
    {
      clerkSecretKeyPresent: Boolean(process.env.CLERK_SECRET_KEY),
      clerkIssuerDomain: issuerDomain,
      clerkKeySource:
        process.env.NODE_ENV === "production" ? "baked-production-constant" : "env",
    },
    "clerk auth configuration",
  );

  // Async probe: ask Clerk's Backend API which instance the runtime's
  // CLERK_SECRET_KEY actually belongs to, and whether its JWKS could verify
  // tokens signed by the instance the publishable key points at. This proves
  // (or rules out) a stale CLERK_SECRET_KEY injected by the deployment
  // environment. Never logs any key material.
  if (process.env.CLERK_SECRET_KEY) {
    void fetch("https://api.clerk.com/v1/jwks", {
      headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          logger.warn(
            { status: res.status },
            "clerk secret key probe: Clerk API rejected the configured secret key",
          );
          return;
        }
        const body = (await res.json()) as { keys?: Array<{ kid?: string }> };
        logger.info(
          {
            secretKeyJwksKids: (body.keys ?? []).map((k) => k.kid),
            publishableKeyIssuerDomain: issuerDomain,
          },
          "clerk secret key probe: JWKS kids reachable with the configured secret key",
        );
      })
      .catch((err: unknown) => {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "clerk secret key probe failed",
        );
      });
  }
}

// Public image assets — mounted BEFORE clerkMiddleware so Clerk's handshake
// logic never intercepts them, regardless of what session cookies the browser
// carries.  Only genuinely public, read-only image-serving paths live here
// (GET /api/storage/public-objects/* and the HMAC-cookie-protected image
// routes).  All routes that require a Clerk session are handled by the main
// /api router below, which is mounted after clerkMiddleware.
app.use("/api", publicImagesRouter);

// Public Google Review Rewards scan redirect — unauthenticated, mounted under
// /api so the proxy routes it to the API server in every environment. Must
// also be mounted BEFORE clerkMiddleware: Clerk's handshake logic inspects
// the Host header on every request it sees and rejects unrecognized hosts
// (host_invalid) before the request ever reaches route handlers, so a QR
// scanner with no Clerk session — or hitting the wrong host — got Clerk's raw
// error JSON instead of the redirect. See publicImagesRouter above for the
// same pattern.
app.use("/api", reviewRedirectRouter);

// Scanner Agent machine traffic is authenticated by a pairing code or scanner
// bearer token, not a Clerk browser session. It must be mounted before
// clerkMiddleware or the installed Windows agent receives Clerk's generic 401
// Unauthorized before its own authentication can run.
app.use("/api", scannerPublicRouter);
app.use("/api", scannerDeviceRouter);

app.use(preferBearerOverClerkCookies);
app.use(withClerkAuthBoundary(clerkMiddleware({ publishableKey: clerkPublishableKey })));

// ── Social-crawler OG tag handler for /pay/:token ────────────────────────────
// Detects known crawler User-Agents and responds with a lightweight HTML page
// that contains correct og:* meta tags for the specific payment link, so
// WhatsApp / Telegram / Slack / etc. render a rich preview card.
// Non-crawler requests fall through to the SPA via next().
// This handler MUST be zero-cost: it performs a read-only DB query with no
// Stripe reconciliation so crawler visits never trigger financial side effects.
const CRAWLER_UA_RE = /WhatsApp|facebookexternalhit|TelegramBot|Slackbot|Twitterbot|LinkedInBot|Discordbot|Googlebot/i;
const PAY_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

app.get("/pay/:token", async (req: Request, res: Response, next: NextFunction) => {
  const ua = req.headers["user-agent"] ?? "";
  if (!CRAWLER_UA_RE.test(ua)) {
    return next();
  }

  const token = String(req.params.token ?? "");
  if (!PAY_TOKEN_RE.test(token)) {
    return next();
  }

  try {
    const result = await db.query<{ amount: number; currency: string; description: string | null }>(
      `SELECT amount, currency, description FROM payment_links WHERE public_token = $1`,
      [token],
    );

    const payUrl = `https://os.presentail.com/pay/${token}`;
    const ogImage = "https://os.presentail.com/pay-og.jpg";

    let ogTitle = "Payment Request — Presentail";
    let ogDescription = "You've received a secure payment request via Presentail.";

    if (result.rowCount && result.rowCount > 0) {
      const link = result.rows[0];
      const amount = link.amount / 100;
      const amountStr = new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(amount);
      ogTitle = `Pay ${amountStr} ${link.currency} — Presentail`;
      if (link.description) {
        ogDescription = link.description;
      }
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>${ogTitle}</title>
<meta property="og:type" content="website" />
<meta property="og:title" content="${ogTitle.replace(/"/g, "&quot;")}" />
<meta property="og:description" content="${ogDescription.replace(/"/g, "&quot;")}" />
<meta property="og:image" content="${ogImage}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:url" content="${payUrl}" />
<meta name="twitter:card" content="summary_large_image" />
<meta http-equiv="refresh" content="0;url=${payUrl}" />
</head>
<body></body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).send(html);
  } catch (err) {
    logger.warn({ err, token }, "Crawler OG handler DB query failed; falling through to SPA");
    next();
  }
});

app.use("/api", router);

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "File is too large. Please upload a smaller image." });
    return;
  }
  const expectedResponse = expectedRequestErrorResponse(err);
  if (expectedResponse) {
    req.log.warn(
      {
        errorCode: expectedResponse.body.code,
        statusCode: expectedResponse.status,
        url: req.url,
        method: req.method,
      },
      "Request rejected by shared middleware",
    );
    res.status(expectedResponse.status).json(expectedResponse.body);
    return;
  }
  logger.error({ err, url: req.url, method: req.method }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;

/**
 * Clerk Frontend API Proxy Middleware
 *
 * Proxies Clerk Frontend API requests through your domain, enabling Clerk
 * authentication on custom domains and .replit.app deployments without
 * requiring CNAME DNS configuration.
 *
 * AUTH CONFIGURATION: To manage users, enable/disable login providers
 * (Google, GitHub, etc.), change app branding, or configure OAuth credentials,
 * use the Auth pane in the workspace toolbar. There is no external Clerk
 * dashboard — all auth configuration is done through the Auth pane.
 *
 * IMPORTANT:
 * - Only active in production (Clerk proxying doesn't work for dev instances)
 * - Must be mounted BEFORE express.json() middleware
 *
 * Usage in app.ts:
 *   import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
 *   app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
 *
 * HOW NPM ASSETS WORK (clerk.browser.js etc.):
 * The browser requests /api/__clerk/npm/@clerk/clerk-js@6/dist/clerk.browser.js.
 * The proxy forwards to https://frontend-api.clerk.dev/npm/@clerk/clerk-js@6/...
 * FAPI responds with a 307 redirect to the pinned version on the same domain.
 * http-proxy-middleware passes that 307 through to the browser, which then
 * fetches the large file directly from frontend-api.clerk.dev — no server-side
 * buffering, no timeout. Do NOT add special npm routing or redirects to
 * npm.clerk.dev (that domain is not publicly DNS-resolvable from browsers).
 */

import { createProxyMiddleware } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import { getEffectiveClerkPublishableKey } from "../lib/clerkPublishableKey";

export const CLERK_PROXY_PATH = "/api/__clerk";

/**
 * Derive the Clerk Frontend API (FAPI) base URL from a publishable key.
 *
 * Publishable keys are structured as:
 *   pk_(live|test)_<base64("<fapi-domain>$")>
 *
 * Examples:
 *   pk_live_Y2xlcmsucHJlc2VudGFpbC5jb20k → clerk.presentail.com
 *   pk_test_YmVjb21pbmct...              → becoming-man-73.clerk.accounts.dev
 *
 * Using the wrong FAPI (e.g. the shared frontend-api.clerk.dev for a live
 * custom-domain instance) causes every proxied request to return 401/400 and
 * leaves Clerk in an infinite initialization loop, producing a blank spinner.
 */
export function fapiFromPublishableKey(pk: string | undefined): string {
  if (!pk) return "https://frontend-api.clerk.dev";
  try {
    const payload = pk.replace(/^pk_(live|test)_/, "");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8").replace(/\$$/, "");
    if (!decoded || !decoded.includes(".")) return "https://frontend-api.clerk.dev";
    return `https://${decoded}`;
  } catch {
    return "https://frontend-api.clerk.dev";
  }
}

export function getClerkFapi(
  nodeEnv = process.env.NODE_ENV,
  envPublishableKey = process.env.VITE_CLERK_PUBLISHABLE_KEY,
): string {
  return fapiFromPublishableKey(
    getEffectiveClerkPublishableKey(nodeEnv, envPublishableKey),
  );
}

const CLERK_FAPI = getClerkFapi();

// VITE_CLERK_PROXY_URL is set in [userenv.production] to the public-facing
// proxy URL (e.g. https://os.presentail.com/api/__clerk).  Using it directly
// avoids the Replit autoscale reverse proxy rewriting Host to an internal value
// (e.g. localhost:8080), which would cause Clerk to 401 every proxied request
// because the Clerk-Proxy-Url header wouldn't match the configured proxy URL.
const CONFIGURED_PROXY_URL = process.env.VITE_CLERK_PROXY_URL;

export function clerkProxyMiddleware(): RequestHandler {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return (_req, _res, next) => next();
  }

  // Single proxy for all Clerk requests (FAPI auth calls AND npm asset requests).
  // Auth calls (/v1/*, /v2/*, etc.) are handled by FAPI directly.
  // npm asset requests (/npm/*) receive a 307 redirect from FAPI to the pinned
  // version; http-proxy-middleware forwards that 307 to the browser transparently.
  return createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ""),
    on: {
      proxyReq: (proxyReq, req) => {
        // Prefer the explicitly configured proxy URL (VITE_CLERK_PROXY_URL) so
        // the value always matches what Clerk has on record for this instance.
        // Falling back to the request Host header is unreliable in autoscale
        // environments where the reverse proxy rewrites Host to an internal address.
        let proxyUrl: string;
        if (CONFIGURED_PROXY_URL) {
          proxyUrl = CONFIGURED_PROXY_URL;
        } else {
          const protocol = req.headers["x-forwarded-proto"] || "https";
          const host =
            (req.headers["x-forwarded-host"] as string) ||
            req.headers.host ||
            "";
          proxyUrl = `${protocol}://${host}${CLERK_PROXY_PATH}`;
        }

        proxyReq.setHeader("Clerk-Proxy-Url", proxyUrl);
        proxyReq.setHeader("Clerk-Secret-Key", secretKey);

        const xff = req.headers["x-forwarded-for"];
        const clientIp =
          (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim() ||
          req.socket?.remoteAddress ||
          "";
        if (clientIp) {
          proxyReq.setHeader("X-Forwarded-For", clientIp);
        }
      },
    },
  }) as RequestHandler;
}

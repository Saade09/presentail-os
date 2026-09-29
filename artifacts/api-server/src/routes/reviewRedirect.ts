import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import {
  computeDeviceHash,
  getGoogleReviewUrl,
  isSafeReviewUrl,
  RAPID_SCAN_WINDOW_MINUTES,
} from "../lib/reviewAttribution";

/**
 * Public, unauthenticated scan-redirect for Google Review Rewards.
 *
 * GET /reviews/e/:code — records a scan for the employee profile owning the
 * code, then 302-redirects to the store's Google review URL with
 * Cache-Control: no-store (so every visit is a fresh, logged scan).
 * Invalid or paused codes render a simple fallback page instead.
 *
 * Mounted under /api so the proxy routes QR URLs to the API server in all
 * environments. The full public URL is /api/reviews/e/{code}.
 */
const router: IRouter = Router();

const FALLBACK_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link unavailable</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}main{text-align:center;padding:24px}h1{font-size:20px;margin-bottom:8px}p{color:#475569}</style>
</head>
<body><main><h1>This link is not available</h1><p>The review link you scanned is invalid or no longer active.</p></main></body>
</html>`;

function sendFallback(res: Response): void {
  res.status(404).set("Cache-Control", "no-store").type("html").send(FALLBACK_HTML);
}

router.get("/reviews/e/:code", async (req: Request, res: Response) => {
  const code = String(req.params.code ?? "").trim();
  try {
    const profileRes = await db.query<{
      id: number;
      workspace_owner_id: string;
      is_active: boolean;
      gbp_location_id: number | null;
      location_review_url: string | null;
    }>(
      `SELECT erp.id, erp.workspace_owner_id, erp.is_active, erp.gbp_location_id,
              glc.review_url AS location_review_url
         FROM employee_review_profiles erp
         LEFT JOIN gbp_location_connections glc ON glc.id = erp.gbp_location_id
        WHERE erp.code = $1 AND erp.archived_at IS NULL`,
      [code],
    );
    const profile = profileRes.rows[0];
    if (!profile || !profile.is_active) {
      sendFallback(res);
      return;
    }

    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const userAgent = String(req.headers["user-agent"] ?? "");
    const deviceHash = computeDeviceHash(ip, userAgent);
    const source = typeof req.query.src === "string" ? req.query.src.slice(0, 64) : null;

    // Rapid repeat scans from the same anonymized device hash are flagged
    // (still logged + redirected, but excluded from auto-matching).
    const recent = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM review_scans
        WHERE workspace_owner_id = $1
          AND device_hash = $2
          AND scanned_at > now() - make_interval(mins => $3)`,
      [profile.workspace_owner_id, deviceHash, RAPID_SCAN_WINDOW_MINUTES],
    );
    const flagged = Number(recent.rows[0]?.n ?? 0) > 0;

    // Copy gbp_location_id from the profile so scans are location-scoped and
    // attribution can restrict candidates to the correct location.
    await db.query(
      `INSERT INTO review_scans (workspace_owner_id, profile_id, device_hash, source, flagged, gbp_location_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [profile.workspace_owner_id, profile.id, deviceHash, source, flagged, profile.gbp_location_id],
    );

    // Prefer the per-location review URL stored in gbp_location_connections;
    // validate with the same allowlist as workspace-level URLs so a stored
    // value can never become an open redirect, then fall back gracefully.
    const storedLocationUrl = profile.location_review_url?.trim();
    const targetUrl =
      storedLocationUrl && isSafeReviewUrl(storedLocationUrl)
        ? storedLocationUrl
        : await getGoogleReviewUrl(profile.workspace_owner_id);
    res.set("Cache-Control", "no-store");
    res.redirect(302, targetUrl);
  } catch (err) {
    logger.error({ err, code }, "review scan redirect failed");
    sendFallback(res);
  }
});

export default router;

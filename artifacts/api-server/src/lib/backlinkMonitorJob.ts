/**
 * Backlink Engine — Weekly Link Monitor Job
 *
 * Runs weekly (configurable). For each `live` or recently-lost link, verifies
 * live/lost status, stores a monitor_check row, and updates the link record.
 *
 * Verification strategy:
 *
 *  1. DataForSEO On-Page API (/v3/on_page/instant_pages via verifyLinkAlive)
 *     — crawls the source page in real time and checks outgoing links.
 *       • true  → confirmed live; classification is "live". No HTTP check.
 *       • false → link absent on page; classification is "lost". No HTTP check.
 *                 The existing "retry on first lost" pattern (keep "live" for
 *                 one cycle before finalizing) provides debounce.
 *       • null  → crawl failed / uncertain; fall through to HTTP HEAD.
 *
 *  2. HTTP HEAD fallback — used ONLY when verifyLinkAlive returns null (crawl
 *     error or stub provider). HTTP cannot determine link presence, only page
 *     health, so it drives the full classification (live/lost/redirected/changed)
 *     only in this uncertainty path.
 *
 * Uses FOR UPDATE SKIP LOCKED to be safe under multiple concurrent instances.
 */
import { db } from "./db";
import { logger } from "./logger";
import { getSeoProvider } from "./backlinkProviders";

const MONITOR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const TARGET_DOMAIN = process.env.BACKLINK_TARGET_DOMAIN ?? "presentail.com";

let monitorTimer: ReturnType<typeof setInterval> | null = null;

async function checkUrlHttp(url: string): Promise<{ status: number; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Presentail-BacklinkMonitor/1.0" },
    });
    return { status: res.status, finalUrl: res.url };
  } catch {
    return { status: 0, finalUrl: url };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyHttpStatus(
  httpStatus: number,
  finalUrl: string,
  originalUrl: string,
  originalDest: string,
): "live" | "lost" | "redirected" | "changed" {
  if (httpStatus === 0 || httpStatus >= 500) return "lost";
  if (httpStatus === 404 || httpStatus === 410) return "lost";
  if (finalUrl !== originalUrl && !finalUrl.includes(new URL(originalUrl).hostname)) return "redirected";
  if (finalUrl !== originalDest && finalUrl !== originalUrl) return "changed";
  return "live";
}

type CheckResult = {
  httpStatus: number | null;
  newStatus: "live" | "lost" | "redirected" | "changed";
  /** Which verification path produced the final classification. */
  method: "dataforseo" | "http";
  notes: string | null;
};

/**
 * Checks a single link using the layered verification strategy.
 *
 * DataForSEO on-page crawl is the authoritative source:
 *  - true  → live (crawl confirmed link present)
 *  - false → lost (crawl confirmed link absent)
 *  - null  → uncertain (crawl failed); HTTP HEAD drives the classification
 */
async function checkLink(
  sourceUrl: string,
  destinationUrl: string,
): Promise<CheckResult> {
  let dfsResult: boolean | null = null;
  try {
    const provider = getSeoProvider();
    dfsResult = await provider.verifyLinkAlive(sourceUrl, TARGET_DOMAIN);
  } catch {
    dfsResult = null;
  }

  if (dfsResult === true) {
    return {
      httpStatus: null,
      newStatus: "live",
      method: "dataforseo",
      notes: "Confirmed live via DataForSEO On-Page crawl",
    };
  }

  if (dfsResult === false) {
    // On-Page crawl found no outgoing link to target — authoritative lost signal.
    // HTTP HEAD is not consulted: it can only tell us the page is reachable, not
    // whether our backlink is still present on it.
    return {
      httpStatus: null,
      newStatus: "lost",
      method: "dataforseo",
      notes: "Link absent via DataForSEO On-Page crawl (/v3/on_page/instant_pages)",
    };
  }

  // dfsResult === null: crawl failed or stub provider — fall back to HTTP HEAD
  const { status, finalUrl } = await checkUrlHttp(sourceUrl);
  return {
    httpStatus: status === 0 ? null : status,
    newStatus: classifyHttpStatus(status, finalUrl, sourceUrl, destinationUrl),
    method: "http",
    notes: finalUrl !== sourceUrl ? `Final URL: ${finalUrl}` : null,
  };
}

export async function runBacklinkMonitorSweep(): Promise<void> {
  // Pick links due for a check (not checked in last 6 days, or never checked)
  const links = await db.query(
    `SELECT l.* FROM backlink_links l
     WHERE l.status IN ('live', 'lost')
       AND (l.last_checked_at IS NULL OR l.last_checked_at < now() - INTERVAL '6 days')
     ORDER BY l.last_checked_at ASC NULLS FIRST
     LIMIT 200
     FOR UPDATE SKIP LOCKED`,
  );

  for (const link of links.rows as Array<Record<string, unknown>>) {
    try {
      const { httpStatus, newStatus, method, notes } = await checkLink(
        String(link.source_url),
        String(link.destination_url),
      );

      // Write check record
      await db.query(
        `INSERT INTO backlink_monitor_checks (link_id, http_status, rel_type, anchor_text, destination_url, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          link.id,
          httpStatus,
          link.rel_type,
          link.anchor_text,
          link.destination_url,
          newStatus,
          notes,
        ],
      );

      // Retry pattern: if previously live and now lost, keep live for one more
      // cycle before finalizing the lost status. This guards against transient
      // crawl issues (both DataForSEO and HTTP can have one-off failures).
      let finalStatus = newStatus;
      if (String(link.status) === "live" && newStatus === "lost") {
        finalStatus = "live";
      }

      await db.query(
        `UPDATE backlink_links SET status = $1, last_checked_at = now(), http_status = $2 WHERE id = $3`,
        [finalStatus, httpStatus, link.id],
      );

      logger.debug({ linkId: link.id, newStatus, method }, "backlink: monitor check complete");
    } catch (err) {
      logger.warn({ err, linkId: link.id }, "backlink: monitor check failed for link");
    }
  }
  logger.info({ checked: links.rows.length }, "backlink: monitor sweep complete");
}

export function startBacklinkMonitorJob(): void {
  const tick = async () => {
    try {
      await runBacklinkMonitorSweep();
    } catch (err) {
      logger.warn({ err }, "backlink: monitor job error");
    }
  };
  monitorTimer = setInterval(tick, MONITOR_INTERVAL_MS);
  // Run 10 minutes after startup
  setTimeout(tick, 10 * 60 * 1000);
  logger.info("Backlink Engine monitor job started");
}

export function stopBacklinkMonitorJob(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

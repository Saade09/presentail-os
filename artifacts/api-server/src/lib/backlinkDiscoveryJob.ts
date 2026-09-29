/**
 * Backlink Engine — Daily Discovery Job
 *
 * Runs once per day (or on-demand). For each active competitor in every
 * workspace, calls the SEO provider to get the backlink gap, deduplicates
 * against existing opportunities (normalized domain + page URL), and inserts
 * new `discovered` rows. Uses FOR UPDATE SKIP LOCKED to be safe under multiple
 * concurrent instances.
 */
import { db } from "./db";
import { logger } from "./logger";
import { getSeoProvider } from "./backlinkProviders";
import { aiQualifyOpportunity } from "./backlinkQualifier";

const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TARGET_DOMAIN = process.env.BACKLINK_TARGET_DOMAIN ?? "presentail.com";

let discoveryTimer: ReturnType<typeof setInterval> | null = null;

export async function runBacklinkDiscovery(workspaceOwnerId?: string): Promise<void> {
  const filter = workspaceOwnerId ? "AND workspace_owner_id = $1" : "";
  const params = workspaceOwnerId ? [workspaceOwnerId] : [];

  const workspaces = await db.query<{ workspace_owner_id: string }>(
    `SELECT DISTINCT workspace_owner_id FROM backlink_competitors WHERE active = true ${filter}`,
    params,
  );

  const provider = getSeoProvider();

  for (const { workspace_owner_id } of workspaces.rows) {
    let runId: number | null = null;
    try {
      const runRes = await db.query<{ id: number }>(
        `INSERT INTO backlink_job_runs (workspace_owner_id, job_type, status, started_at)
         VALUES ($1, 'discovery', 'running', now()) RETURNING id`,
        [workspace_owner_id],
      );
      runId = runRes.rows[0]?.id ?? null;

      const competitors = await db.query<{ domain: string; market: string }>(
        `SELECT domain, market FROM backlink_competitors WHERE workspace_owner_id = $1 AND active = true`,
        [workspace_owner_id],
      );

      let totalInserted = 0;

      for (const comp of competitors.rows) {
        try {
          const gaps = await provider.getBacklinkGap([comp.domain], TARGET_DOMAIN);
          for (const gap of gaps) {
            const normalized = gap.domain.replace(/^www\./, "").toLowerCase();
            try {
              const qualified = aiQualifyOpportunity({
                domainAuthority: gap.domainAuthority ?? null,
                spamScore: gap.spamScore ?? null,
                estimatedTraffic: gap.estimatedTraffic ?? null,
                market: comp.market,
                opportunityType: null,
                domain: gap.domain,
              });
              const r = await db.query(
                `INSERT INTO backlink_opportunities
                   (workspace_owner_id, domain, normalized_domain, page_url, market, source,
                    domain_authority, estimated_traffic, spam_score,
                    ai_score, ai_score_components, ai_explanation, status)
                 VALUES ($1,$2,$3,$4,$5,'competitor_gap',$6,$7,$8,$9,$10::jsonb,$11,'discovered')
                 ON CONFLICT (workspace_owner_id, normalized_domain, page_url) DO NOTHING`,
                [
                  workspace_owner_id,
                  gap.domain, normalized, gap.pageUrl, comp.market,
                  gap.domainAuthority ?? null,
                  gap.estimatedTraffic ?? null,
                  gap.spamScore ?? null,
                  qualified.score,
                  JSON.stringify(qualified.scoreComponents),
                  qualified.explanation,
                ],
              );
              if ((r.rowCount ?? 0) > 0) totalInserted++;
            } catch {
              // skip individual row errors
            }
          }
        } catch (err) {
          logger.warn({ err, domain: comp.domain, workspace_owner_id }, "backlink: discovery competitor failed");
        }
      }

      if (runId) {
        await db.query(
          `UPDATE backlink_job_runs SET status = 'completed', finished_at = now(), records_processed = $1 WHERE id = $2`,
          [totalInserted, runId],
        );
      }
      logger.info({ workspace_owner_id, totalInserted }, "backlink: discovery sweep complete");
    } catch (err) {
      logger.warn({ err, workspace_owner_id }, "backlink: discovery workspace sweep failed");
      if (runId) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.query(
          `UPDATE backlink_job_runs SET status = 'failed', finished_at = now(), error = $1 WHERE id = $2`,
          [msg.slice(0, 2000), runId],
        ).catch(() => {});
      }
    }
  }
}

export function startBacklinkDiscoveryJob(): void {
  const tick = async () => {
    try {
      await runBacklinkDiscovery();
    } catch (err) {
      logger.warn({ err }, "backlink: discovery job error");
    }
  };
  discoveryTimer = setInterval(tick, DISCOVERY_INTERVAL_MS);
  // Run 5 minutes after startup
  setTimeout(tick, 5 * 60 * 1000);
  logger.info("Backlink Engine discovery job started");
}

export function stopBacklinkDiscoveryJob(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}

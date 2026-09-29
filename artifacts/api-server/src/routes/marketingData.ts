import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

router.use(requireAuth, resolveWorkspace);

function isOwner(req: Parameters<typeof workspace>[0]): boolean {
  return workspace(req).workspaceRole === "owner";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Ad spend ────────────────────────────────────────────────────────────────

const AD_SPEND_COLS =
  "id, channel, campaign, campaign_external_id, period_start, period_end, spend_amount, currency, impressions, clicks, conversions, source, notes, created_at, updated_at";

const adSpendEntrySchema = z.object({
  channel: z.string().min(1).max(100),
  campaign: z.string().max(300).nullish(),
  campaignExternalId: z.string().max(300).nullish(),
  periodStart: z.string().regex(DATE_RE, "Invalid date (YYYY-MM-DD)"),
  periodEnd: z.string().regex(DATE_RE, "Invalid date (YYYY-MM-DD)"),
  spendAmount: z.number().min(0),
  currency: z.string().min(1).max(10).default("AED"),
  impressions: z.number().int().min(0).nullish(),
  clicks: z.number().int().min(0).nullish(),
  conversions: z.number().int().min(0).nullish(),
  source: z.string().max(50).default("manual"),
  notes: z.string().max(2000).nullish(),
});

const adSpendBodySchema = z.union([
  adSpendEntrySchema,
  z.object({ entries: z.array(adSpendEntrySchema).min(1).max(500) }),
]);

/** GET /api/ad-spend — list ad spend entries (owner only). */
router.get("/ad-spend", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;

  const params: unknown[] = [ownerId];
  const where: string[] = ["workspace_owner_id = $1"];
  if (typeof req.query.channel === "string" && req.query.channel) {
    params.push(req.query.channel);
    where.push(`channel = $${params.length}`);
  }
  if (typeof req.query.from === "string" && DATE_RE.test(req.query.from)) {
    params.push(req.query.from);
    where.push(`period_end >= $${params.length}`);
  }
  if (typeof req.query.to === "string" && DATE_RE.test(req.query.to)) {
    params.push(req.query.to);
    where.push(`period_start <= $${params.length}`);
  }

  const result = await db.query(
    `SELECT ${AD_SPEND_COLS} FROM ad_spend_entries
      WHERE ${where.join(" AND ")}
      ORDER BY period_start DESC, channel ASC`,
    params,
  );
  res.json({ entries: result.rows });
});

/**
 * POST /api/ad-spend — create or upsert one or many ad spend entries
 * (owner only). Idempotent on (channel, campaign, period_start, period_end):
 * re-posting the same slot updates it rather than duplicating.
 */
router.post("/ad-spend", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const parsed = adSpendBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;
  const entries = "entries" in parsed.data ? parsed.data.entries : [parsed.data];

  // Pre-validate the whole batch before writing anything, so a bad row never
  // leaves a partially-applied batch behind.
  if (entries.some((e) => e.periodStart > e.periodEnd)) {
    res.status(400).json({ error: "period_start must be on or before period_end" });
    return;
  }

  const saved: unknown[] = [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const e of entries) {
      const result = await client.query(
        `INSERT INTO ad_spend_entries
           (workspace_owner_id, channel, campaign, campaign_external_id, period_start, period_end,
            spend_amount, currency, impressions, clicks, conversions, source, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (workspace_owner_id, channel, campaign, period_start, period_end)
         DO UPDATE SET
           campaign_external_id = EXCLUDED.campaign_external_id,
           spend_amount = EXCLUDED.spend_amount,
           currency = EXCLUDED.currency,
           impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks,
           conversions = EXCLUDED.conversions,
           source = EXCLUDED.source,
           notes = EXCLUDED.notes,
           updated_at = now()
         RETURNING ${AD_SPEND_COLS}`,
        [
          ownerId,
          e.channel,
          e.campaign ?? null,
          e.campaignExternalId ?? null,
          e.periodStart,
          e.periodEnd,
          e.spendAmount,
          e.currency,
          e.impressions ?? null,
          e.clicks ?? null,
          e.conversions ?? null,
          e.source,
          e.notes ?? null,
        ],
      );
      saved.push(result.rows[0]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ entries: saved });
});

/** PATCH /api/ad-spend/:id — update a single ad spend entry (owner only). */
router.patch("/ad-spend/:id", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;

  const parsed = adSpendEntrySchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (d.channel !== undefined) push("channel", d.channel);
  if (d.campaign !== undefined) push("campaign", d.campaign ?? null);
  if (d.campaignExternalId !== undefined) push("campaign_external_id", d.campaignExternalId ?? null);
  if (d.periodStart !== undefined) push("period_start", d.periodStart);
  if (d.periodEnd !== undefined) push("period_end", d.periodEnd);
  if (d.spendAmount !== undefined) push("spend_amount", d.spendAmount);
  if (d.currency !== undefined) push("currency", d.currency);
  if (d.impressions !== undefined) push("impressions", d.impressions ?? null);
  if (d.clicks !== undefined) push("clicks", d.clicks ?? null);
  if (d.conversions !== undefined) push("conversions", d.conversions ?? null);
  if (d.source !== undefined) push("source", d.source);
  if (d.notes !== undefined) push("notes", d.notes ?? null);

  params.push(id, ownerId);
  const result = await db.query(
    `UPDATE ad_spend_entries SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
      RETURNING ${AD_SPEND_COLS}`,
    params,
  );
  if (!result.rowCount) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ entry: result.rows[0] });
});

/** DELETE /api/ad-spend/:id — delete a single ad spend entry (owner only). */
router.delete("/ad-spend/:id", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  const result = await db.query(
    `DELETE FROM ad_spend_entries WHERE id = $1 AND workspace_owner_id = $2`,
    [id, ownerId],
  );
  if (!result.rowCount) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

// ── SEO metrics ───────────────────────────────────────────────────────────────

const SEO_COLS =
  "id, period_start, period_end, landing_page, query, impressions, clicks, ctr, avg_position, source, created_at, updated_at";

const seoMetricSchema = z.object({
  periodStart: z.string().regex(DATE_RE, "Invalid date (YYYY-MM-DD)"),
  periodEnd: z.string().regex(DATE_RE, "Invalid date (YYYY-MM-DD)"),
  landingPage: z.string().max(2000).nullish(),
  query: z.string().max(500).nullish(),
  impressions: z.number().int().min(0).default(0),
  clicks: z.number().int().min(0).default(0),
  ctr: z.number().min(0).nullish(),
  avgPosition: z.number().min(0).nullish(),
  source: z.string().max(50).default("manual"),
});

const seoBodySchema = z.union([
  seoMetricSchema,
  z.object({ metrics: z.array(seoMetricSchema).min(1).max(500) }),
]);

/** GET /api/seo-metrics — list SEO metrics (owner only). */
router.get("/seo-metrics", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;

  const params: unknown[] = [ownerId];
  const where: string[] = ["workspace_owner_id = $1"];
  if (typeof req.query.from === "string" && DATE_RE.test(req.query.from)) {
    params.push(req.query.from);
    where.push(`period_end >= $${params.length}`);
  }
  if (typeof req.query.to === "string" && DATE_RE.test(req.query.to)) {
    params.push(req.query.to);
    where.push(`period_start <= $${params.length}`);
  }

  const result = await db.query(
    `SELECT ${SEO_COLS} FROM seo_metrics
      WHERE ${where.join(" AND ")}
      ORDER BY period_start DESC, clicks DESC`,
    params,
  );
  res.json({ metrics: result.rows });
});

/**
 * POST /api/seo-metrics — create or upsert one or many SEO metric rows
 * (owner only). Idempotent on (period_start, period_end, landing_page, query).
 */
router.post("/seo-metrics", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const parsed = seoBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;
  const metrics = "metrics" in parsed.data ? parsed.data.metrics : [parsed.data];

  // Pre-validate the whole batch before writing anything, so a bad row never
  // leaves a partially-applied batch behind.
  if (metrics.some((m) => m.periodStart > m.periodEnd)) {
    res.status(400).json({ error: "period_start must be on or before period_end" });
    return;
  }

  const saved: unknown[] = [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const m of metrics) {
      const result = await client.query(
        `INSERT INTO seo_metrics
           (workspace_owner_id, period_start, period_end, landing_page, query,
            impressions, clicks, ctr, avg_position, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (workspace_owner_id, period_start, period_end, landing_page, query)
         DO UPDATE SET
           impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks,
           ctr = EXCLUDED.ctr,
           avg_position = EXCLUDED.avg_position,
           source = EXCLUDED.source,
           updated_at = now()
         RETURNING ${SEO_COLS}`,
        [
          ownerId,
          m.periodStart,
          m.periodEnd,
          m.landingPage ?? null,
          m.query ?? null,
          m.impressions,
          m.clicks,
          m.ctr ?? null,
          m.avgPosition ?? null,
          m.source,
        ],
      );
      saved.push(result.rows[0]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ metrics: saved });
});

/** DELETE /api/seo-metrics/:id — delete a single SEO metric row (owner only). */
router.delete("/seo-metrics/:id", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  const result = await db.query(
    `DELETE FROM seo_metrics WHERE id = $1 AND workspace_owner_id = $2`,
    [id, ownerId],
  );
  if (!result.rowCount) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

export default router;

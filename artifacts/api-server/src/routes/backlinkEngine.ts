import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, hasPageAccess, workspace } from "../lib/workspace";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { recordBacklinkAudit } from "../lib/backlinkAudit";
import { getSeoProvider, getSeoProviderStatus } from "../lib/backlinkProviders";
import { aiQualifyOpportunity } from "../lib/backlinkQualifier";

const router = Router();
router.use(requireAuth, resolveWorkspace);

function requireBacklinkAccess(req: Request, res: Response): boolean {
  const wreq = workspace(req);
  if (!hasPageAccess(wreq, "backlink-engine")) {
    res.status(403).json({ error: "Access denied" });
    return false;
  }
  return true;
}

function requireManageAccess(req: Request, res: Response): boolean {
  const wreq = workspace(req);
  if (!hasPageAccess(wreq, "backlink-engine") || (!wreq.allowedPages?.includes("backlink-engine.manage") && wreq.workspaceRole !== "owner")) {
    res.status(403).json({ error: "Manage permission required" });
    return false;
  }
  return true;
}

// ─── Overview ─────────────────────────────────────────────────────────────────

router.get("/backlink-engine/overview", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  try {
    type KpiRow = {
      total_opportunities: string;
      qualified: string;
      outreach_sent: string;
      backlinks_won: string;
      lost_links: string;
    };
    const kpiRes = await db.query<KpiRow>(
      `SELECT
         COUNT(DISTINCT o.id) FILTER (WHERE o.status NOT IN ('archived','rejected')) AS total_opportunities,
         COUNT(DISTINCT o.id) FILTER (WHERE o.status IN ('qualified','approved')) AS qualified,
         COUNT(DISTINCT m.id) FILTER (WHERE m.status IN ('sent','delivered','replied','interested')) AS outreach_sent,
         COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'live') AS backlinks_won,
         COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'lost') AS lost_links
       FROM backlink_opportunities o
       LEFT JOIN backlink_messages m ON m.opportunity_id = o.id
       LEFT JOIN backlink_links l ON l.workspace_owner_id = o.workspace_owner_id
       WHERE o.workspace_owner_id = $1`,
      [wreq.workspaceOwnerId],
    );
    const kpi = kpiRes.rows[0] ?? {};

    const topRes = await db.query(
      `SELECT id, domain, page_url, opportunity_type, market, ai_score, status, last_activity_at
       FROM backlink_opportunities
       WHERE workspace_owner_id = $1 AND status NOT IN ('archived','rejected')
       ORDER BY ai_score DESC NULLS LAST, created_at DESC
       LIMIT 10`,
      [wreq.workspaceOwnerId],
    );

    type TrendRow = { week: string; won: string };
    const trendRes = await db.query<TrendRow>(
      `SELECT date_trunc('week', first_seen_at) AS week, COUNT(*) AS won
       FROM backlink_links
       WHERE workspace_owner_id = $1 AND status = 'live'
         AND first_seen_at >= now() - INTERVAL '12 weeks'
       GROUP BY 1 ORDER BY 1`,
      [wreq.workspaceOwnerId],
    );

    res.json({
      kpi: {
        totalOpportunities: parseInt(String(kpi.total_opportunities ?? "0"), 10),
        qualified: parseInt(String(kpi.qualified ?? "0"), 10),
        outreachSent: parseInt(String(kpi.outreach_sent ?? "0"), 10),
        backlinksWon: parseInt(String(kpi.backlinks_won ?? "0"), 10),
        lostLinks: parseInt(String(kpi.lost_links ?? "0"), 10),
      },
      topOpportunities: topRes.rows,
      backlinksWonTrend: trendRes.rows.map((r) => ({
        week: r.week,
        won: parseInt(r.won, 10),
      })),
    });
  } catch (err) {
    logger.error({ err }, "backlink-engine: overview failed");
    res.status(500).json({ error: "Failed to load overview" });
  }
});

// ─── Competitors ──────────────────────────────────────────────────────────────

router.get("/backlink-engine/competitors", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  try {
    const rows = await db.query(
      `SELECT * FROM backlink_competitors WHERE workspace_owner_id = $1 ORDER BY market, domain`,
      [wreq.workspaceOwnerId],
    );
    res.json({ competitors: rows.rows });
  } catch (err) {
    logger.error({ err }, "backlink-engine: competitors list failed");
    res.status(500).json({ error: "Failed to list competitors" });
  }
});

const competitorSchema = z.object({
  domain: z.string().min(1).max(500),
  market: z.enum(["uae", "lb", "global"]).default("uae"),
  active: z.boolean().default(true),
});

router.post("/backlink-engine/competitors", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const parsed = competitorSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const r = await db.query(
      `INSERT INTO backlink_competitors (workspace_owner_id, domain, market, active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [wreq.workspaceOwnerId, parsed.data.domain.toLowerCase().trim(), parsed.data.market, parsed.data.active],
    );
    await recordBacklinkAudit(wreq, "competitor", r.rows[0].id, "created", { domain: parsed.data.domain });
    res.status(201).json({ competitor: r.rows[0] });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "23505") { res.status(409).json({ error: "Competitor domain already exists" }); return; }
    logger.error({ err }, "backlink-engine: create competitor failed");
    res.status(500).json({ error: "Failed to create competitor" });
  }
});

router.patch("/backlink-engine/competitors/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  const parsed = competitorSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (parsed.data.domain !== undefined) { fields.push(`domain = $${idx++}`); values.push(parsed.data.domain.toLowerCase().trim()); }
    if (parsed.data.market !== undefined) { fields.push(`market = $${idx++}`); values.push(parsed.data.market); }
    if (parsed.data.active !== undefined) { fields.push(`active = $${idx++}`); values.push(parsed.data.active); }
    if (fields.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
    values.push(id, wreq.workspaceOwnerId);
    const r = await db.query(
      `UPDATE backlink_competitors SET ${fields.join(", ")} WHERE id = $${idx++} AND workspace_owner_id = $${idx} RETURNING *`,
      values,
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    await recordBacklinkAudit(wreq, "competitor", id, "updated");
    res.json({ competitor: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: update competitor failed");
    res.status(500).json({ error: "Failed to update competitor" });
  }
});

router.delete("/backlink-engine/competitors/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  try {
    await db.query(
      `DELETE FROM backlink_competitors WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    await recordBacklinkAudit(wreq, "competitor", id, "deleted");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "backlink-engine: delete competitor failed");
    res.status(500).json({ error: "Failed to delete competitor" });
  }
});

// Trigger competitor sync (calls SEO provider)
router.post("/backlink-engine/competitors/:id/sync", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  try {
    const compRes = await db.query<{ domain: string; market: string }>(
      `SELECT domain, market FROM backlink_competitors WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    const comp = compRes.rows[0];
    if (!comp) { res.status(404).json({ error: "Competitor not found" }); return; }

    const provider = getSeoProvider();
    const gaps = await provider.getBacklinkGap([comp.domain], "presentail.com");

    let inserted = 0;
    for (const gap of gaps) {
      const normalized = gap.domain.replace(/^www\./, "").toLowerCase();
      try {
        await db.query(
          `INSERT INTO backlink_opportunities
             (workspace_owner_id, domain, normalized_domain, page_url, market, source, domain_authority, estimated_traffic, spam_score, status)
           VALUES ($1, $2, $3, $4, $5, 'competitor_gap', $6, $7, $8, 'discovered')
           ON CONFLICT (workspace_owner_id, normalized_domain, page_url) DO NOTHING`,
          [wreq.workspaceOwnerId, gap.domain, normalized, gap.pageUrl, comp.market, gap.domainAuthority ?? null, gap.estimatedTraffic ?? null, gap.spamScore ?? null],
        );
        inserted++;
      } catch { /* skip individual duplicates */ }
    }

    await db.query(
      `UPDATE backlink_competitors SET last_synced_at = now() WHERE id = $1`,
      [id],
    );
    await recordBacklinkAudit(wreq, "competitor", id, "synced", { discovered: inserted });
    res.json({ ok: true, discovered: inserted });
  } catch (err) {
    logger.error({ err }, "backlink-engine: competitor sync failed");
    res.status(500).json({ error: "Sync failed" });
  }
});

// ─── Opportunities ────────────────────────────────────────────────────────────

router.get("/backlink-engine/opportunities", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;
  const market = req.query.market as string | undefined;
  const q = req.query.q as string | undefined;
  const minScore = req.query.minScore ? parseFloat(String(req.query.minScore)) : undefined;
  const source = req.query.source as string | undefined;

  try {
    const conditions: string[] = ["workspace_owner_id = $1"];
    const values: unknown[] = [wreq.workspaceOwnerId];
    let idx = 2;

    if (status) { conditions.push(`status = $${idx++}`); values.push(status); }
    if (market) { conditions.push(`market = $${idx++}`); values.push(market); }
    if (q) { conditions.push(`(domain ILIKE $${idx} OR page_url ILIKE $${idx})`); values.push(`%${q}%`); idx++; }
    if (minScore !== undefined) { conditions.push(`ai_score >= $${idx++}`); values.push(minScore); }
    if (source) { conditions.push(`source = $${idx++}`); values.push(source); }

    const where = conditions.join(" AND ");

    type CountRow = { total: string };
    const countRes = await db.query<CountRow>(
      `SELECT COUNT(*) AS total FROM backlink_opportunities WHERE ${where}`,
      values,
    );
    const total = parseInt(countRes.rows[0]?.total ?? "0", 10);

    const dataRes = await db.query(
      `SELECT o.*, (
         SELECT json_agg(json_build_object('id',n.id,'body',n.body,'createdAt',n.created_at,'userId',n.user_id))
         FROM backlink_opportunity_notes n WHERE n.opportunity_id = o.id
       ) AS notes
       FROM backlink_opportunities o
       WHERE ${where}
       ORDER BY ai_score DESC NULLS LAST, created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset],
    );

    res.json({ opportunities: dataRes.rows, total, page, limit });
  } catch (err) {
    logger.error({ err }, "backlink-engine: opportunities list failed");
    res.status(500).json({ error: "Failed to list opportunities" });
  }
});

const opportunitySchema = z.object({
  domain: z.string().min(1).max(500),
  pageUrl: z.string().url(),
  opportunityType: z.string().max(100).optional().nullable(),
  market: z.enum(["uae", "lb", "global"]).default("uae"),
  source: z.string().max(100).optional().nullable(),
  destinationUrl: z.string().url().optional().nullable(),
  domainAuthority: z.number().min(0).max(100).optional().nullable(),
  estimatedTraffic: z.number().int().min(0).optional().nullable(),
  spamScore: z.number().min(0).max(100).optional().nullable(),
});

router.post("/backlink-engine/opportunities", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const parsed = opportunitySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const d = parsed.data;
    const normalized = d.domain.replace(/^www\./, "").toLowerCase();
    const r = await db.query(
      `INSERT INTO backlink_opportunities
         (workspace_owner_id, domain, normalized_domain, page_url, opportunity_type, market, source, destination_url, domain_authority, estimated_traffic, spam_score, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'discovered')
       ON CONFLICT (workspace_owner_id, normalized_domain, page_url) DO NOTHING
       RETURNING *`,
      [wreq.workspaceOwnerId, d.domain, normalized, d.pageUrl, d.opportunityType ?? null, d.market, d.source ?? "manual", d.destinationUrl ?? null, d.domainAuthority ?? null, d.estimatedTraffic ?? null, d.spamScore ?? null],
    );
    if (!r.rows[0]) { res.status(409).json({ error: "Opportunity already exists for this domain+page" }); return; }
    await recordBacklinkAudit(wreq, "opportunity", r.rows[0].id, "created");
    res.status(201).json({ opportunity: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: create opportunity failed");
    res.status(500).json({ error: "Failed to create opportunity" });
  }
});

const VALID_STATUSES = ["discovered", "qualified", "approved", "rejected", "archived"];

router.patch("/backlink-engine/opportunities/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  const body = req.body as Record<string, unknown> ?? {};

  // Manage actions require manage permission
  const manageActions = ["approved", "rejected", "archived"];
  if (body.status && manageActions.includes(String(body.status))) {
    if (!requireManageAccess(req, res)) return;
  }

  try {
    const fields: string[] = ["updated_at = now()", "last_activity_at = now()"];
    const values: unknown[] = [];
    let idx = 1;

    if (body.status && VALID_STATUSES.includes(String(body.status))) {
      fields.push(`status = $${idx++}`); values.push(body.status);
    }
    if (body.ownerUserId !== undefined) { fields.push(`owner_user_id = $${idx++}`); values.push(body.ownerUserId); }
    if (body.aiScore !== undefined) { fields.push(`ai_score = $${idx++}`); values.push(body.aiScore); }
    if (body.aiExplanation !== undefined) { fields.push(`ai_explanation = $${idx++}`); values.push(body.aiExplanation); }
    if (body.destinationUrl !== undefined) { fields.push(`destination_url = $${idx++}`); values.push(body.destinationUrl); }

    values.push(id, wreq.workspaceOwnerId);
    const r = await db.query(
      `UPDATE backlink_opportunities SET ${fields.join(", ")} WHERE id = $${idx++} AND workspace_owner_id = $${idx} RETURNING *`,
      values,
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    if (body.status) {
      await recordBacklinkAudit(wreq, "opportunity", id, String(body.status), { prevStatus: body.status });
    }
    res.json({ opportunity: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: update opportunity failed");
    res.status(500).json({ error: "Failed to update opportunity" });
  }
});

// Score (or re-score) an opportunity using the built-in qualifier
router.post("/backlink-engine/opportunities/:id/score", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  try {
    type OppRow = { domain_authority: string | null; spam_score: string | null; estimated_traffic: number | null; market: string; opportunity_type: string | null; domain: string };
    const r = await db.query<OppRow>(
      `SELECT domain_authority, spam_score, estimated_traffic, market, opportunity_type, domain
       FROM backlink_opportunities WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    const opp = r.rows[0];
    if (!opp) { res.status(404).json({ error: "Not found" }); return; }

    const result = aiQualifyOpportunity({
      domainAuthority: opp.domain_authority != null ? parseFloat(opp.domain_authority) : null,
      spamScore: opp.spam_score != null ? parseFloat(opp.spam_score) : null,
      estimatedTraffic: opp.estimated_traffic,
      market: opp.market,
      opportunityType: opp.opportunity_type,
      domain: opp.domain,
    });

    const updated = await db.query(
      `UPDATE backlink_opportunities
       SET ai_score = $1, ai_score_components = $2::jsonb, ai_explanation = $3, updated_at = now()
       WHERE id = $4 AND workspace_owner_id = $5
       RETURNING *`,
      [result.score, JSON.stringify(result.scoreComponents), result.explanation, id, wreq.workspaceOwnerId],
    );
    await recordBacklinkAudit(wreq, "opportunity", id, "scored", { score: result.score });
    res.json({ opportunity: updated.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: score opportunity failed");
    res.status(500).json({ error: "Failed to score opportunity" });
  }
});

router.post("/backlink-engine/opportunities/:id/notes", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  const body = z.object({ body: z.string().min(1).max(5000) }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Note body required" }); return; }
  try {
    const owns = await db.query(
      `SELECT id FROM backlink_opportunities WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (!owns.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const r = await db.query(
      `INSERT INTO backlink_opportunity_notes (opportunity_id, user_id, body) VALUES ($1,$2,$3) RETURNING *`,
      [id, wreq.userId, body.data.body],
    );
    res.status(201).json({ note: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: add note failed");
    res.status(500).json({ error: "Failed to add note" });
  }
});

// ─── Campaigns ────────────────────────────────────────────────────────────────

router.get("/backlink-engine/campaigns", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  try {
    const rows = await db.query(
      `SELECT c.*,
         COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'draft') AS draft_count,
         COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'approved') AS approved_count,
         COUNT(DISTINCT m.id) FILTER (WHERE m.status IN ('sent','delivered')) AS sent_count
       FROM backlink_campaigns c
       LEFT JOIN backlink_messages m ON m.campaign_id = c.id
       WHERE c.workspace_owner_id = $1
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ campaigns: rows.rows });
  } catch (err) {
    logger.error({ err }, "backlink-engine: campaigns list failed");
    res.status(500).json({ error: "Failed to list campaigns" });
  }
});

const campaignSchema = z.object({
  name: z.string().min(1).max(200),
  market: z.string().max(50).optional().nullable(),
  opportunityType: z.string().max(100).optional().nullable(),
  targetUrl: z.string().max(2000).optional().nullable(),
  contentAsset: z.string().max(2000).optional().nullable(),
  coolingPeriodDays: z.number().int().min(0).max(365).default(30),
  maxFollowups: z.number().int().min(0).max(5).default(2),
});

router.post("/backlink-engine/campaigns", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const parsed = campaignSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const d = parsed.data;
    const r = await db.query(
      `INSERT INTO backlink_campaigns (workspace_owner_id, name, market, opportunity_type, target_url, content_asset, cooling_period_days, max_followups)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [wreq.workspaceOwnerId, d.name, d.market ?? null, d.opportunityType ?? null, d.targetUrl ?? null, d.contentAsset ?? null, d.coolingPeriodDays, d.maxFollowups],
    );
    await recordBacklinkAudit(wreq, "campaign", r.rows[0].id, "created");
    res.status(201).json({ campaign: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: create campaign failed");
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

router.get("/backlink-engine/campaigns/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  try {
    const r = await db.query(
      `SELECT c.*, (
         SELECT json_agg(m.* ORDER BY m.created_at ASC)
         FROM backlink_messages m WHERE m.campaign_id = c.id
       ) AS messages
       FROM backlink_campaigns c
       WHERE c.id = $1 AND c.workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ campaign: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: campaign detail failed");
    res.status(500).json({ error: "Failed to load campaign" });
  }
});

// Generate AI draft message for an opportunity+contact
router.post("/backlink-engine/campaigns/:id/messages/generate", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const campaignId = parseInt(String(req.params.id), 10);
  const body = z.object({ opportunityId: z.number().int(), contactId: z.number().int().optional() }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "opportunityId required" }); return; }
  try {
    const opp = await db.query(
      `SELECT * FROM backlink_opportunities WHERE id = $1 AND workspace_owner_id = $2`,
      [body.data.opportunityId, wreq.workspaceOwnerId],
    );
    if (!opp.rows[0]) { res.status(404).json({ error: "Opportunity not found" }); return; }
    const o = opp.rows[0] as Record<string, unknown>;

    let contact: Record<string, unknown> | null = null;
    if (body.data.contactId) {
      const cr = await db.query(`SELECT * FROM backlink_contacts WHERE id = $1 AND opportunity_id = $2`, [body.data.contactId, body.data.opportunityId]);
      contact = cr.rows[0] as Record<string, unknown> ?? null;
    }

    const subject = `Partnership opportunity — ${o.domain ?? "your site"}`;
    const recipientName = contact?.name ? String(contact.name) : "there";
    const bodyText = `Hi ${recipientName},\n\nI came across ${o.page_url ?? o.domain} and noticed you cover topics relevant to our audience.\n\nWe're Presentail — a premium flower and gift delivery service in the UAE. We'd love to explore a collaboration or link exchange that adds value to your readers.\n\nWould you be open to a quick chat?\n\nBest regards,\nThe Presentail Team`;

    const existing = await db.query(
      `SELECT id FROM backlink_messages WHERE campaign_id = $1 AND opportunity_id = $2 AND sequence_number = 1`,
      [campaignId, body.data.opportunityId],
    );
    if (existing.rows[0]) {
      // Update existing draft
      await db.query(
        `UPDATE backlink_messages SET subject = $1, body = $2, status = 'draft', updated_at = now() WHERE id = $3 RETURNING *`,
        [subject, bodyText, existing.rows[0].id],
      );
      const updated = await db.query(`SELECT * FROM backlink_messages WHERE id = $1`, [existing.rows[0].id]);
      res.json({ message: updated.rows[0] });
    } else {
      const r = await db.query(
        `INSERT INTO backlink_messages (campaign_id, opportunity_id, contact_id, subject, body, status, sequence_number)
         VALUES ($1,$2,$3,$4,$5,'draft',1) RETURNING *`,
        [campaignId, body.data.opportunityId, body.data.contactId ?? null, subject, bodyText],
      );
      res.status(201).json({ message: r.rows[0] });
    }
  } catch (err) {
    logger.error({ err }, "backlink-engine: generate message failed");
    res.status(500).json({ error: "Failed to generate message" });
  }
});

// Approve a message
router.post("/backlink-engine/campaigns/:id/messages/:msgId/approve", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const msgId = parseInt(String(req.params.msgId), 10);
  const campaignId = parseInt(String(req.params.id), 10);
  try {
    const r = await db.query(
      `UPDATE backlink_messages SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2 AND campaign_id = $3 AND status = 'draft'
       RETURNING *`,
      [wreq.userId, msgId, campaignId],
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Message not found or already approved" }); return; }
    await recordBacklinkAudit(wreq, "message", msgId, "approved");
    res.json({ message: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: approve message failed");
    res.status(500).json({ error: "Failed to approve message" });
  }
});

// Send a message (idempotent — 409 if already sent)
router.post("/backlink-engine/campaigns/:id/messages/:msgId/send", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const msgId = parseInt(String(req.params.msgId), 10);
  const campaignId = parseInt(String(req.params.id), 10);
  try {
    const msgRes = await db.query(
      `SELECT m.*, bc.email AS contact_email
       FROM backlink_messages m
       LEFT JOIN backlink_contacts bc ON bc.id = m.contact_id
       WHERE m.id = $1 AND m.campaign_id = $2`,
      [msgId, campaignId],
    );
    const msg = msgRes.rows[0] as Record<string, unknown> | undefined;
    if (!msg) { res.status(404).json({ error: "Message not found" }); return; }
    if (msg.sent_at) { res.status(409).json({ error: "Message already sent" }); return; }
    if (msg.status !== "approved") { res.status(400).json({ error: "Message must be approved before sending" }); return; }

    // Check suppression list
    if (msg.contact_email) {
      const suppressed = await db.query(
        `SELECT id FROM backlink_suppression_list WHERE workspace_owner_id = $1 AND (email = $2 OR domain = $3)`,
        [wreq.workspaceOwnerId, msg.contact_email, String(msg.contact_email).split("@")[1] ?? ""],
      );
      if (suppressed.rows[0]) { res.status(400).json({ error: "Recipient is on suppression list" }); return; }
    }

    // Mark sent (actual email delivery is via the outreach scheduler job)
    await db.query(
      `UPDATE backlink_messages SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1`,
      [msgId],
    );
    await recordBacklinkAudit(wreq, "message", msgId, "sent");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "backlink-engine: send message failed");
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ─── Suppression list ─────────────────────────────────────────────────────────

router.get("/backlink-engine/suppression", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  try {
    const rows = await db.query(
      `SELECT * FROM backlink_suppression_list WHERE workspace_owner_id = $1 ORDER BY created_at DESC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ entries: rows.rows });
  } catch (err) {
    logger.error({ err }, "backlink-engine: suppression list failed");
    res.status(500).json({ error: "Failed to list suppression entries" });
  }
});

router.post("/backlink-engine/suppression", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const body = z.object({
    email: z.string().email().optional().nullable(),
    domain: z.string().max(500).optional().nullable(),
    reason: z.string().max(500).optional().nullable(),
  }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const r = await db.query(
      `INSERT INTO backlink_suppression_list (workspace_owner_id, email, domain, reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [wreq.workspaceOwnerId, body.data.email ?? null, body.data.domain ?? null, body.data.reason ?? null],
    );
    await recordBacklinkAudit(wreq, "suppression", r.rows[0].id, "added", { email: body.data.email, domain: body.data.domain });
    res.status(201).json({ entry: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: add suppression entry failed");
    res.status(500).json({ error: "Failed to add suppression entry" });
  }
});

router.delete("/backlink-engine/suppression/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  try {
    await db.query(
      `DELETE FROM backlink_suppression_list WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    await recordBacklinkAudit(wreq, "suppression", id, "removed");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "backlink-engine: delete suppression entry failed");
    res.status(500).json({ error: "Failed to delete suppression entry" });
  }
});

// ─── Link Monitor ─────────────────────────────────────────────────────────────

router.get("/backlink-engine/links", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10)));
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;
  const relType = req.query.relType as string | undefined;
  try {
    const conditions: string[] = ["workspace_owner_id = $1"];
    const values: unknown[] = [wreq.workspaceOwnerId];
    let idx = 2;
    if (status) { conditions.push(`status = $${idx++}`); values.push(status); }
    if (relType) { conditions.push(`rel_type = $${idx++}`); values.push(relType); }
    const where = conditions.join(" AND ");

    type CountRow = { total: string };
    const countRes = await db.query<CountRow>(`SELECT COUNT(*) AS total FROM backlink_links WHERE ${where}`, values);
    const total = parseInt(countRes.rows[0]?.total ?? "0", 10);
    const rows = await db.query(
      `SELECT * FROM backlink_links WHERE ${where} ORDER BY first_seen_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset],
    );
    res.json({ links: rows.rows, total, page, limit });
  } catch (err) {
    logger.error({ err }, "backlink-engine: links list failed");
    res.status(500).json({ error: "Failed to list links" });
  }
});

router.post("/backlink-engine/links", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const body = z.object({
    sourceUrl: z.string().url(),
    destinationUrl: z.string().url(),
    anchorText: z.string().max(500).optional().nullable(),
    relType: z.enum(["follow","nofollow","sponsored","ugc"]).default("follow"),
    opportunityId: z.number().int().optional().nullable(),
  }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const d = body.data;
    const r = await db.query(
      `INSERT INTO backlink_links (workspace_owner_id, opportunity_id, source_url, destination_url, anchor_text, rel_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,'live') RETURNING *`,
      [wreq.workspaceOwnerId, d.opportunityId ?? null, d.sourceUrl, d.destinationUrl, d.anchorText ?? null, d.relType],
    );
    await recordBacklinkAudit(wreq, "link", r.rows[0].id, "added");
    res.status(201).json({ link: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: add link failed");
    res.status(500).json({ error: "Failed to add link" });
  }
});

router.patch("/backlink-engine/links/:id", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  const body = req.body as Record<string, unknown> ?? {};
  try {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (body.status) { fields.push(`status = $${idx++}`); values.push(body.status); }
    if (fields.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
    values.push(id, wreq.workspaceOwnerId);
    const r = await db.query(
      `UPDATE backlink_links SET ${fields.join(", ")} WHERE id = $${idx++} AND workspace_owner_id = $${idx} RETURNING *`,
      values,
    );
    if (!r.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    if (body.status) await recordBacklinkAudit(wreq, "link", id, String(body.status));
    res.json({ link: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: update link failed");
    res.status(500).json({ error: "Failed to update link" });
  }
});

router.get("/backlink-engine/links/:id/checks", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  try {
    const owns = await db.query(
      `SELECT id FROM backlink_links WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (!owns.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const rows = await db.query(
      `SELECT * FROM backlink_monitor_checks WHERE link_id = $1 ORDER BY checked_at DESC LIMIT 50`,
      [id],
    );
    res.json({ checks: rows.rows });
  } catch (err) {
    logger.error({ err }, "backlink-engine: link checks failed");
    res.status(500).json({ error: "Failed to load checks" });
  }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

router.get("/backlink-engine/reports/overview", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  try {
    type FunnelRow = { status: string; count: string };
    const funnelRes = await db.query<FunnelRow>(
      `SELECT status, COUNT(*) AS count
       FROM backlink_opportunities
       WHERE workspace_owner_id = $1 AND status NOT IN ('archived')
       GROUP BY status`,
      [wreq.workspaceOwnerId],
    );

    type ConvRow = { avg_days: string | null };
    const convRes = await db.query<ConvRow>(
      `SELECT AVG(EXTRACT(EPOCH FROM (l.first_seen_at - o.created_at))/86400) AS avg_days
       FROM backlink_links l
       JOIN backlink_opportunities o ON o.id = l.opportunity_id
       WHERE l.workspace_owner_id = $1 AND l.status = 'live'`,
      [wreq.workspaceOwnerId],
    );

    res.json({
      funnel: funnelRes.rows.map((r) => ({ status: r.status, count: parseInt(r.count, 10) })),
      avgDaysDiscoveryToLive: convRes.rows[0]?.avg_days ? parseFloat(convRes.rows[0].avg_days) : null,
    });
  } catch (err) {
    logger.error({ err }, "backlink-engine: reports overview failed");
    res.status(500).json({ error: "Failed to load report" });
  }
});

router.get("/backlink-engine/reports/links", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  try {
    type DomainRow = { week: string; new_domains: string; lost_domains: string };
    const rows = await db.query<DomainRow>(
      `SELECT
         date_trunc('week', created_at) AS week,
         COUNT(*) FILTER (WHERE status = 'live') AS new_domains,
         COUNT(*) FILTER (WHERE status = 'lost') AS lost_domains
       FROM backlink_links
       WHERE workspace_owner_id = $1
         AND created_at >= now() - INTERVAL '12 weeks'
       GROUP BY 1 ORDER BY 1`,
      [wreq.workspaceOwnerId],
    );
    res.json({ linksByWeek: rows.rows });
  } catch (err) {
    logger.error({ err }, "backlink-engine: reports links failed");
    res.status(500).json({ error: "Failed to load links report" });
  }
});

// CSV export for opportunities
router.get("/backlink-engine/reports/export/opportunities", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  try {
    const rows = await db.query(
      `SELECT id, domain, page_url, opportunity_type, market, source, ai_score, status, domain_authority, estimated_traffic, created_at
       FROM backlink_opportunities
       WHERE workspace_owner_id = $1
       ORDER BY ai_score DESC NULLS LAST, created_at DESC
       LIMIT 5000`,
      [wreq.workspaceOwnerId],
    );
    const header = "id,domain,page_url,type,market,source,ai_score,status,domain_authority,estimated_traffic,created_at\n";
    const csv = header + rows.rows.map((r: Record<string, unknown>) =>
      [r.id, r.domain, `"${String(r.page_url ?? "").replace(/"/g,'""')}"`, r.opportunity_type, r.market, r.source, r.ai_score, r.status, r.domain_authority, r.estimated_traffic, r.created_at].join(","),
    ).join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"backlink-opportunities.csv\"");
    res.send(csv);
  } catch (err) {
    logger.error({ err }, "backlink-engine: export opportunities failed");
    res.status(500).json({ error: "Export failed" });
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

router.get("/backlink-engine/settings", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  try {
    const r = await db.query(
      `SELECT * FROM backlink_settings WHERE workspace_owner_id = $1`,
      [wreq.workspaceOwnerId],
    );
    type JobRunRow = { job_type: string; status: string; started_at: string; finished_at: string | null; records_processed: number; error: string | null };
    const jobs = await db.query<JobRunRow>(
      `SELECT job_type, status, started_at, finished_at, records_processed, error
       FROM backlink_job_runs WHERE workspace_owner_id = $1
       ORDER BY started_at DESC LIMIT 20`,
      [wreq.workspaceOwnerId],
    );
    res.json({
      settings: r.rows[0] ?? null,
      jobHistory: jobs.rows,
      providerStatus: getSeoProviderStatus(),
    });
  } catch (err) {
    logger.error({ err }, "backlink-engine: settings get failed");
    res.status(500).json({ error: "Failed to load settings" });
  }
});

const settingsSchema = z.object({
  seoProvider: z.string().max(50).optional(),
  qualificationThreshold: z.number().int().min(0).max(100).optional(),
  scoringWeights: z.record(z.string(), z.number()).optional().nullable(),
  followupTimingDays: z.array(z.number().int()).optional().nullable(),
  maxFollowups: z.number().int().min(0).max(10).optional(),
  dailySendLimit: z.number().int().min(1).max(1000).optional(),
  coolingPeriodDays: z.number().int().min(0).max(365).optional(),
  discoveryJobCron: z.string().max(100).optional(),
  monitorJobCron: z.string().max(100).optional(),
});

router.put("/backlink-engine/settings", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const d = parsed.data;
    const r = await db.query(
      `INSERT INTO backlink_settings
         (workspace_owner_id, seo_provider, qualification_threshold, scoring_weights, followup_timing_days, max_followups, daily_send_limit, cooling_period_days, discovery_job_cron, monitor_job_cron, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,now())
       ON CONFLICT (workspace_owner_id) DO UPDATE SET
         seo_provider = COALESCE($2, backlink_settings.seo_provider),
         qualification_threshold = COALESCE($3, backlink_settings.qualification_threshold),
         scoring_weights = COALESCE($4::jsonb, backlink_settings.scoring_weights),
         followup_timing_days = COALESCE($5::jsonb, backlink_settings.followup_timing_days),
         max_followups = COALESCE($6, backlink_settings.max_followups),
         daily_send_limit = COALESCE($7, backlink_settings.daily_send_limit),
         cooling_period_days = COALESCE($8, backlink_settings.cooling_period_days),
         discovery_job_cron = COALESCE($9, backlink_settings.discovery_job_cron),
         monitor_job_cron = COALESCE($10, backlink_settings.monitor_job_cron),
         updated_at = now()
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        d.seoProvider ?? null,
        d.qualificationThreshold ?? null,
        d.scoringWeights ? JSON.stringify(d.scoringWeights) : null,
        d.followupTimingDays ? JSON.stringify(d.followupTimingDays) : null,
        d.maxFollowups ?? null,
        d.dailySendLimit ?? null,
        d.coolingPeriodDays ?? null,
        d.discoveryJobCron ?? null,
        d.monitorJobCron ?? null,
      ],
    );
    await recordBacklinkAudit(wreq, "settings", wreq.workspaceOwnerId, "updated");
    res.json({ settings: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: settings update failed");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// ─── Contacts for an opportunity ─────────────────────────────────────────────

router.get("/backlink-engine/opportunities/:id/contacts", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  try {
    const owns = await db.query(`SELECT id FROM backlink_opportunities WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
    if (!owns.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const rows = await db.query(`SELECT * FROM backlink_contacts WHERE opportunity_id = $1 ORDER BY confidence DESC NULLS LAST`, [id]);
    res.json({ contacts: rows.rows });
  } catch (err) {
    logger.error({ err }, "backlink-engine: contacts list failed");
    res.status(500).json({ error: "Failed to list contacts" });
  }
});

router.post("/backlink-engine/opportunities/:id/contacts", async (req: Request, res: Response): Promise<void> => {
  if (!requireManageAccess(req, res)) return;
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  const body = z.object({
    name: z.string().max(200).optional().nullable(),
    role: z.string().max(100).optional().nullable(),
    email: z.string().email().optional().nullable(),
    confidence: z.number().min(0).max(100).optional().nullable(),
    source: z.string().max(100).optional().nullable(),
  }).safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: "Invalid input" }); return; }
  try {
    const owns = await db.query(`SELECT id FROM backlink_opportunities WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
    if (!owns.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    const d = body.data;
    const r = await db.query(
      `INSERT INTO backlink_contacts (opportunity_id, name, role, email, confidence, source)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, d.name ?? null, d.role ?? null, d.email ?? null, d.confidence ?? null, d.source ?? null],
    );
    res.status(201).json({ contact: r.rows[0] });
  } catch (err) {
    logger.error({ err }, "backlink-engine: add contact failed");
    res.status(500).json({ error: "Failed to add contact" });
  }
});

// ─── Audit log ───────────────────────────────────────────────────────────────

router.get("/backlink-engine/audit", async (req: Request, res: Response): Promise<void> => {
  if (!requireBacklinkAccess(req, res)) return;
  const wreq = workspace(req);
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
  const limit = 50;
  const offset = (page - 1) * limit;
  try {
    const rows = await db.query(
      `SELECT * FROM backlink_audit_events WHERE workspace_owner_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [wreq.workspaceOwnerId, limit, offset],
    );
    res.json({ events: rows.rows, page, limit });
  } catch (err) {
    logger.error({ err }, "backlink-engine: audit log failed");
    res.status(500).json({ error: "Failed to load audit log" });
  }
});

export default router;

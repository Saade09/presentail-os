import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { db } from "../lib/db";

const router = Router();

router.use(requireAuth, resolveWorkspace);

function canEdit(req: Parameters<typeof workspace>[0]): boolean {
  const wreq = workspace(req);
  return wreq.workspaceRole === "owner" || (wreq.allowedPages?.includes("occasion-campaigns.edit") ?? false);
}

function canDelete(req: Parameters<typeof workspace>[0]): boolean {
  const wreq = workspace(req);
  return wreq.workspaceRole === "owner" || (wreq.allowedPages?.includes("occasion-campaigns.delete") ?? false);
}

// ── Campaign phase helper ─────────────────────────────────────────────────

function calcCampaignPhase(daysUntil: number): string {
  if (daysUntil > 44) return "Planning";
  if (daysUntil > 29) return "Pre-launch";
  if (daysUntil > 13) return "Main push";
  if (daysUntil > 6) return "Urgency";
  if (daysUntil > 2) return "Last chance";
  if (daysUntil >= 0) return "Live today";
  if (daysUntil >= -7) return "Retention";
  return "Completed";
}

// ── Next occurrence helper ────────────────────────────────────────────────

function nextOccurrenceDate(month: number | null, day: number | null): string | null {
  if (!month) return null;
  const now = new Date();
  const year = now.getFullYear();
  const d = day ?? 1;
  let candidate = new Date(Date.UTC(year, month - 1, d));
  if (candidate < now) {
    candidate = new Date(Date.UTC(year + 1, month - 1, d));
  }
  return candidate.toISOString().split("T")[0];
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00Z");
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

// ── Readiness column helper ───────────────────────────────────────────────

function readinessColumn(score: number, daysAway: number | null, hasPlan: boolean): string {
  if (daysAway !== null && daysAway < 0) return "completed";
  if (daysAway !== null && daysAway === 0) return "live";
  if (!hasPlan) return "needs_planning";
  if (score >= 80) return "ready";
  if (score >= 50) return "in_progress";
  if (daysAway !== null && daysAway <= 14 && score < 60) return "at_risk";
  return "in_progress";
}

// ── Seed data ─────────────────────────────────────────────────────────────

const SEED_OCCASIONS = [
  {
    name: "Mother's Day",
    type: "personal",
    priority: "high",
    markets: ["UAE", "KSA", "Lebanon", "Kuwait"],
    product_focus: "Flowers, chocolates, personalised gifts",
    recommended_channels: ["Instagram", "WhatsApp", "Email"],
    campaign_start_days_before: 45,
    month: 5,
    day: 11,
    notes: "Second Sunday of May",
    recurrence: "annual_fixed",
  },
  {
    name: "Valentine's Day",
    type: "promotional",
    priority: "high",
    markets: ["UAE", "KSA", "Lebanon", "Kuwait"],
    product_focus: "Roses, premium bouquets, gift sets",
    recommended_channels: ["Instagram", "WhatsApp", "Google Ads"],
    campaign_start_days_before: 21,
    month: 2,
    day: 14,
    notes: null,
    recurrence: "annual_fixed",
  },
  {
    name: "Eid al-Fitr",
    type: "religious",
    priority: "high",
    markets: ["UAE", "KSA", "Kuwait", "Bahrain", "Oman", "Jordan", "Lebanon"],
    product_focus: "Premium arrangements, Eid gift baskets",
    recommended_channels: ["WhatsApp", "Instagram", "SMS"],
    campaign_start_days_before: 30,
    month: 3,
    day: 30,
    notes: "Islamic calendar — date varies annually. 2026 approx. March 30.",
    recurrence: "religious_lunar",
  },
  {
    name: "Eid al-Adha",
    type: "religious",
    priority: "high",
    markets: ["UAE", "KSA", "Kuwait", "Bahrain", "Oman", "Jordan", "Lebanon"],
    product_focus: "Traditional arrangements, luxury gift sets",
    recommended_channels: ["WhatsApp", "Instagram", "SMS"],
    campaign_start_days_before: 30,
    month: 6,
    day: 6,
    notes: "Islamic calendar — date varies annually. 2026 approx. June 6.",
    recurrence: "religious_lunar",
  },
  {
    name: "Graduation Season",
    type: "personal",
    priority: "medium",
    markets: ["UAE", "KSA", "Lebanon"],
    product_focus: "Congratulations bouquets, balloons, arrangements",
    recommended_channels: ["Instagram", "TikTok", "WhatsApp"],
    campaign_start_days_before: 30,
    month: 6,
    day: 1,
    notes: "June graduation season",
    recurrence: "annual_fixed",
  },
  {
    name: "International Women's Day",
    type: "corporate",
    priority: "medium",
    markets: ["UAE", "KSA", "Lebanon"],
    product_focus: "Corporate gifting, roses, empowerment-themed arrangements",
    recommended_channels: ["LinkedIn", "Instagram", "Email"],
    campaign_start_days_before: 21,
    month: 3,
    day: 8,
    notes: null,
    recurrence: "annual_fixed",
  },
  {
    name: "Father's Day",
    type: "personal",
    priority: "medium",
    markets: ["UAE", "KSA", "Lebanon", "Kuwait"],
    product_focus: "Plants, premium arrangements, gift sets",
    recommended_channels: ["Instagram", "WhatsApp", "Facebook"],
    campaign_start_days_before: 21,
    month: 6,
    day: 21,
    notes: "Third Sunday of June",
    recurrence: "annual_fixed",
  },
  {
    name: "Christmas & New Year",
    type: "seasonal",
    priority: "medium",
    markets: ["Lebanon", "UAE"],
    product_focus: "Festive arrangements, poinsettias, gift sets",
    recommended_channels: ["Instagram", "Email", "Google Ads"],
    campaign_start_days_before: 45,
    month: 12,
    day: 25,
    notes: "Christmas and New Year holiday season",
    recurrence: "annual_fixed",
  },
];

const DEFAULT_OCCASION_TYPES = [
  { name: "Promotional", color: "#f59e0b", description: "Sales-driven promotional occasions" },
  { name: "Personal", color: "#ec4899", description: "Personal milestone occasions (birthdays, anniversaries)" },
  { name: "Religious", color: "#8b5cf6", description: "Religious and cultural celebrations" },
  { name: "Corporate", color: "#3b82f6", description: "Business and corporate occasions" },
  { name: "Seasonal", color: "#10b981", description: "Seasonal and holiday occasions" },
  { name: "National Holiday", color: "#ef4444", description: "National and public holidays" },
];

const DEFAULT_READINESS_ITEMS = [
  { title: "Campaign plan created", category: "planning" },
  { title: "Budget allocated", category: "planning" },
  { title: "Marketing assets designed", category: "creative" },
  { title: "Social media posts scheduled", category: "marketing" },
  { title: "Email campaign prepared", category: "marketing" },
  { title: "Product selection finalized", category: "operations" },
  { title: "Delivery capacity confirmed", category: "operations" },
  { title: "Team briefed", category: "planning" },
];

async function seedOccasionsIfEmpty(workspaceOwnerId: string): Promise<void> {
  const count = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM occasion_campaigns WHERE workspace_owner_id = $1`,
    [workspaceOwnerId],
  );
  if (parseInt(count.rows[0].count, 10) > 0) return;

  for (const occ of SEED_OCCASIONS) {
    await db.query(
      `INSERT INTO occasion_campaigns
         (workspace_owner_id, name, type, priority, markets, product_focus,
          recommended_channels, campaign_start_days_before, month, day, notes, recurrence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT DO NOTHING`,
      [
        workspaceOwnerId,
        occ.name,
        occ.type,
        occ.priority,
        JSON.stringify(occ.markets),
        occ.product_focus,
        JSON.stringify(occ.recommended_channels),
        occ.campaign_start_days_before,
        occ.month,
        occ.day,
        occ.notes,
        occ.recurrence,
      ],
    );
  }
}

async function seedOccasionTypesIfEmpty(workspaceOwnerId: string): Promise<void> {
  const count = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM occasion_types WHERE workspace_owner_id = $1`,
    [workspaceOwnerId],
  );
  if (parseInt(count.rows[0].count, 10) > 0) return;

  for (const t of DEFAULT_OCCASION_TYPES) {
    await db.query(
      `INSERT INTO occasion_types (workspace_owner_id, name, color, description) VALUES ($1,$2,$3,$4)`,
      [workspaceOwnerId, t.name, t.color, t.description],
    );
  }
}

async function seedReadinessIfEmpty(workspaceOwnerId: string, occasionId: number): Promise<void> {
  const count = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM occasion_readiness_items WHERE occasion_id = $1`,
    [occasionId],
  );
  if (parseInt(count.rows[0].count, 10) > 0) return;

  for (const item of DEFAULT_READINESS_ITEMS) {
    await db.query(
      `INSERT INTO occasion_readiness_items (workspace_owner_id, occasion_id, title, category, is_default)
       VALUES ($1,$2,$3,$4,true)`,
      [workspaceOwnerId, occasionId, item.title, item.category],
    );
  }
}

async function computeReadinessScore(occasionId: number): Promise<number> {
  const result = await db.query<{ total: string; done: string }>(
    `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'done') AS done
       FROM occasion_readiness_items
      WHERE occasion_id = $1`,
    [occasionId],
  );
  const total = parseInt(result.rows[0].total, 10);
  const done = parseInt(result.rows[0].done, 10);
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

// ── Types ─────────────────────────────────────────────────────────────────

type OccasionRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  type: string;
  priority: string;
  status: string;
  markets: string[];
  product_focus: string | null;
  recommended_channels: string[];
  campaign_start_days_before: number;
  month: number | null;
  day: number | null;
  notes: string | null;
  description: string | null;
  recurrence: string;
  preparation_days: number | null;
  demand_level: string | null;
  owner_user_id: string | null;
  tags: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type PlanRow = {
  id: number;
  workspace_owner_id: string;
  occasion_id: number;
  name: string;
  target_date: string;
  markets: string[];
  budget: string | null;
  currency: string;
  notes: string | null;
  status: string;
  channel: string | null;
  market: string | null;
  owner_user_id: string | null;
  start_date: string | null;
  end_date: string | null;
  goal: string | null;
  created_at: string;
  updated_at: string;
};

type ActionRow = {
  id: number;
  plan_id: number;
  title: string;
  description: string | null;
  status: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
};

type OccasionTypeRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  color: string;
  description: string | null;
  created_at: string;
};

type ReadinessItemRow = {
  id: number;
  workspace_owner_id: string;
  occasion_id: number;
  title: string;
  category: string;
  status: string;
  owner_user_id: string | null;
  due_date: string | null;
  notes: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

function enrichOccasion(row: OccasionRow) {
  const nextDate = nextOccurrenceDate(row.month, row.day);
  const days = daysUntil(nextDate);
  return {
    ...row,
    next_occurrence: nextDate,
    days_until: days,
    campaign_phase: days !== null ? calcCampaignPhase(days) : null,
  };
}

// ── Validation schemas ─────────────────────────────────────────────────────

const OCCASION_SELECT = `id, workspace_owner_id, name, type, priority, status, markets, product_focus,
  recommended_channels, campaign_start_days_before, month, day,
  notes, description, recurrence, preparation_days, demand_level,
  owner_user_id, tags, is_active, created_at, updated_at`;

const createOccasionSchema = z.object({
  name: z.string().min(1),
  type: z.string().default("seasonal"),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
  status: z.enum(["active", "archived"]).default("active"),
  markets: z.array(z.string()).default([]),
  product_focus: z.string().nullable().optional(),
  recommended_channels: z.array(z.string()).default([]),
  campaign_start_days_before: z.number().int().min(1).default(30),
  month: z.number().int().min(1).max(12).nullable().optional(),
  day: z.number().int().min(1).max(31).nullable().optional(),
  notes: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  recurrence: z.enum(["one_time", "annual_fixed", "annual_manual", "religious_lunar"]).default("annual_fixed"),
  preparation_days: z.number().int().nullable().optional(),
  demand_level: z.string().nullable().optional(),
  owner_user_id: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
});

const patchOccasionSchema = createOccasionSchema.partial().extend({
  is_active: z.boolean().optional(),
});

const createPlanSchema = z.object({
  occasion_id: z.number().int(),
  name: z.string().min(1),
  target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  markets: z.array(z.string()).default([]),
  budget: z.number().nullable().optional(),
  currency: z.string().min(1).max(10).default("AED"),
  notes: z.string().nullable().optional(),
  status: z.string().default("draft"),
  channel: z.string().nullable().optional(),
  market: z.string().nullable().optional(),
  owner_user_id: z.string().nullable().optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  goal: z.string().nullable().optional(),
});

const patchPlanSchema = createPlanSchema.partial();

const patchActionSchema = z.object({
  status: z.enum(["not_started", "in_progress", "done"]),
});

const createOccasionTypeSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().min(1).max(20).default("#6366f1"),
  description: z.string().nullable().optional(),
});

const patchReadinessItemSchema = z.object({
  status: z.enum(["not_started", "in_progress", "done"]).optional(),
  owner_user_id: z.string().nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().nullable().optional(),
});

const createReadinessItemSchema = z.object({
  title: z.string().min(1),
  category: z.string().default("general"),
  status: z.enum(["not_started", "in_progress", "done"]).default("not_started"),
  owner_user_id: z.string().nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().nullable().optional(),
});

// ── OCCASION TYPES ─────────────────────────────────────────────────────────

// GET /api/occasion-campaigns/types
router.get("/occasion-campaigns/types", async (req, res) => {
  const wreq = workspace(req);
  await seedOccasionTypesIfEmpty(wreq.workspaceOwnerId);
  const result = await db.query<OccasionTypeRow>(
    `SELECT id, workspace_owner_id, name, color, description, created_at
       FROM occasion_types
      WHERE workspace_owner_id = $1
      ORDER BY name ASC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ types: result.rows });
});

// POST /api/occasion-campaigns/types
router.post("/occasion-campaigns/types", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const parsed = createOccasionTypeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;
  const result = await db.query<OccasionTypeRow>(
    `INSERT INTO occasion_types (workspace_owner_id, name, color, description)
     VALUES ($1,$2,$3,$4)
     RETURNING id, workspace_owner_id, name, color, description, created_at`,
    [wreq.workspaceOwnerId, d.name, d.color, d.description ?? null],
  );
  res.status(201).json({ type: result.rows[0] });
});

// PATCH /api/occasion-campaigns/types/:id
router.patch("/occasion-campaigns/types/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = createOccasionTypeSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (d.name !== undefined) { params.push(d.name); sets.push(`name = $${params.length}`); }
  if (d.color !== undefined) { params.push(d.color); sets.push(`color = $${params.length}`); }
  if (d.description !== undefined) { params.push(d.description); sets.push(`description = $${params.length}`); }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  sets.push(`updated_at = now()`);
  params.push(id, wreq.workspaceOwnerId);
  const result = await db.query<OccasionTypeRow>(
    `UPDATE occasion_types SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
      RETURNING id, workspace_owner_id, name, color, description, created_at`,
    params,
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ type: result.rows[0] });
});

// DELETE /api/occasion-campaigns/types/:id
router.delete("/occasion-campaigns/types/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canDelete(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const result = await db.query(
    `DELETE FROM occasion_types WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

// ── OCCASIONS ──────────────────────────────────────────────────────────────

// GET /api/occasion-campaigns/occasions
router.get("/occasion-campaigns/occasions", async (req, res) => {
  const wreq = workspace(req);
  await seedOccasionsIfEmpty(wreq.workspaceOwnerId);

  const market = req.query.market as string | undefined;
  const type = req.query.type as string | undefined;
  const priority = req.query.priority as string | undefined;
  const status = req.query.status as string | undefined;
  const includeArchived = req.query.include_archived === "true";
  const q = req.query.q as string | undefined;

  const params: unknown[] = [wreq.workspaceOwnerId];
  let query = `
    SELECT ${OCCASION_SELECT}
      FROM occasion_campaigns
     WHERE workspace_owner_id = $1
       AND is_active = true
  `;

  if (!includeArchived) {
    query += ` AND status != 'archived'`;
  }

  if (market) {
    params.push(`"${market}"`);
    query += ` AND markets @> $${params.length}::jsonb`;
  }
  if (type) { params.push(type); query += ` AND type = $${params.length}`; }
  if (priority) { params.push(priority); query += ` AND priority = $${params.length}`; }
  if (status && (status === "active" || status === "archived")) {
    params.push(status); query += ` AND status = $${params.length}`;
  }
  if (q) {
    params.push(`%${q}%`);
    query += ` AND name ILIKE $${params.length}`;
  }

  query += " ORDER BY month ASC NULLS LAST, day ASC NULLS LAST, name ASC";

  const result = await db.query<OccasionRow>(query, params);
  const occasions = result.rows.map(enrichOccasion);
  res.json({ occasions });
});

// POST /api/occasion-campaigns/occasions
router.post("/occasion-campaigns/occasions", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const parsed = createOccasionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const result = await db.query<OccasionRow>(
    `INSERT INTO occasion_campaigns
       (workspace_owner_id, name, type, priority, status, markets, product_focus, recommended_channels,
        campaign_start_days_before, month, day, notes, description, recurrence,
        preparation_days, demand_level, owner_user_id, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING ${OCCASION_SELECT}`,
    [
      wreq.workspaceOwnerId, d.name, d.type, d.priority, d.status,
      JSON.stringify(d.markets), d.product_focus ?? null,
      JSON.stringify(d.recommended_channels), d.campaign_start_days_before,
      d.month ?? null, d.day ?? null, d.notes ?? null, d.description ?? null,
      d.recurrence, d.preparation_days ?? null, d.demand_level ?? null,
      d.owner_user_id ?? null, JSON.stringify(d.tags),
    ],
  );
  res.status(201).json({ occasion: enrichOccasion(result.rows[0]) });
});

// GET /api/occasion-campaigns/occasions/:id
router.get("/occasion-campaigns/occasions/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await db.query<OccasionRow>(
    `SELECT ${OCCASION_SELECT}
       FROM occasion_campaigns
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  const occ = enrichOccasion(result.rows[0]);

  // Plans count
  const planCount = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM campaign_plans WHERE occasion_id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  // Readiness score
  await seedReadinessIfEmpty(wreq.workspaceOwnerId, id);
  const score = await computeReadinessScore(id);

  res.json({ occasion: { ...occ, plan_count: parseInt(planCount.rows[0].count, 10), readiness_score: score } });
});

// POST /api/occasion-campaigns/occasions/:id/duplicate
router.post("/occasion-campaigns/occasions/:id/duplicate", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const src = await db.query<OccasionRow>(
    `SELECT ${OCCASION_SELECT} FROM occasion_campaigns WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (!src.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  const s = src.rows[0];
  const result = await db.query<OccasionRow>(
    `INSERT INTO occasion_campaigns
       (workspace_owner_id, name, type, priority, status, markets, product_focus, recommended_channels,
        campaign_start_days_before, month, day, notes, description, recurrence,
        preparation_days, demand_level, owner_user_id, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING ${OCCASION_SELECT}`,
    [
      wreq.workspaceOwnerId, `${s.name} (copy)`, s.type, s.priority, "active",
      JSON.stringify(s.markets), s.product_focus, JSON.stringify(s.recommended_channels),
      s.campaign_start_days_before, s.month, s.day, s.notes, s.description,
      s.recurrence, s.preparation_days, s.demand_level, null, JSON.stringify(s.tags),
    ],
  );
  res.status(201).json({ occasion: enrichOccasion(result.rows[0]) });
});

// PATCH /api/occasion-campaigns/occasions/:id
router.patch("/occasion-campaigns/occasions/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = patchOccasionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];

  if (d.name !== undefined) { params.push(d.name); sets.push(`name = $${params.length}`); }
  if (d.type !== undefined) { params.push(d.type); sets.push(`type = $${params.length}`); }
  if (d.priority !== undefined) { params.push(d.priority); sets.push(`priority = $${params.length}`); }
  if (d.status !== undefined) { params.push(d.status); sets.push(`status = $${params.length}`); }
  if (d.markets !== undefined) { params.push(JSON.stringify(d.markets)); sets.push(`markets = $${params.length}`); }
  if (d.product_focus !== undefined) { params.push(d.product_focus); sets.push(`product_focus = $${params.length}`); }
  if (d.recommended_channels !== undefined) { params.push(JSON.stringify(d.recommended_channels)); sets.push(`recommended_channels = $${params.length}`); }
  if (d.campaign_start_days_before !== undefined) { params.push(d.campaign_start_days_before); sets.push(`campaign_start_days_before = $${params.length}`); }
  if (d.month !== undefined) { params.push(d.month); sets.push(`month = $${params.length}`); }
  if (d.day !== undefined) { params.push(d.day); sets.push(`day = $${params.length}`); }
  if (d.notes !== undefined) { params.push(d.notes); sets.push(`notes = $${params.length}`); }
  if (d.description !== undefined) { params.push(d.description); sets.push(`description = $${params.length}`); }
  if (d.recurrence !== undefined) { params.push(d.recurrence); sets.push(`recurrence = $${params.length}`); }
  if (d.preparation_days !== undefined) { params.push(d.preparation_days); sets.push(`preparation_days = $${params.length}`); }
  if (d.demand_level !== undefined) { params.push(d.demand_level); sets.push(`demand_level = $${params.length}`); }
  if (d.owner_user_id !== undefined) { params.push(d.owner_user_id); sets.push(`owner_user_id = $${params.length}`); }
  if (d.tags !== undefined) { params.push(JSON.stringify(d.tags)); sets.push(`tags = $${params.length}`); }
  if (d.is_active !== undefined) { params.push(d.is_active); sets.push(`is_active = $${params.length}`); }

  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  sets.push(`updated_at = now()`);
  params.push(id, wreq.workspaceOwnerId);

  const result = await db.query<OccasionRow>(
    `UPDATE occasion_campaigns SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
      RETURNING ${OCCASION_SELECT}`,
    params,
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ occasion: enrichOccasion(result.rows[0]) });
});

// DELETE /api/occasion-campaigns/occasions/:id
router.delete("/occasion-campaigns/occasions/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canDelete(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Check if used by plans
  const planCount = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM campaign_plans WHERE occasion_id = $1`,
    [id],
  );
  if (parseInt(planCount.rows[0].count, 10) > 0) {
    res.status(409).json({ error: "Cannot delete: occasion has campaign plans. Archive it instead." });
    return;
  }

  const result = await db.query(
    `DELETE FROM occasion_campaigns WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

// ── READINESS ─────────────────────────────────────────────────────────────

// GET /api/occasion-campaigns/occasions/:id/readiness
router.get("/occasion-campaigns/occasions/:id/readiness", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  // Verify occasion belongs to workspace
  const occ = await db.query<{ id: number }>(
    `SELECT id FROM occasion_campaigns WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (!occ.rows[0]) { res.status(404).json({ error: "Occasion not found" }); return; }

  await seedReadinessIfEmpty(wreq.workspaceOwnerId, id);

  const items = await db.query<ReadinessItemRow>(
    `SELECT id, workspace_owner_id, occasion_id, title, category, status,
            owner_user_id, due_date, notes, is_default, created_at, updated_at
       FROM occasion_readiness_items
      WHERE occasion_id = $1
      ORDER BY is_default DESC, id ASC`,
    [id],
  );

  const score = await computeReadinessScore(id);
  res.json({ items: items.rows, score });
});

// PATCH /api/occasion-campaigns/occasions/:id/readiness/:itemId
router.patch("/occasion-campaigns/occasions/:id/readiness/:itemId", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const occasionId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (isNaN(occasionId) || isNaN(itemId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = patchReadinessItemSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (d.status !== undefined) { params.push(d.status); sets.push(`status = $${params.length}`); }
  if (d.owner_user_id !== undefined) { params.push(d.owner_user_id); sets.push(`owner_user_id = $${params.length}`); }
  if (d.due_date !== undefined) { params.push(d.due_date); sets.push(`due_date = $${params.length}`); }
  if (d.notes !== undefined) { params.push(d.notes); sets.push(`notes = $${params.length}`); }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  sets.push(`updated_at = now()`);
  params.push(itemId, occasionId, wreq.workspaceOwnerId);

  const result = await db.query<ReadinessItemRow>(
    `UPDATE occasion_readiness_items SET ${sets.join(", ")}
      WHERE id = $${params.length - 2} AND occasion_id = $${params.length - 1}
        AND workspace_owner_id = $${params.length}
      RETURNING id, workspace_owner_id, occasion_id, title, category, status,
                owner_user_id, due_date, notes, is_default, created_at, updated_at`,
    params,
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  const score = await computeReadinessScore(occasionId);
  res.json({ item: result.rows[0], score });
});

// POST /api/occasion-campaigns/occasions/:id/readiness
router.post("/occasion-campaigns/occasions/:id/readiness", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const occasionId = parseInt(req.params.id, 10);
  if (isNaN(occasionId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const occ = await db.query<{ id: number }>(
    `SELECT id FROM occasion_campaigns WHERE id = $1 AND workspace_owner_id = $2`,
    [occasionId, wreq.workspaceOwnerId],
  );
  if (!occ.rows[0]) { res.status(404).json({ error: "Occasion not found" }); return; }

  const parsed = createReadinessItemSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Validation failed", issues: parsed.error.issues }); return; }
  const d = parsed.data;

  const result = await db.query<ReadinessItemRow>(
    `INSERT INTO occasion_readiness_items (workspace_owner_id, occasion_id, title, category, status, owner_user_id, due_date, notes, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
     RETURNING id, workspace_owner_id, occasion_id, title, category, status, owner_user_id, due_date, notes, is_default, created_at, updated_at`,
    [wreq.workspaceOwnerId, occasionId, d.title, d.category, d.status, d.owner_user_id ?? null, d.due_date ?? null, d.notes ?? null],
  );
  const score = await computeReadinessScore(occasionId);
  res.status(201).json({ item: result.rows[0], score });
});

// DELETE /api/occasion-campaigns/occasions/:id/readiness/:itemId
router.delete("/occasion-campaigns/occasions/:id/readiness/:itemId", async (req, res) => {
  const wreq = workspace(req);
  if (!canDelete(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const occasionId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (isNaN(occasionId) || isNaN(itemId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await db.query(
    `DELETE FROM occasion_readiness_items WHERE id = $1 AND occasion_id = $2 AND workspace_owner_id = $3 AND is_default = false`,
    [itemId, occasionId, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Not found or cannot delete default items" }); return; }
  const score = await computeReadinessScore(occasionId);
  res.json({ ok: true, score });
});

// ── PLANS ─────────────────────────────────────────────────────────────────

const PLAN_SELECT = `p.id, p.occasion_id, p.name, p.target_date, p.markets, p.budget,
  p.currency, p.notes, p.status, p.channel, p.market, p.owner_user_id,
  p.start_date, p.end_date, p.goal, p.created_at, p.updated_at`;

function enrichPlan(row: PlanRow & { occasion_name?: string; occasion_type?: string }) {
  const days = daysUntil(row.target_date);
  return {
    ...row,
    days_until: days,
    campaign_phase: days !== null ? calcCampaignPhase(days) : null,
  };
}

// GET /api/occasion-campaigns/plans
router.get("/occasion-campaigns/plans", async (req, res) => {
  const wreq = workspace(req);
  const occasionId = req.query.occasion_id ? parseInt(req.query.occasion_id as string, 10) : undefined;
  const status = req.query.status as string | undefined;
  const market = req.query.market as string | undefined;
  const channel = req.query.channel as string | undefined;

  let query = `
    SELECT ${PLAN_SELECT},
           o.name AS occasion_name, o.type AS occasion_type
      FROM campaign_plans p
      JOIN occasion_campaigns o ON o.id = p.occasion_id
     WHERE p.workspace_owner_id = $1
  `;
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (occasionId && !isNaN(occasionId)) { params.push(occasionId); query += ` AND p.occasion_id = $${params.length}`; }
  if (status) { params.push(status); query += ` AND p.status = $${params.length}`; }
  if (market) { params.push(market); query += ` AND p.market = $${params.length}`; }
  if (channel) { params.push(channel); query += ` AND p.channel = $${params.length}`; }

  query += " ORDER BY p.target_date ASC";

  const result = await db.query<PlanRow & { occasion_name: string; occasion_type: string }>(query, params);
  res.json({ plans: result.rows.map(enrichPlan) });
});

// GET /api/occasion-campaigns/plans/:id
router.get("/occasion-campaigns/plans/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const result = await db.query<PlanRow & { occasion_name: string; occasion_type: string }>(
    `SELECT ${PLAN_SELECT}, o.name AS occasion_name, o.type AS occasion_type
       FROM campaign_plans p
       JOIN occasion_campaigns o ON o.id = p.occasion_id
      WHERE p.id = $1 AND p.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

  const actions = await db.query<ActionRow>(
    `SELECT id, plan_id, title, description, status, due_date, created_at, updated_at
       FROM campaign_actions WHERE plan_id = $1 ORDER BY id ASC`,
    [id],
  );

  res.json({ plan: { ...enrichPlan(result.rows[0]), actions: actions.rows } });
});

// POST /api/occasion-campaigns/plans
router.post("/occasion-campaigns/plans", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const parsed = createPlanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;

  const occ = await db.query(
    `SELECT id FROM occasion_campaigns WHERE id = $1 AND workspace_owner_id = $2`,
    [d.occasion_id, wreq.workspaceOwnerId],
  );
  if (!occ.rows[0]) { res.status(404).json({ error: "Occasion not found" }); return; }

  const result = await db.query<PlanRow>(
    `INSERT INTO campaign_plans
       (workspace_owner_id, occasion_id, name, target_date, markets, budget, currency,
        notes, status, channel, market, owner_user_id, start_date, end_date, goal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${PLAN_SELECT.replace(/p\./g, "")}`,
    [
      wreq.workspaceOwnerId, d.occasion_id, d.name, d.target_date,
      JSON.stringify(d.markets), d.budget ?? null, d.currency, d.notes ?? null, d.status,
      d.channel ?? null, d.market ?? null, d.owner_user_id ?? null,
      d.start_date ?? null, d.end_date ?? null, d.goal ?? null,
    ],
  );

  const defaultActions = [
    { title: "Brief design team", category: "creative" },
    { title: "Prepare product selection", category: "operations" },
    { title: "Create marketing assets", category: "creative" },
    { title: "Schedule social media posts", category: "marketing" },
    { title: "Send email campaign", category: "marketing" },
    { title: "Review results", category: "analysis" },
  ];
  for (const action of defaultActions) {
    await db.query(
      `INSERT INTO campaign_actions (plan_id, title, description) VALUES ($1, $2, $3)`,
      [result.rows[0].id, action.title, null],
    );
  }

  const plan = result.rows[0];
  res.status(201).json({ plan: enrichPlan(plan) });
});

// PATCH /api/occasion-campaigns/plans/:id
router.patch("/occasion-campaigns/plans/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = patchPlanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];

  if (d.name !== undefined) { params.push(d.name); sets.push(`name = $${params.length}`); }
  if (d.target_date !== undefined) { params.push(d.target_date); sets.push(`target_date = $${params.length}`); }
  if (d.markets !== undefined) { params.push(JSON.stringify(d.markets)); sets.push(`markets = $${params.length}`); }
  if (d.budget !== undefined) { params.push(d.budget); sets.push(`budget = $${params.length}`); }
  if (d.currency !== undefined) { params.push(d.currency); sets.push(`currency = $${params.length}`); }
  if (d.notes !== undefined) { params.push(d.notes); sets.push(`notes = $${params.length}`); }
  if (d.status !== undefined) { params.push(d.status); sets.push(`status = $${params.length}`); }
  if (d.channel !== undefined) { params.push(d.channel); sets.push(`channel = $${params.length}`); }
  if (d.market !== undefined) { params.push(d.market); sets.push(`market = $${params.length}`); }
  if (d.owner_user_id !== undefined) { params.push(d.owner_user_id); sets.push(`owner_user_id = $${params.length}`); }
  if (d.start_date !== undefined) { params.push(d.start_date); sets.push(`start_date = $${params.length}`); }
  if (d.end_date !== undefined) { params.push(d.end_date); sets.push(`end_date = $${params.length}`); }
  if (d.goal !== undefined) { params.push(d.goal); sets.push(`goal = $${params.length}`); }

  if (sets.length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  sets.push("updated_at = now()");
  params.push(id, wreq.workspaceOwnerId);

  const result = await db.query<PlanRow>(
    `UPDATE campaign_plans SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
      RETURNING ${PLAN_SELECT.replace(/p\./g, "")}`,
    params,
  );
  if (!result.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ plan: enrichPlan(result.rows[0]) });
});

// DELETE /api/occasion-campaigns/plans/:id
router.delete("/occasion-campaigns/plans/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canDelete(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const result = await db.query(
    `DELETE FROM campaign_plans WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ok: true });
});

// ── ACTIONS ───────────────────────────────────────────────────────────────

// GET /api/occasion-campaigns/actions?plan_id=
router.get("/occasion-campaigns/actions", async (req, res) => {
  const wreq = workspace(req);
  const planId = req.query.plan_id ? parseInt(req.query.plan_id as string, 10) : undefined;
  if (!planId || isNaN(planId)) { res.status(400).json({ error: "plan_id is required" }); return; }

  const plan = await db.query(
    `SELECT id FROM campaign_plans WHERE id = $1 AND workspace_owner_id = $2`,
    [planId, wreq.workspaceOwnerId],
  );
  if (!plan.rows[0]) { res.status(404).json({ error: "Plan not found" }); return; }

  const result = await db.query<ActionRow>(
    `SELECT id, plan_id, title, description, status, due_date, created_at, updated_at
       FROM campaign_actions WHERE plan_id = $1 ORDER BY id ASC`,
    [planId],
  );
  res.json({ actions: result.rows });
});

// PATCH /api/occasion-campaigns/actions/:id
router.patch("/occasion-campaigns/actions/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canEdit(req)) { res.status(403).json({ error: "Forbidden" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = patchActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const ownership = await db.query(
    `SELECT a.id FROM campaign_actions a
       JOIN campaign_plans p ON p.id = a.plan_id
      WHERE a.id = $1 AND p.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (!ownership.rows[0]) { res.status(404).json({ error: "Action not found" }); return; }

  const result = await db.query<ActionRow>(
    `UPDATE campaign_actions SET status = $1, updated_at = now()
      WHERE id = $2
      RETURNING id, plan_id, title, description, status, due_date, created_at, updated_at`,
    [parsed.data.status, id],
  );
  res.json({ action: result.rows[0] });
});

// ── SUMMARY ────────────────────────────────────────────────────────────────

// GET /api/occasion-campaigns/summary
router.get("/occasion-campaigns/summary", async (req, res) => {
  const wreq = workspace(req);
  await seedOccasionsIfEmpty(wreq.workspaceOwnerId);

  const occasions = await db.query<OccasionRow>(
    `SELECT id, name, type, priority, markets, month, day, status
       FROM occasion_campaigns
      WHERE workspace_owner_id = $1 AND is_active = true AND status = 'active'`,
    [wreq.workspaceOwnerId],
  );

  let upcomingCount = 0;
  let nextOccasion: { name: string; days_away: number } | null = null;
  let highPriorityMarketCount = 0;
  const highPriorityMarkets = new Set<string>();
  const now = new Date();

  for (const occ of occasions.rows) {
    const nextDate = nextOccurrenceDate(occ.month, occ.day);
    if (!nextDate) continue;
    const days = daysUntil(nextDate);
    if (days === null) continue;

    if (days >= 0 && days <= 45) {
      upcomingCount++;
      if (nextOccasion === null || days < nextOccasion.days_away) {
        nextOccasion = { name: occ.name, days_away: days };
      }
    }

    if (occ.priority === "high" || occ.type === "religious") {
      if (days >= 0 && days <= 90) {
        for (const m of (occ.markets as unknown as string[])) highPriorityMarkets.add(m);
      }
    }
  }
  highPriorityMarketCount = highPriorityMarkets.size;

  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);
  const todayStr = now.toISOString().split("T")[0];
  const weekStr = weekAhead.toISOString().split("T")[0];

  const plansThisWeek = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM campaign_plans
      WHERE workspace_owner_id = $1 AND target_date >= $2 AND target_date <= $3`,
    [wreq.workspaceOwnerId, todayStr, weekStr],
  );

  // Occasions missing plans
  const withPlanIds = await db.query<{ occasion_id: number }>(
    `SELECT DISTINCT occasion_id FROM campaign_plans WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  const withPlanSet = new Set(withPlanIds.rows.map((r) => r.occasion_id));
  const missingPlansCount = occasions.rows.filter((occ) => !withPlanSet.has(occ.id)).length;

  // Average readiness score
  let avgScore = 0;
  const occasionIds = occasions.rows.map((o) => o.id);
  if (occasionIds.length > 0) {
    const scores = await Promise.all(occasionIds.map((id) => computeReadinessScore(id)));
    avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  res.json({
    upcoming_occasions_count: upcomingCount,
    next_occasion: nextOccasion,
    campaigns_launching_this_week: parseInt(plansThisWeek.rows[0].count, 10),
    high_priority_market_count: highPriorityMarketCount,
    occasions_missing_plans: missingPlansCount,
    average_readiness_score: avgScore,
  });
});

// ── READINESS BOARD ────────────────────────────────────────────────────────

// GET /api/occasion-campaigns/readiness-board
router.get("/occasion-campaigns/readiness-board", async (req, res) => {
  const wreq = workspace(req);
  await seedOccasionsIfEmpty(wreq.workspaceOwnerId);

  const occasions = await db.query<OccasionRow>(
    `SELECT ${OCCASION_SELECT}
       FROM occasion_campaigns
      WHERE workspace_owner_id = $1 AND is_active = true AND status = 'active'
      ORDER BY month ASC NULLS LAST, day ASC NULLS LAST`,
    [wreq.workspaceOwnerId],
  );

  const planCounts = await db.query<{ occasion_id: number; cnt: string }>(
    `SELECT occasion_id, COUNT(*) AS cnt FROM campaign_plans WHERE workspace_owner_id = $1 GROUP BY occasion_id`,
    [wreq.workspaceOwnerId],
  );
  const planCountMap = new Map(planCounts.rows.map((r) => [r.occasion_id, parseInt(r.cnt, 10)]));

  const board = await Promise.all(
    occasions.rows.map(async (occ) => {
      const nextDate = nextOccurrenceDate(occ.month, occ.day);
      const days = daysUntil(nextDate);
      await seedReadinessIfEmpty(wreq.workspaceOwnerId, occ.id);
      const score = await computeReadinessScore(occ.id);
      const planCount = planCountMap.get(occ.id) ?? 0;
      const hasPlan = planCount > 0;
      const column = readinessColumn(score, days, hasPlan);

      // Determine missing critical items
      const missingItems: string[] = [];
      if (!hasPlan) missingItems.push("No campaign plan");
      if (score < 30) missingItems.push("Low readiness score");
      if (days !== null && days <= 14 && score < 60) missingItems.push("At risk — deadline close");

      return {
        id: occ.id,
        name: occ.name,
        type: occ.type,
        priority: occ.priority,
        markets: occ.markets,
        days_until: days,
        next_occurrence: nextDate,
        readiness_score: score,
        readiness_column: column,
        has_plan: hasPlan,
        plan_count: planCount,
        missing_items: missingItems,
      };
    }),
  );

  res.json({ board });
});

// ── INSIGHTS ──────────────────────────────────────────────────────────────

// GET /api/occasion-campaigns/insights
router.get("/occasion-campaigns/insights", async (req, res) => {
  const wreq = workspace(req);
  await seedOccasionsIfEmpty(wreq.workspaceOwnerId);

  const occasions = await db.query<OccasionRow>(
    `SELECT ${OCCASION_SELECT}
       FROM occasion_campaigns
      WHERE workspace_owner_id = $1 AND is_active = true AND status = 'active'`,
    [wreq.workspaceOwnerId],
  );

  const enriched = occasions.rows.map((occ) => {
    const nextDate = nextOccurrenceDate(occ.month, occ.day);
    const days = daysUntil(nextDate);
    return { ...occ, next_occurrence: nextDate, days_until: days };
  });

  const planCounts = await db.query<{ occasion_id: number; cnt: string }>(
    `SELECT occasion_id, COUNT(*) AS cnt FROM campaign_plans WHERE workspace_owner_id = $1 GROUP BY occasion_id`,
    [wreq.workspaceOwnerId],
  );
  const planCountMap = new Map(planCounts.rows.map((r) => [r.occasion_id, parseInt(r.cnt, 10)]));

  // Upcoming critical = high priority in next 45 days
  const upcomingCritical = enriched
    .filter((o) => o.days_until !== null && o.days_until >= 0 && o.days_until <= 45 && o.priority === "high")
    .sort((a, b) => (a.days_until ?? 999) - (b.days_until ?? 999))
    .slice(0, 5);

  // Missing plans = active occasions with no plan
  const missingPlans = enriched
    .filter((o) => (planCountMap.get(o.id) ?? 0) === 0)
    .sort((a, b) => (a.days_until ?? 999) - (b.days_until ?? 999))
    .slice(0, 5);

  // Campaigns launching this week
  const now = new Date();
  const weekAhead = new Date(now);
  weekAhead.setDate(weekAhead.getDate() + 7);
  const todayStr = now.toISOString().split("T")[0];
  const weekStr = weekAhead.toISOString().split("T")[0];

  const plansThisWeek = await db.query<PlanRow>(
    `SELECT ${PLAN_SELECT.replace(/p\./g, "")}
       FROM campaign_plans p
      WHERE workspace_owner_id = $1 AND target_date >= $2 AND target_date <= $3
      ORDER BY target_date ASC`,
    [wreq.workspaceOwnerId, todayStr, weekStr],
  );

  // Average readiness
  let avgScore = 0;
  if (occasions.rows.length > 0) {
    const scores = await Promise.all(occasions.rows.map((o) => computeReadinessScore(o.id)));
    avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }

  // Recommended actions
  const recommendedActions: { title: string; reason: string; urgency: "urgent" | "high" | "medium"; occasion_id?: number; occasion_name?: string }[] = [];

  for (const occ of enriched) {
    const days = occ.days_until;
    const planCount = planCountMap.get(occ.id) ?? 0;
    if (days === null) continue;

    if (days <= 14 && planCount === 0) {
      recommendedActions.push({
        title: `Create campaign plan for ${occ.name}`,
        reason: `${days} days away — no plan exists`,
        urgency: days <= 7 ? "urgent" : "high",
        occasion_id: occ.id,
        occasion_name: occ.name,
      });
    } else if (days <= 30 && days > 14 && planCount === 0) {
      recommendedActions.push({
        title: `Start planning ${occ.name} campaign`,
        reason: `${days} days away — needs a plan`,
        urgency: "high",
        occasion_id: occ.id,
        occasion_name: occ.name,
      });
    } else if (days <= 45 && days > 0 && occ.priority === "high") {
      recommendedActions.push({
        title: `Review ${occ.name} readiness`,
        reason: `High-priority occasion in ${days} days`,
        urgency: "medium",
        occasion_id: occ.id,
        occasion_name: occ.name,
      });
    }
  }

  res.json({
    upcoming_critical: upcomingCritical,
    missing_plans: missingPlans,
    campaigns_this_week: plansThisWeek.rows.map(enrichPlan),
    average_readiness_score: avgScore,
    recommended_actions: recommendedActions.slice(0, 6),
  });
});

// ── Slack digest helper ────────────────────────────────────────────────────

export async function getOccasionDigest(workspaceOwnerId: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const occasions = await db.query<OccasionRow>(
    `SELECT id, name, type, markets, month, day, campaign_start_days_before
       FROM occasion_campaigns
      WHERE workspace_owner_id = $1 AND is_active = true
      ORDER BY month ASC, day ASC`,
    [workspaceOwnerId],
  );

  const upcoming = occasions.rows
    .map((occ) => {
      const nextDate = nextOccurrenceDate(occ.month, occ.day);
      const days = daysUntil(nextDate);
      return { ...occ, next_occurrence: nextDate, days_until: days };
    })
    .filter((occ) => occ.days_until !== null && occ.days_until >= 0 && occ.days_until <= 45)
    .sort((a, b) => (a.days_until ?? 0) - (b.days_until ?? 0));

  if (upcoming.length === 0) return;

  const lines = upcoming.map(
    (occ) => `• *${occ.name}* — ${occ.days_until} days away (${occ.next_occurrence}) — Markets: ${(occ.markets as unknown as string[]).join(", ")}`,
  );

  const body = {
    text: `*Presentail OS — Occasion Campaign Weekly Digest*\n\nUpcoming occasions in the next 45 days:\n${lines.join("\n")}`,
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export default router;

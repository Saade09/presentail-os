import { Router } from "express";
import { z } from "zod/v4";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  TAX_CATEGORIES,
  insertTaxRuleSchema,
  updateTaxRuleSchema,
  selectTaxRuleSchema,
} from "@workspace/db/schema";

// ---------------------------------------------------------------------------
// Query param schemas — derived from selectTaxRuleSchema field shapes,
// adapted for URL query strings where every value arrives as a raw string.
// ---------------------------------------------------------------------------

// selectTaxRuleSchema.shape.taxCategory is z.string() (text column).
// We add the same allowed-values refine used in insertTaxRuleSchema so the
// enum constraint is expressed once in the DB schema and re-used here.
const taxCategoryQueryParam = selectTaxRuleSchema.shape.taxCategory.refine(
  (v) => (TAX_CATEGORIES as readonly string[]).includes(v),
  { message: `tax_category must be one of: ${TAX_CATEGORIES.join(", ")}` },
);

// location_id arrives as a decimal-digit string; we validate the string shape
// before the handler parses it to an integer, mirroring the integer constraint
// on selectTaxRuleSchema.shape.locationId.
const locationIdQueryParam = z
  .string()
  .regex(/^\d+$/, "location_id must be a valid integer");

// Validates both the lexical shape (YYYY-MM-DD) and calendar semantics so
// impossible dates like 2026-99-99 or 2026-02-30 are rejected with a clean
// 400 instead of causing a Postgres cast error downstream.
const dateQueryParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format")
  .refine(
    (v) => {
      const [year, month, day] = v.split("-").map(Number);
      const d = new Date(year, month - 1, day);
      return (
        d.getFullYear() === year &&
        d.getMonth() === month - 1 &&
        d.getDate() === day
      );
    },
    { message: "date must be a valid calendar date in YYYY-MM-DD format" },
  );

/** Validates optional filter params accepted by GET /tax-rules */
const listQuerySchema = z.object({
  country_code: z.string().optional(),
  tax_category: taxCategoryQueryParam.optional(),
  location_id: locationIdQueryParam.optional(),
  active_only: z.string().optional(),
});

/** Validates format/value of params accepted by GET /tax-rules/resolve.
 *  Required-field presence is checked first with the existing imperative guard
 *  so the legacy error message is preserved. */
const resolveQueryFormatSchema = z.object({
  tax_category: taxCategoryQueryParam,
  country_code: z.string(),
  location_id: locationIdQueryParam.optional(),
  date: dateQueryParam.optional(),
});

export { TAX_CATEGORIES };
export type { TaxCategory } from "@workspace/db/schema";

const router = Router();
router.use(requireAuth, resolveWorkspace);

type TaxRuleRow = {
  id: string;
  workspace_owner_id: string;
  country_code: string;
  location_id: number | null;
  location_name: string | null;
  tax_category: string;
  rate_percent: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  description: string | null;
  created_at: string;
};

function isOwner(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceActualRole === "owner";
}

/**
 * GET /api/tax-rules
 * List workspace tax rules. Owner-only.
 * Supports ?country_code=, ?tax_category=, ?location_id=, ?active_only=true
 */
router.get("/tax-rules", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Tax rule management requires owner access" });
    return;
  }

  const queryParsed = listQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({ error: queryParsed.error.issues[0]?.message ?? "Invalid query params" });
    return;
  }

  const conditions: string[] = ["tr.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (req.query.active_only === "true") {
    conditions.push("tr.is_active = true");
    conditions.push("(tr.effective_to IS NULL OR tr.effective_to >= CURRENT_DATE)");
    conditions.push("tr.effective_from <= CURRENT_DATE");
  }
  if (typeof req.query.country_code === "string" && req.query.country_code) {
    params.push(req.query.country_code.trim().toUpperCase());
    conditions.push(`tr.country_code = $${params.length}`);
  }
  if (typeof req.query.tax_category === "string" && req.query.tax_category) {
    params.push(req.query.tax_category.trim());
    conditions.push(`tr.tax_category = $${params.length}`);
  }
  if (typeof req.query.location_id === "string" && req.query.location_id) {
    const locId = parseInt(req.query.location_id, 10);
    if (!isNaN(locId)) {
      params.push(locId);
      conditions.push(`tr.location_id = $${params.length}`);
    }
  }

  const result = await db.query<TaxRuleRow>(
    `SELECT tr.*, l.name AS location_name
       FROM tax_rules tr
       LEFT JOIN locations l ON l.id = tr.location_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY tr.country_code ASC, tr.tax_category ASC, tr.effective_from DESC`,
    params,
  );

  res.json({ tax_rules: result.rows });
});

/**
 * POST /api/tax-rules
 * Create a tax rule. Owner-only.
 */
router.post("/tax-rules", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Tax rule management requires owner access" });
    return;
  }

  const body = req.body ?? {};

  const parsed = insertTaxRuleSchema.safeParse({
    countryCode: body.country_code,
    taxCategory: body.tax_category,
    ratePercent: body.rate_percent,
    locationId: body.location_id ?? null,
    effectiveFrom: body.effective_from,
    effectiveTo: body.effective_to ?? null,
    isActive: body.is_active,
    description: body.description ?? null,
  });

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const {
    countryCode: parsedCountryCode,
    taxCategory,
    ratePercent,
    locationId,
    effectiveFrom,
    effectiveTo,
    description,
  } = parsed.data;

  const countryCode = parsedCountryCode.toUpperCase();

  if (locationId != null) {
    const locCheck = await db.query(
      `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
      [locationId, wreq.workspaceOwnerId],
    );
    if (locCheck.rowCount === 0) {
      res.status(404).json({ error: "Location not found" });
      return;
    }
  }

  const effectiveFromDate = effectiveFrom ? String(effectiveFrom) : new Date().toISOString().slice(0, 10);
  const effectiveToDate = effectiveTo ? String(effectiveTo) : null;

  try {
    const result = await db.query<TaxRuleRow>(
      `INSERT INTO tax_rules
         (workspace_owner_id, country_code, location_id, tax_category, rate_percent, effective_from, effective_to, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *, (SELECT name FROM locations WHERE id = $3) AS location_name`,
      [
        wreq.workspaceOwnerId,
        countryCode,
        locationId,
        taxCategory,
        ratePercent,
        effectiveFromDate,
        effectiveToDate,
        description ? String(description).trim() || null : null,
      ],
    );
    res.status(201).json({ tax_rule: result.rows[0] });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      res.status(409).json({ error: "A tax rule with the same country, location, category, and effective date already exists" });
      return;
    }
    throw err;
  }
});

/**
 * PATCH /api/tax-rules/:id
 * Update a tax rule. Owner-only.
 */
router.patch("/tax-rules/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Tax rule management requires owner access" });
    return;
  }

  const { id } = req.params;

  const existing = await db.query<TaxRuleRow>(
    `SELECT * FROM tax_rules WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Tax rule not found" });
    return;
  }

  const prev = existing.rows[0];
  const body = req.body ?? {};

  const patchInput: Record<string, unknown> = {};
  if ("country_code" in body) patchInput.countryCode = body.country_code;
  if ("tax_category" in body) patchInput.taxCategory = body.tax_category;
  if ("rate_percent" in body) patchInput.ratePercent = body.rate_percent;
  if ("location_id" in body) patchInput.locationId = body.location_id;
  if ("effective_from" in body) patchInput.effectiveFrom = body.effective_from;
  if ("effective_to" in body) patchInput.effectiveTo = body.effective_to;
  if ("is_active" in body) patchInput.isActive = body.is_active;
  if ("description" in body) patchInput.description = body.description;

  const parsed = updateTaxRuleSchema.safeParse(patchInput);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const data = parsed.data;

  const countryCode = "countryCode" in data
    ? String(data.countryCode).toUpperCase()
    : prev.country_code;
  const taxCategory = "taxCategory" in data ? String(data.taxCategory) : prev.tax_category;
  const ratePercent = "ratePercent" in data ? data.ratePercent : prev.rate_percent;
  const locationId = "locationId" in data ? data.locationId : prev.location_id;
  const effectiveFrom = "effectiveFrom" in data ? String(data.effectiveFrom) : prev.effective_from;
  const effectiveTo = "effectiveTo" in data
    ? (data.effectiveTo ? String(data.effectiveTo) : null)
    : prev.effective_to;
  const isActive = "isActive" in data ? Boolean(data.isActive) : prev.is_active;
  const description = "description" in data
    ? (data.description ? String(data.description).trim() || null : null)
    : prev.description;

  try {
    const result = await db.query<TaxRuleRow>(
      `UPDATE tax_rules
          SET country_code = $1, location_id = $2, tax_category = $3, rate_percent = $4,
              effective_from = $5, effective_to = $6, is_active = $7, description = $8
        WHERE id = $9 AND workspace_owner_id = $10
       RETURNING *, (SELECT name FROM locations WHERE id = $2) AS location_name`,
      [countryCode, locationId, taxCategory, ratePercent, effectiveFrom, effectiveTo, isActive, description, id, wreq.workspaceOwnerId],
    );
    res.json({ tax_rule: result.rows[0] });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      res.status(409).json({ error: "A tax rule with the same country, location, category, and effective date already exists" });
      return;
    }
    throw err;
  }
});

/**
 * DELETE /api/tax-rules/:id
 * Delete a tax rule. Owner-only.
 */
router.delete("/tax-rules/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ error: "Tax rule management requires owner access" });
    return;
  }

  const { id } = req.params;

  const result = await db.query(
    `DELETE FROM tax_rules WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Tax rule not found" });
    return;
  }
  res.json({ ok: true });
});

/**
 * GET /api/tax-rules/resolve
 * Resolve the effective tax rate for a given category + country + optional location.
 * Query params: ?tax_category=, ?country_code=, ?location_id=, ?date=
 */
router.get("/tax-rules/resolve", async (req, res) => {
  const wreq = workspace(req);

  const taxCategory = typeof req.query.tax_category === "string" ? req.query.tax_category.trim() : "";
  const countryCode = typeof req.query.country_code === "string" ? req.query.country_code.trim().toUpperCase() : "";
  const locationId = typeof req.query.location_id === "string" ? parseInt(req.query.location_id, 10) : null;
  const asOfDate = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10);

  if (!taxCategory || !countryCode) {
    res.status(400).json({ error: "tax_category and country_code are required" });
    return;
  }

  const resolveQueryParsed = resolveQueryFormatSchema.safeParse(req.query);
  if (!resolveQueryParsed.success) {
    res.status(400).json({ error: resolveQueryParsed.error.issues[0]?.message ?? "Invalid query params" });
    return;
  }

  const result = await db.query<{ rate_percent: string; location_id: number | null }>(
    `SELECT rate_percent, location_id
       FROM tax_rules
      WHERE workspace_owner_id = $1
        AND country_code = $2
        AND tax_category = $3
        AND is_active = true
        AND effective_from <= $4::date
        AND (effective_to IS NULL OR effective_to >= $4::date)
        AND (location_id = $5 OR location_id IS NULL)
      ORDER BY location_id NULLS LAST, effective_from DESC
      LIMIT 1`,
    [wreq.workspaceOwnerId, countryCode, taxCategory, asOfDate, locationId],
  );

  if (result.rowCount === 0) {
    res.json({ rate_percent: null, resolved: false });
    return;
  }

  res.json({ rate_percent: result.rows[0].rate_percent, resolved: true, location_id: result.rows[0].location_id });
});

export default router;

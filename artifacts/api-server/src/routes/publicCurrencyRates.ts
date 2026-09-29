import { Router } from "express";
import { db } from "../lib/db";

const router = Router();

/**
 * GET /api/public/currency-rates?workspace={ownerId}
 * Public, unauthenticated. Returns the workspace's base currency, configured
 * markup percentage, rounding rule, and all stored exchange rates.
 *
 * Errors:
 *   400 — workspace query parameter is missing
 *   404 — workspace owner not found
 *   503 — no exchange rates have been stored yet
 */
router.get("/public/currency-rates", async (req, res) => {
  const workspaceParam =
    typeof req.query.workspace === "string" ? req.query.workspace.trim() : "";

  if (!workspaceParam) {
    res.status(400).json({ error: "workspace query parameter is required" });
    return;
  }

  // Schema sentinel: reads workspace_members.member_user_id (aliased → user_id)
  // to verify the workspace owner exists. If that column is renamed in a migration
  // you MUST update both this query and the mocks in publicCurrencyRates.test.ts.
  const ownerCheck = await db.query<{ user_id: string }>(
    `SELECT member_user_id AS user_id FROM workspace_members WHERE member_user_id = $1 AND role = 'owner' LIMIT 1`,
    [workspaceParam],
  );

  if (ownerCheck.rowCount === 0) {
    res.status(404).json({ error: "workspace not found" });
    return;
  }

  const settingsResult = await db.query<{
    base_currency: string;
    default_markup_percentage: string;
    rounding_rule: string;
    updated_at: string | null;
  }>(
    `SELECT base_currency, default_markup_percentage, rounding_rule, updated_at
       FROM exchange_rate_settings
      WHERE workspace_owner_id = $1`,
    [workspaceParam],
  );

  const settings = settingsResult.rows[0];
  const baseCurrency = settings?.base_currency ?? "USD";
  const markupPercentage = settings ? parseFloat(settings.default_markup_percentage) : 0;
  const roundingRule = settings?.rounding_rule ?? "round_up_whole";

  const ratesResult = await db.query<{
    target_currency: string;
    rate: string;
    fetched_at: string;
  }>(
    `SELECT target_currency, rate::float AS rate, fetched_at
       FROM exchange_rates
      WHERE workspace_owner_id = '__global__'
        AND base_currency = $1
      ORDER BY target_currency`,
    [baseCurrency],
  );

  if (ratesResult.rows.length === 0) {
    res.status(503).json({ error: "exchange rates have not been configured yet" });
    return;
  }

  const lastUpdatedAt = ratesResult.rows[0].fetched_at;

  res.json({
    base_currency: baseCurrency,
    default_markup_percentage: markupPercentage,
    rounding_rule: roundingRule,
    last_updated_at: lastUpdatedAt,
    available_currencies: ratesResult.rows.map((r) => r.target_currency),
    rates: ratesResult.rows.map((r) => ({
      currency: r.target_currency,
      rate: parseFloat(r.rate),
      fetched_at: r.fetched_at,
    })),
  });
});

export default router;

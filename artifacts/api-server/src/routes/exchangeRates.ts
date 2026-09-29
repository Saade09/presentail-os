import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  fetchAndStoreExchangeRates,
  getStoredRate,
  applyRounding,
  type RoundingRule,
} from "../lib/exchangeRateService";
import {
  fireCurrencyRatesWebhook,
  fireDeliveryConfigWebhook,
} from "../lib/catalogWebhook";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const VALID_BASE_CURRENCIES = [
  "USD", "AED", "SAR", "QAR", "KWD", "BHD", "OMR", "EUR", "GBP",
];

/**
 * GET /api/exchange-rates
 * Returns stored rates for the workspace's configured base currency.
 */
router.get("/exchange-rates", async (req, res) => {
  const wreq = workspace(req);

  const settingsResult = await db.query<{ base_currency: string }>(
    `SELECT base_currency FROM exchange_rate_settings WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  const baseCurrency = settingsResult.rows[0]?.base_currency ?? "USD";

  const result = await db.query<{
    base_currency: string;
    target_currency: string;
    rate: string;
    fetched_at: string;
    provider: string | null;
  }>(
    `SELECT base_currency, target_currency, rate::float AS rate, fetched_at, provider
       FROM exchange_rates
      WHERE workspace_owner_id = '__global__'
        AND base_currency = $1
      ORDER BY target_currency`,
    [baseCurrency],
  );

  // last_fetched_at excludes manual rows so it reflects the latest provider fetch
  const providerRow = result.rows.find((r) => r.provider !== "manual");
  const lastFetched = providerRow?.fetched_at ?? result.rows[0]?.fetched_at ?? null;

  res.json({
    base_currency: baseCurrency,
    rates: result.rows.map((r) => ({
      base_currency: r.base_currency,
      target_currency: r.target_currency,
      rate: parseFloat(r.rate),
      fetched_at: r.fetched_at,
      provider: r.provider ?? "exchangerate-api.com",
    })),
    last_fetched_at: lastFetched,
  });
});

/**
 * POST /api/exchange-rates/manual
 * Upserts a manual exchange rate (owner-only).
 * Body: { currency: string, rate: number } where rate = units of currency per 1 USD.
 * Stored as base=USD, target=currency, rate=1/rate (USD per unit), provider='manual'.
 */
router.post("/exchange-rates/manual", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const { currency, rate } = req.body ?? {};
  if (!currency || typeof currency !== "string" || currency.trim() === "") {
    res.status(400).json({ error: "currency is required" });
    return;
  }
  const rateNum = Number(rate);
  if (!Number.isFinite(rateNum) || rateNum <= 0) {
    res.status(400).json({ error: "rate must be a positive number" });
    return;
  }

  const target = currency.trim().toUpperCase();
  // Rate is stored as USD-per-target so that getStoredRate(target, 'USD') returns
  // the correct value via the inverse lookup path.
  const storedRate = 1 / rateNum;
  const fetchedAt = new Date().toISOString();

  await db.query(
    `INSERT INTO exchange_rates
       (workspace_owner_id, base_currency, target_currency, rate, provider, fetched_at)
     VALUES ('__global__', 'USD', $1, $2, 'manual', $3)
     ON CONFLICT (workspace_owner_id, base_currency, target_currency)
     DO UPDATE SET rate = EXCLUDED.rate, provider = 'manual', fetched_at = EXCLUDED.fetched_at`,
    [target, storedRate, fetchedAt],
  );

  res.json({ currency: target, rate: rateNum, stored_rate: storedRate, provider: "manual" });
});

/**
 * DELETE /api/exchange-rates/manual/:currency
 * Removes a manual rate row for the given target currency (owner-only).
 */
router.delete("/exchange-rates/manual/:currency", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const target = req.params.currency.toUpperCase();

  const result = await db.query(
    `DELETE FROM exchange_rates
      WHERE workspace_owner_id = '__global__'
        AND base_currency = 'USD'
        AND target_currency = $1
        AND provider = 'manual'`,
    [target],
  );

  const deleted = (result as unknown as { rowCount: number }).rowCount ?? 0;
  if (!deleted) {
    res.status(404).json({ error: "No manual rate found for that currency" });
    return;
  }

  res.json({ deleted: true, currency: target });
});

/**
 * POST /api/exchange-rates/refresh
 * Triggers an immediate rate fetch (admin only). Returns updated rates and timestamp.
 */
router.post("/exchange-rates/refresh", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const settingsResult = await db.query<{ base_currency: string }>(
    `SELECT base_currency FROM exchange_rate_settings WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  const baseCurrency = settingsResult.rows[0]?.base_currency ?? "USD";

  try {
    const result = await fetchAndStoreExchangeRates("__global__", baseCurrency);
    fireCurrencyRatesWebhook(wreq.workspaceOwnerId, {
      base_currency: baseCurrency,
      last_updated_at: result.fetched_at,
      updated_fields: ["rates"],
    }).catch(() => {});
    void fireDeliveryConfigWebhook("exchange_rate.updated", wreq.workspaceOwnerId, {
      base_currency: baseCurrency,
      last_updated_at: result.fetched_at,
      rates: result.rates,
    });
    void fireDeliveryConfigWebhook("fx.rates.updated", wreq.workspaceOwnerId, {
      base_currency: baseCurrency,
      last_updated_at: result.fetched_at,
      rates: result.rates,
    });
    res.json({
      base_currency: baseCurrency,
      rates: result.rates,
      last_fetched_at: result.fetched_at,
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to refresh exchange rates. Please try again." });
  }
});

/**
 * GET /api/exchange-rates/convert
 * Accepts ?amount, ?from, ?to query params.
 * Looks up stored rate (with cross-rate support for any base), applies settings markup and rounding,
 * returns full conversion breakdown JSON.
 */
router.get("/exchange-rates/convert", async (req, res) => {
  const wreq = workspace(req);
  const amountStr = String(req.query.amount ?? "");
  const from = String(req.query.from ?? "").toUpperCase();
  const to = String(req.query.to ?? "").toUpperCase();

  if (!amountStr || !from || !to) {
    res.status(400).json({ error: "amount, from, and to are required" });
    return;
  }

  const amount = parseFloat(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const settingsResult = await db.query<{
    default_markup_percentage: string;
    rounding_rule: string;
    base_currency: string;
  }>(
    `SELECT default_markup_percentage, rounding_rule, base_currency
       FROM exchange_rate_settings
      WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );

  const markupPct = settingsResult.rows[0]
    ? parseFloat(settingsResult.rows[0].default_markup_percentage)
    : 0;
  const roundingRule = (settingsResult.rows[0]?.rounding_rule ?? "round_up_whole") as RoundingRule;

  const rateRow = await getStoredRate(from, to, "__global__");

  if (!rateRow) {
    res.status(404).json({ error: `Rate not available for this pair: ${from} → ${to}` });
    return;
  }

  const officialRate = rateRow.rate;
  const markupMultiplier = 1 + markupPct / 100;
  const effectiveRate = officialRate * markupMultiplier;
  const convertedExact = amount * effectiveRate;
  const finalAmount = applyRounding(convertedExact, roundingRule);

  res.json({
    from_currency: from,
    to_currency: to,
    source_amount: amount,
    official_rate: officialRate,
    markup_percentage: markupPct,
    effective_rate: effectiveRate,
    converted_amount_exact: convertedExact,
    final_amount: finalAmount,
    rounding_rule: roundingRule,
    rate_fetched_at: rateRow.fetched_at,
  });
});

/**
 * GET /api/exchange-rate-settings
 * Returns the workspace exchange rate settings row.
 */
router.get("/exchange-rate-settings", async (req, res) => {
  const wreq = workspace(req);
  const result = await db.query<{
    default_markup_percentage: string;
    rounding_rule: string;
    base_currency: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT default_markup_percentage, rounding_rule, base_currency, created_at, updated_at
       FROM exchange_rate_settings
      WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );

  if (result.rows.length === 0) {
    res.json({
      default_markup_percentage: 0,
      rounding_rule: "round_up_whole",
      base_currency: "USD",
      created_at: null,
      updated_at: null,
    });
    return;
  }

  const row = result.rows[0];
  res.json({
    default_markup_percentage: parseFloat(row.default_markup_percentage),
    rounding_rule: row.rounding_rule,
    base_currency: row.base_currency,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

/**
 * PATCH /api/exchange-rate-settings
 * Updates default_markup_percentage, rounding_rule, and base_currency (admin only).
 */
router.patch("/exchange-rate-settings", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const body = req.body ?? {};
  const { default_markup_percentage, rounding_rule, base_currency } = body;

  if (default_markup_percentage !== undefined) {
    const markup = Number(default_markup_percentage);
    if (!Number.isFinite(markup) || markup < 0 || markup > 100) {
      res.status(400).json({ error: "default_markup_percentage must be between 0 and 100" });
      return;
    }
  }

  const validRoundingRules = ["round_up_whole", "round_nearest_whole", "none"];
  if (rounding_rule !== undefined && !validRoundingRules.includes(rounding_rule)) {
    res.status(400).json({ error: `rounding_rule must be one of: ${validRoundingRules.join(", ")}` });
    return;
  }

  if (base_currency !== undefined && !VALID_BASE_CURRENCIES.includes(String(base_currency).toUpperCase())) {
    res.status(400).json({ error: `base_currency must be one of: ${VALID_BASE_CURRENCIES.join(", ")}` });
    return;
  }

  await db.query(
    `INSERT INTO exchange_rate_settings
       (workspace_owner_id, default_markup_percentage, rounding_rule, base_currency, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (workspace_owner_id) DO UPDATE
       SET default_markup_percentage = COALESCE(EXCLUDED.default_markup_percentage, exchange_rate_settings.default_markup_percentage),
           rounding_rule = COALESCE(EXCLUDED.rounding_rule, exchange_rate_settings.rounding_rule),
           base_currency = COALESCE(EXCLUDED.base_currency, exchange_rate_settings.base_currency),
           updated_at = now()`,
    [
      wreq.workspaceOwnerId,
      default_markup_percentage ?? null,
      rounding_rule ?? null,
      base_currency ? String(base_currency).toUpperCase() : null,
    ],
  );

  const result = await db.query<{
    default_markup_percentage: string;
    rounding_rule: string;
    base_currency: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT default_markup_percentage, rounding_rule, base_currency, created_at, updated_at
       FROM exchange_rate_settings
      WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );

  const row = result.rows[0];

  const updatedFields: string[] = [];
  if (default_markup_percentage !== undefined) updatedFields.push("default_markup_percentage");
  if (rounding_rule !== undefined) updatedFields.push("rounding_rule");
  if (base_currency !== undefined) updatedFields.push("base_currency");

  fireCurrencyRatesWebhook(wreq.workspaceOwnerId, {
    base_currency: row.base_currency,
    last_updated_at: row.updated_at ?? new Date().toISOString(),
    updated_fields: updatedFields,
  }).catch(() => {});
  // Fetch current rates to include in the delivery webhook payload.
  const currentRatesResult = await db.query<{ target_currency: string; rate: string; fetched_at: string }>(
    `SELECT target_currency, rate::float AS rate, fetched_at
       FROM exchange_rates
      WHERE workspace_owner_id = '__global__'
        AND base_currency = $1
      ORDER BY target_currency`,
    [row.base_currency],
  );
  const mappedRates = currentRatesResult.rows.map((r) => ({
    target_currency: r.target_currency,
    rate: parseFloat(r.rate),
    fetched_at: r.fetched_at,
  }));
  void fireDeliveryConfigWebhook("exchange_rate.updated", wreq.workspaceOwnerId, {
    base_currency: row.base_currency,
    updated_fields: updatedFields,
    rates: mappedRates,
  });
  void fireDeliveryConfigWebhook("fx.rates.updated", wreq.workspaceOwnerId, {
    base_currency: row.base_currency,
    updated_fields: updatedFields,
    rates: mappedRates,
  });

  res.json({
    default_markup_percentage: parseFloat(row.default_markup_percentage),
    rounding_rule: row.rounding_rule,
    base_currency: row.base_currency,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

export default router;

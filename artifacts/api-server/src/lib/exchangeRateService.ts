import { db } from "./db";
import { logger } from "./logger";

export type ExchangeRateRow = {
  base_currency: string;
  target_currency: string;
  rate: number;
  fetched_at: string;
};

export type FetchedRates = {
  rates: ExchangeRateRow[];
  fetched_at: string;
};

type StoredRateRow = {
  rate: string;
  fetched_at: string;
  provider: string;
};

/**
 * LBP is currently roughly 89,500 per USD. These deliberately broad limits
 * allow owner overrides while rejecting a reversed/malformed rate that would
 * turn a few million LBP into millions or billions of USD.
 */
const LBP_PER_USD_MIN = 10_000;
const LBP_PER_USD_MAX = 1_000_000;

function isPlausibleNormalizedRate(from: string, to: string, rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (from === "LBP" && to === "USD") {
    return rate >= 1 / LBP_PER_USD_MAX && rate <= 1 / LBP_PER_USD_MIN;
  }
  if (from === "USD" && to === "LBP") {
    return rate >= LBP_PER_USD_MIN && rate <= LBP_PER_USD_MAX;
  }
  return true;
}

function normalizeStoredRate(row: StoredRateRow, inverse: boolean): number | null {
  const raw = Number.parseFloat(row.rate);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  // Manual rows store base units per target unit, opposite to provider rows.
  if (row.provider === "manual") {
    return inverse ? raw : 1 / raw;
  }
  return inverse ? 1 / raw : raw;
}

/**
 * Fetch current exchange rates from exchangerate-api.com (or fallback).
 * Stores results in the exchange_rates table per workspace.
 * On failure, logs the error and returns last stored rates.
 * @param workspaceOwnerId  Workspace to store rates for (defaults to '__global__').
 * @param baseCurrency      The base currency to request from the API (defaults to 'USD').
 */
export async function fetchAndStoreExchangeRates(
  workspaceOwnerId?: string,
  baseCurrency = "USD",
): Promise<FetchedRates> {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  const base = baseCurrency.toUpperCase();
  const fetchedAt = new Date().toISOString();

  let freshRates: Record<string, number> | null = null;

  if (apiKey) {
    try {
      const url = `https://v6.exchangerate-api.com/v6/${apiKey}/latest/${base}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        const data = await resp.json() as {
          result?: string;
          conversion_rates?: Record<string, number>;
          rates?: Record<string, number>;
        };
        freshRates = data.conversion_rates ?? data.rates ?? null;
        if (freshRates) {
          logger.info({ base }, "Exchange rates fetched successfully");
        }
      } else {
        logger.warn({ status: resp.status }, "Exchange rate API returned non-OK status");
      }
    } catch (err) {
      logger.warn({ err }, "Exchange rate fetch failed — will use last stored rates");
    }
  } else {
    logger.warn("EXCHANGE_RATE_API_KEY not set — exchange rate refresh skipped");
  }

  const ownerCondition = workspaceOwnerId ?? "__global__";

  if (freshRates) {
    // Clear old rates for this workspace+base so stale pairs don't linger.
    // Preserve manual rates — they are never overwritten by the provider fetch.
    await db.query(
      `DELETE FROM exchange_rates WHERE workspace_owner_id = $1 AND base_currency = $2 AND provider != 'manual'`,
      [ownerCondition, base],
    );

    for (const [targetCurrency, rate] of Object.entries(freshRates)) {
      if (targetCurrency === base) continue;
      await db.query(
        `INSERT INTO exchange_rates
           (workspace_owner_id, base_currency, target_currency, rate, provider, fetched_at)
         VALUES ($1, $2, $3, $4, 'exchangerate-api.com', $5)
         ON CONFLICT (workspace_owner_id, base_currency, target_currency)
         DO UPDATE SET rate = EXCLUDED.rate, fetched_at = EXCLUDED.fetched_at
         WHERE exchange_rates.provider != 'manual'`,
        [ownerCondition, base, targetCurrency, rate, fetchedAt],
      );
    }
  }

  const stored = await db.query<ExchangeRateRow>(
    `SELECT base_currency, target_currency, rate::float AS rate, fetched_at
       FROM exchange_rates
      WHERE workspace_owner_id = $1
        AND base_currency = $2
      ORDER BY target_currency`,
    [ownerCondition, base],
  );

  return {
    rates: stored.rows,
    fetched_at: stored.rows[0]?.fetched_at ?? fetchedAt,
  };
}

/**
 * Get stored exchange rate for a given pair.
 * Tries direct lookup first, then inverse, then cross-rate through any shared base.
 * Returns null when no rate is stored yet.
 */
export async function getStoredRate(
  from: string,
  to: string,
  workspaceOwnerId?: string,
): Promise<{ rate: number; fetched_at: string } | null> {
  const ownerCondition = workspaceOwnerId ?? "__global__";
  from = from.toUpperCase();
  to = to.toUpperCase();

  if (from === to) {
    return { rate: 1, fetched_at: new Date().toISOString() };
  }

  // 1. Direct rate: stored as base=from, target=to
  const direct = await db.query<StoredRateRow>(
    `SELECT rate::float AS rate, fetched_at, provider
       FROM exchange_rates
      WHERE workspace_owner_id = $1
        AND base_currency = $2
        AND target_currency = $3
      LIMIT 1`,
    [ownerCondition, from, to],
  );
  if (direct.rows.length > 0) {
    const row = direct.rows[0];
    const rate = normalizeStoredRate(row, false);
    if (rate !== null && isPlausibleNormalizedRate(from, to, rate)) {
      return { rate, fetched_at: row.fetched_at };
    }
  }

  // 2. Inverse rate: stored as base=to, target=from — invert it
  const inverse = await db.query<StoredRateRow>(
    `SELECT rate::float AS rate, fetched_at, provider
       FROM exchange_rates
      WHERE workspace_owner_id = $1
        AND base_currency = $2
        AND target_currency = $3
      LIMIT 1`,
    [ownerCondition, to, from],
  );
  if (inverse.rows.length > 0) {
    const row = inverse.rows[0];
    const rate = normalizeStoredRate(row, true);
    if (rate !== null && isPlausibleNormalizedRate(from, to, rate)) {
      return { rate, fetched_at: row.fetched_at };
    }
  }

  // 3. Cross-rate through any shared base B:
  //    find B where (base=B, target=from) and (base=B, target=to) both exist.
  const cross = await db.query<{
    from_rate: string;
    from_provider: string;
    to_rate: string;
    to_provider: string;
    fetched_at: string;
  }>(
    `SELECT
       f.rate::float AS from_rate,
       f.provider AS from_provider,
       t.rate::float AS to_rate,
       t.provider AS to_provider,
       GREATEST(f.fetched_at, t.fetched_at) AS fetched_at
     FROM exchange_rates f
     JOIN exchange_rates t
       ON t.workspace_owner_id = f.workspace_owner_id
      AND t.base_currency = f.base_currency
      AND t.target_currency = $3
     WHERE f.workspace_owner_id = $1
       AND f.target_currency = $2
     LIMIT 1`,
    [ownerCondition, from, to],
  );

  if (cross.rows.length === 0) return null;
  const row = cross.rows[0];
  const rawFromRate = parseFloat(row.from_rate);
  const rawToRate = parseFloat(row.to_rate);
  const fromRate = row.from_provider === "manual" ? 1 / rawFromRate : rawFromRate;
  const toRate = row.to_provider === "manual" ? 1 / rawToRate : rawToRate;
  if (!Number.isFinite(fromRate) || fromRate <= 0) return null;
  const rate = toRate / fromRate;
  if (!isPlausibleNormalizedRate(from, to, rate)) return null;
  return { rate, fetched_at: row.fetched_at };
}

export type RoundingRule = "round_up_whole" | "round_nearest_whole" | "none";

export function applyRounding(amount: number, rule: RoundingRule): number {
  switch (rule) {
    case "round_up_whole":
      return Math.ceil(amount);
    case "round_nearest_whole":
      return Math.round(amount);
    case "none":
    default:
      return amount;
  }
}

export function roundingRuleLabel(rule: RoundingRule): string {
  switch (rule) {
    case "round_up_whole": return "Rounded up";
    case "round_nearest_whole": return "Rounded to nearest";
    case "none": return "No rounding";
  }
}

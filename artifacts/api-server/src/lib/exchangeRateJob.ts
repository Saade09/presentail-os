import { db } from "./db";
import { fetchAndStoreExchangeRates } from "./exchangeRateService";
import { logger } from "./logger";
import { fireCurrencyRatesWebhookAllWorkspaces, fireDeliveryConfigWebhookAllWorkspaces } from "./catalogWebhook";

const INITIAL_DELAY_MS = 60_000;
const RUN_HOUR_UTC = 6;
const FAILURE_ALERT_THRESHOLD = 3;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

let consecutiveFailures = 0;

function getNextRunMs(): number {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();

  const minutesToday = utcH * 60 + utcM;
  const runAt = RUN_HOUR_UTC * 60;

  const minutesUntilNext =
    minutesToday < runAt
      ? runAt - minutesToday
      : 24 * 60 - minutesToday + runAt;

  return minutesUntilNext * 60 * 1000;
}

async function tick(): Promise<void> {
  try {
    logger.info("Exchange rate job: starting fetch");
    const result = await fetchAndStoreExchangeRates("__global__");
    if (consecutiveFailures > 0) {
      logger.info(
        { previousFailures: consecutiveFailures },
        "Exchange rate job: fetch recovered after consecutive failures",
      );
    }
    consecutiveFailures = 0;
    logger.info("Exchange rate job: fetch complete");
    fireCurrencyRatesWebhookAllWorkspaces({
      base_currency: result.rates[0]?.base_currency ?? "USD",
      last_updated_at: result.fetched_at,
      updated_fields: ["rates"],
    }).catch((err) => {
      logger.warn({ err }, "Exchange rate job: error firing currency_rates.updated webhooks");
    });
    fireDeliveryConfigWebhookAllWorkspaces("exchange_rate.updated", {
      base_currency: result.rates[0]?.base_currency ?? "USD",
      last_updated_at: result.fetched_at,
      rates: result.rates,
    }).catch((err) => {
      logger.warn({ err }, "Exchange rate job: error firing exchange_rate.updated webhooks");
    });
    fireDeliveryConfigWebhookAllWorkspaces("fx.rates.updated", {
      base_currency: result.rates[0]?.base_currency ?? "USD",
      last_updated_at: result.fetched_at,
      rates: result.rates,
    }).catch((err) => {
      logger.warn({ err }, "Exchange rate job: error firing fx.rates.updated webhooks");
    });
  } catch (err) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
      logger.error(
        { err, consecutiveFailures },
        "Exchange rate job: fetch has failed consecutively — rates may be outdated",
      );
    } else {
      logger.warn(
        { err, consecutiveFailures },
        "Exchange rate job: fetch error (last known rates preserved)",
      );
    }
  }
}

function scheduleNext(): void {
  const ms = getNextRunMs();
  const nextRun = new Date(Date.now() + ms);
  logger.info({ nextRun: nextRun.toISOString() }, "Exchange rate job: next scheduled run");
  setTimeout(async () => {
    await tick();
    scheduleNext();
  }, ms);
}

export async function checkStaleExchangeRates(): Promise<void> {
  try {
    const result = await db.query<{ fetched_at: string }>(
      `SELECT fetched_at FROM exchange_rates ORDER BY fetched_at DESC LIMIT 1`,
    );

    if (result.rows.length === 0) {
      logger.error(
        "Exchange rate startup check: no rates found in the database — rates have never been fetched",
      );
      return;
    }

    const fetchedAt = new Date(result.rows[0].fetched_at);
    const ageMs = Date.now() - fetchedAt.getTime();

    if (ageMs > STALE_THRESHOLD_MS) {
      const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
      logger.error(
        { fetchedAt: fetchedAt.toISOString(), ageHours },
        "Exchange rate startup check: stored rates are older than 24 hours — rates may be outdated",
      );
    } else {
      logger.info(
        { fetchedAt: fetchedAt.toISOString() },
        "Exchange rate startup check: rates are fresh",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Exchange rate startup check: failed to query rates age");
  }
}

export function startExchangeRateJob(): void {
  setTimeout(async () => {
    await tick();
    scheduleNext();
  }, INITIAL_DELAY_MS);

  logger.info("Exchange rate background job started (runs daily at 06:00 UTC, first run in 60s)");
}
